// Web Push subscription manager — the frontend half of the notification
// backend (migration 20261124170000 + notify-tick).
//
// Division of labour:
//   * this module registers public/sw.js, asks for permission, subscribes
//     to push with the VAPID public key and stores the subscription in
//     `push_subscriptions` (RLS: own row only, upsert on endpoint);
//   * the SERVICE WORKER (public/sw.js) is the only thing that displays a
//     notification;
//   * notify-tick (server, every 15s) is the only thing that SENDS one.
//
// Hard rules honoured here:
//   * the VAPID PRIVATE key never touches the browser — only
//     VITE_VAPID_PUBLIC_KEY (public by design) is read from env;
//   * every path degrades silently: unsupported browser, denied
//     permission, offline — the in-app UI keeps working regardless;
//   * permission is only requested from an explicit user gesture
//     (enablePush is called from a button), because browsers ignore or
//     block unprompted requests;
//   * iOS Safari: push requires the site to be added to the home screen;
//     before that, subscribe() fails and we report 'unsupported' honestly.

import { supabase } from './supabase'

export const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY ?? ''

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i)
  return output
}

export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    window.isSecureContext &&
    Boolean(VAPID_PUBLIC_KEY)
  )
}

// 'granted' | 'denied' | 'default' | 'unsupported'
export function pushPermission() {
  if (!pushSupported()) return 'unsupported'
  try {
    return Notification.permission ?? 'default'
  } catch {
    return 'unsupported'
  }
}

async function getRegistration() {
  return navigator.serviceWorker.register('/sw.js', { scope: '/' })
}

// Persist (or refresh) the subscription server-side. Upsert on `endpoint`
// so a key rotation on the same endpoint updates one row instead of
// stacking duplicates. Returns false when the session is missing — a
// subscription without a user row could never be delivered to anyone.
async function saveSubscription(subscription) {
  const { data: auth } = await supabase.auth.getSession()
  const userId = auth?.session?.user?.id
  if (!userId) return false

  const json = subscription.toJSON()
  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_id: userId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      disabled: false,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'endpoint' },
  )
  if (error) {
    console.error('push: could not save subscription:', error.message)
    return false
  }
  return true
}

// Full opt-in flow. MUST be called from a user gesture (button tap).
// Returns a status string the UI can show verbatim:
//   'subscribed'  — saved, pushes will flow
//   'unsupported' — browser/env can't do Web Push (incl. iOS pre-install)
//   'denied'      — user blocked notifications (only fixable in browser UI)
//   'insecure'    — missing permission or VAPID key / no session
export async function enablePush() {
  if (!pushSupported()) return 'unsupported'

  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return 'denied'

    const registration = await getRegistration()
    // Browsers require the applicationServerKey as Uint8Array.
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    })

    const saved = await saveSubscription(subscription)
    if (!saved) {
      // Roll back: an unsaved subscription would silently never deliver.
      await subscription.unsubscribe().catch(() => {})
      return 'insecure'
    }
    return 'subscribed'
  } catch (err) {
    console.error('push: subscribe failed:', err)
    // Typical on iOS Safari before "Add to Home Screen".
    return 'unsupported'
  }
}

// Called on login (silent re-sync): if permission was already granted,
// make sure the stored subscription still exists and is enabled —
// browsers rotate keys / expire endpoints between visits.
export async function syncPushSubscription() {
  if (!pushSupported() || Notification.permission !== 'granted') return 'skipped'
  try {
    const registration = await getRegistration()
    const existing = await registration.pushManager.getSubscription()
    if (existing) {
      const saved = await saveSubscription(existing)
      return saved ? 'subscribed' : 'insecure'
    }
    // Permission granted but no subscription (e.g. cleared storage) —
    // do NOT re-prompt (permission already granted, so this is silent).
    return 'skipped'
  } catch (err) {
    console.error('push: sync failed:', err)
    return 'skipped'
  }
}

// Explicit opt-out from the UI: remove the browser subscription AND the
// server row (the server would otherwise keep trying a dead endpoint
// until it hits the 404/410 disable path).
export async function disablePush() {
  if (!pushSupported()) return false
  try {
    const registration = await navigator.serviceWorker.getRegistration()
    const subscription = await registration?.pushManager.getSubscription()
    if (subscription) {
      const endpoint = subscription.endpoint
      await subscription.unsubscribe().catch(() => {})
      await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint)
    }
    return true
  } catch (err) {
    console.error('push: disable failed:', err)
    return false
  }
}
