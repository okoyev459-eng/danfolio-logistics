# Notifications + Rider Presence — Backend Integration Guide (Theo)

**Status:** backend live after this branch is applied. Your files were **not**
touched. Nothing below is required for rides/payments to keep working —
notifications are additive; if you integrate nothing, the app behaves exactly
as today (minus in-app toasts).

---

## 1. What the backend gives you

| Piece | Where | Notes |
|---|---|---|
| `notifications` table | PostgREST + **Realtime** | one row per event, `dedupe_key` unique, server-written only |
| `push_subscriptions` table | PostgREST | your user's own rows only (RLS) |
| `keke_heartbeat(lat?, lng?)` RPC | PostgREST | server-stamped `last_seen` (client can't backdate) |
| `keke_set_presence(status)` RPC | PostgREST | `online` \| `offline` \| `unavailable`, own row only |
| `notify-tick` Edge Function | pg_cron, every 15s | delivers Web Push + expires stale riders (you don't call it) |

Notification types you can switch on:

- **Student:** `ride_accepted`, `ride_arrived`, `ride_cancelled`, `refund_initiated`, `refund_completed`, `refund_failed`
- **Rider (keke):** `new_ride_request`, `ride_paid`, `student_cancelled`

Every row has `{ id, user_id, user_role, type, title, body, ride_id, data, read_at, created_at }`.

---

## 2. In-app notifications (Realtime — recommended first step)

```js
// after supabase client init
const channel = supabase
  .channel('notifications')
  .on(
    'postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'notifications',
      filter: `user_id=eq.${userId}` },
    (payload) => showToast(payload.new),   // { type, title, body, ride_id, data }
  )
  .subscribe()
```

Mark as read:

```js
await supabase.from('notifications').update({ read_at: new Date().toISOString() })
  .eq('id', notificationId)   // RLS: only your own rows, only read_at
```

---

## 3. Web Push (service worker + VAPID)

The backend **stores subscriptions and sends pushes**. The service worker +
`pushManager.subscribe` are frontend-side (your domain):

```js
// 1. Get the VAPID public key from your env (VITE_VAPID_PUBLIC_KEY —
//    set it in Vercel; the private key never leaves Supabase).
// 2. Register your SW (public/sw.js) and subscribe:
const reg = await navigator.serviceWorker.register('/sw.js')
const sub = await reg.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: urlBase64ToUint8Array(VITE_VAPID_PUBLIC_KEY),
})
// 3. Persist it (upsert = re-subscribe after key rotation is safe):
await supabase.from('push_subscriptions').upsert({
  endpoint: sub.endpoint,
  p256dh: sub.toJSON().keys.p256dh,
  auth: sub.toJSON().keys.auth,
}, { onConflict: 'endpoint' })
```

`sw.js` handler:

```js
self.addEventListener('push', (e) => {
  const { title, body, data } = e.data.json()
  e.waitUntil(self.registration.showNotification(title, {
    body, data,                       // tap → navigate to /ride/{ride_id}
    icon: '/icon.png',
  }))
})
```

Ask permission **after** a user gesture, not on page load.

---

## 4. Rider presence (Home.jsx migration — when convenient)

Today Home.jsx heartbeats every 20s with a direct `kekes` UPDATE. That still
works (the column grant is untouched), but the server-stamped RPC is
strictly better and is what the 45s expiry is tuned for:

```js
// heartbeat — replace the .from('kekes').update(...) block:
const { data } = await supabase.rpc('keke_heartbeat', { p_lat: lat, p_lng: lng })
// data = { ok, status, last_seen }  (ok:false + 'not_on_duty' if offline)

// go online / offline / unavailable — replace the toggle's status write:
await supabase.rpc('keke_set_presence', { p_status: nextOnline ? 'online' : 'offline' })
```

**Add these two hooks (important):**

```js
// background / tab hidden → stop being offerable immediately:
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && online && !onTrip)
    supabase.rpc('keke_set_presence', { p_status: 'offline' })
})
// logout → offline before the session dies:
await supabase.rpc('keke_set_presence', { p_status: 'offline' })
await supabase.auth.signOut()
```

Timing model (all server-side, no client timers involved):

| Event | Rule |
|---|---|
| Heartbeat | every **15s** foreground (20s also fine — both < 45s) |
| Offline expiry | `last_seen` older than **45s** → `notify-tick` flips `online → offline` (only ever `online`, never `on_trip`) |
| Dispatch | already ignores riders not seen in **75s** (unchanged) |
| Background/logout | call `keke_set_presence('offline')` (above) |

Offline riders get **no** `new_ride_request` notifications — dispatch never
offers to them in the first place, and their pending offers stop at the next
tick.

---

## 5. What you do NOT need to do

- No service-role key anywhere in the frontend (RLS handles everything).
- No webhook / function calls for notifications — DB triggers create them on
  confirmed events only.
- No changes to booking, payment, cancel or refund flows.
- Don't write `notifications` or `push_deliveries` directly (no client grant).

## 6. Secrets (names only — all server-side)

| Name | Set where | Purpose |
|---|---|---|
| `NOTIFY_TICK_SECRET` | Edge Function env + Vault `notify-tick-secret` | cron → notify-tick auth |
| `VAPID_PUBLIC_KEY` | Function env **+** `VITE_VAPID_PUBLIC_KEY` in Vercel (public by design) | push subscription |
| `VAPID_PRIVATE_KEY` | Function env only | signing pushes |
| `VAPID_SUBJECT` | Function env | `mailto:` contact for VAPID |

One-time cron setup SQL: `supabase/config.toml` → `[functions.notify-tick]`.
