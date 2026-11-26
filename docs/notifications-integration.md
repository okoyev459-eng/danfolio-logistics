# Notifications + Rider Presence — Integration Guide (Theo)

**Status:** backend AND frontend are live on this branch. The frontend push
wiring (service worker, manifest, subscription, bridge, presence hooks) was
added here so notifications work end-to-end without you having to build it —
the files touched are listed in §7 for your review. Nothing below is required
for rides/payments to keep working — notifications are additive; the app
behaves exactly as before plus toasts and push.

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

## 3. Web Push (service worker + VAPID) — DONE on this branch

The backend **stores subscriptions and sends pushes**. The frontend half is
already wired on this branch — no integration needed:

| Piece | File | What it does |
|---|---|---|
| Service worker | `public/sw.js` | displays pushes, routes taps by `user_role` (`/keke`, `/student/ride/:id`, `/admin`), focuses an existing window |
| Manifest | `public/manifest.json` + link in `index.html` | Android Chrome requires an installed web app for Web Push |
| Subscription manager | `src/lib/push.js` | registers the SW, subscribes with `VITE_VAPID_PUBLIC_KEY`, upserts on `endpoint`, rolls back on failed save |
| Bridge | `src/components/NotificationBridge.jsx` (mounted in `App.jsx`) | silent re-sync on login, realtime in-app toasts (visual only), opt-in pill, turn-off control |
| SW registration | `src/main.jsx` | registers `/sw.js` on startup (silent — permission only ever requested from the Enable tap) |

If you rebuild any of this: permission must only be requested from a user
gesture, the toast layer must never call `new Notification()` (the SW is the
single source of system alerts — otherwise everything double-pops), and the
VAPID **private** key must never appear in frontend code (covered by
`tests/push-client.test.js`).

---

## 4. Rider presence — DONE on this branch

`src/pages/keke/Home.jsx` now uses the server-stamped RPCs (the legacy
direct write is kept as fallback, and the column grant is untouched):

- **Heartbeat:** every **15s** via `keke_heartbeat(lat?, lng?)` — falls back
  to the old `kekes` UPDATE if the RPC is unavailable.
- **Background → offline:** `visibilitychange` (hidden) and `pagehide` call
  `keke_set_presence('offline')`, guarded by `online && !onTrip` — never
  `on_trip`, never another rider's row. `queue_joined_at` is kept, so a
  quick app switch does not cost the queue spot; returning within **30s**
  resumes seamlessly, longer shows an explicit "tap Go online" notice
  (never silently back online while the user was away).
- **Logout → offline:** `handleSignOut` flips `online` rows offline
  (best-effort) before the session dies.

Timing model (all server-side, no client timers involved):

| Event | Rule |
|---|---|
| Heartbeat | every **15s** foreground (both paths < 45s) |
| Offline expiry | `last_seen` older than **45s** → `notify-tick` flips `online → offline` (only ever `online`, never `on_trip`) |
| Dispatch | already ignores riders not seen in **75s** (unchanged) |
| Background/logout | `keke_set_presence('offline')` (wired in Home.jsx) |

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

## 7. Files touched on this branch (for your review)

**New (all notification-owned):**

| File | Role |
|---|---|
| `supabase/migrations/20261124170000_notifications.sql` | tables, RLS, 3 triggers, presence RPCs (applied to live DB) |
| `supabase/functions/notify-tick/index.ts` | 45s sweep + Web Push delivery (pg_cron @15s) |
| `public/sw.js` | displays pushes, tap routing |
| `public/manifest.json` | installability (Android Chrome push) |
| `src/lib/push.js` | subscription manager |
| `src/components/NotificationBridge.jsx` + `notification-bridge.css` | toasts, opt-in pill, turn-off |
| `tests/notifications.test.js`, `tests/push-client.test.js` | drift tests (241 pass) |
| `docs/notifications-integration.md` | this file |

**Existing files edited (surgical, additive only):**

| File | Change |
|---|---|
| `src/App.jsx` | mounts `<NotificationBridge />` (renders nothing without a session) |
| `src/main.jsx` | registers `/sw.js` (silent, non-fatal on failure) |
| `index.html` | one `<link rel="manifest">` |
| `src/pages/keke/Home.jsx` | RPC-first heartbeat (15s), background/logout offline hooks, `handleSignOut` — toggle/queue/trip logic untouched |
| `supabase/config.toml` | `[functions.notify-tick]` section |

Dispatch, match-tick, capacity, decline flow, cancel/refund paths: **no
changes**.
