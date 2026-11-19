// Web Notifications for the two moments the spec asks to be told about:
//   * student — the assigned rider has arrived (status → 'arrived');
//   * rider   — a new ride request (offer) just arrived.
//
// Browser-native Notification API only — no dependency, no push server, no
// new table. Permission is requested from an explicit tap (browsers refuse
// an unprompted request), and every path degrades silently to the in-app
// UI that already shows both moments, so a denied permission never breaks
// anything.
//
// Honesty limits (documented, not hidden):
//   * foreground-first: a notification fires while the page is alive. A web
//     page that has been fully closed cannot notify — real push would need
//     a service worker + VAPID keys (out of scope, no new infra);
//   * iOS Safari only delivers from a home-screen web app (and its page
//     context cannot construct notifications at all) — there we return
//     false and the in-app banner remains the signal.

import { useEffect, useRef } from 'react'

export function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

// 'granted' | 'denied' | 'default' | 'unsupported'
export function notificationPermission() {
  if (!notificationsSupported()) return 'unsupported'
  try {
    return Notification.permission ?? 'default'
  } catch {
    return 'unsupported'
  }
}

// Must be called from a user gesture (button tap) or browsers ignore it.
export async function requestNotificationPermission() {
  if (!notificationsSupported()) return 'unsupported'
  try {
    return await Notification.requestPermission()
  } catch {
    // iOS Safari page context: the request itself can throw.
    return 'unsupported'
  }
}

// Fire one notification. Returns true only if the system actually accepted
// it — callers never rely on the return value for behaviour. `tag` lets the
// OS replace (not stack) a repeat of the same moment.
export function notify({ tag = 'danfolio', title, body } = {}) {
  if (!title) return false
  if (notificationPermission() !== 'granted') return false
  try {
    new Notification(String(title), {
      body: body ? String(body) : undefined,
      tag: String(tag),
    })
    try {
      // Best-effort haptic on Android; unsupported elsewhere.
      navigator.vibrate?.([200, 100, 200])
    } catch {
      /* no haptics — the notification itself already went out */
    }
    return true
  } catch {
    // Constructor unsupported (iOS page context) → in-app UI is the signal.
    return false
  }
}

// Fires `fire` exactly once per distinct key while the component lives.
// Guards that matter:
//   * the first effect run never notifies — whatever key is present when the
//     hook first runs is recorded, not announced;
//   * StrictMode's double mount cannot double-fire (the seen-set survives
//     it: run 1 marks the key seen, run 2 finds it);
//   * a data reload that flickers key → null → same key does not repeat
//     the notice — each key is announced at most once per component life.
// `fire` is read through a ref so the closure is never stale.
// (Used for rider offers; student arrivals use useArrivalNotice, which
// observes the actual not-arrived → arrived transition instead.)
function useNoticeOnKey(key, fire) {
  const firstRef = useRef(true)
  const seenRef = useRef(new Set())
  const fireRef = useRef(fire)
  fireRef.current = fire

  useEffect(() => {
    const k = key ?? null
    if (firstRef.current) {
      firstRef.current = false
      if (k !== null) seenRef.current.add(k) // already on screen — don't announce
      return
    }
    if (k === null || seenRef.current.has(k)) return
    seenRef.current.add(k)
    fireRef.current(key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}

// Student side: notify when THIS component OBSERVES its ride transition
// into 'arrived'. The hook remembers the last state it saw for each ride:
//   * seen not-arrived → arrived = the rider got there while this screen is
//     being watched → notify exactly once;
//   * first observation already 'arrived' (data loaded after mount, or a
//     remount while waiting) = no observed transition → silent, the screen
//     already says "arrived" in front of them;
//   * a different ride id resets the observation (the next arrival of a NEW
//     ride is announced again).
// The ride page and the home screen mount one at a time and key on the same
// ride, so one arrival can never notify twice.
export function useArrivalNotice(ride) {
  const prevRef = useRef(undefined) // undefined = nothing observed yet
  const fireRef = useRef(null)

  const id = ride?.id ? String(ride.id) : null
  const arrived = ride?.status === 'arrived'
  const fromName = ride?.from?.name ?? 'your pick-up point'

  fireRef.current = id
    ? () =>
        notify({
          tag: `arrival-${id}`,
          title: 'Your rider has arrived',
          body: `Your keke is at ${fromName} — show your booking code to start the trip.`,
        })
    : null

  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = id ? { id, arrived } : null
    if (prev === undefined) return // first run: record only
    if (!id || !arrived) return // nothing newly arrived
    if (!prev || prev.id !== id || prev.arrived) return // no observed transition
    fireRef.current?.()
  }, [id, arrived])
}

// Rider side: notify once per request when a new offer appears (including
// one already pending when the rider opens the app — they have not seen it
// yet). The offer modal still opens exactly as before.
export function useOfferNotice(offer) {
  const offerKey = offer?.id ? String(offer.id) : null

  useNoticeOnKey(offerKey, () => {
    const ride = offer?.ride
    const mode = ride?.mode === 'along' ? 'Along' : 'Drop'
    const secondsLeft = offer?.expires_at
      ? Math.max(
          0,
          Math.ceil((new Date(offer.expires_at).getTime() - Date.now()) / 1000),
        )
      : null
    const fare = ride?.fare != null ? `₦${Number(ride.fare).toLocaleString('en-NG')} · ` : ''
    notify({
      tag: `offer-${offerKey}`,
      title: `New ${mode} request`,
      body: `${fare}${ride?.from?.name ?? 'Pick-up'} → ${ride?.to?.name ?? 'destination'}${
        secondsLeft != null ? ` · ${secondsLeft}s to respond` : ''
      }`,
    })
  })
}
