// Connection quality + adaptive update pacing (spec: field-test fix-pack).
//
// The school network is slow and drops out, so the tracking screen has to
// decide how much work to do:
//   fast    — Realtime is the source of truth; a slow safety-net poll runs.
//   slow    — at most one rider position applied every ~6 s (inside the
//             5–8 s target), slower safety-net poll, saveData respected.
//   offline — no polling at all, no position updates; the last known position
//             stays on screen, labelled with its age. Nothing is invented.
//
// Pure helpers here; useNetworkQuality() is the React wrapper. Unit-tested in
// tests/netQuality.test.js.

import { useEffect, useState } from 'react'

export const OFFLINE_INTERVAL_MS = Number.POSITIVE_INFINITY
export const SLOW_APPLY_INTERVAL_MS = 6000
export const RECONNECT_CAP_MS = 30000

function connectionOf(target) {
  return target?.connection ?? target?.mozConnection ?? target?.webkitConnection ?? null
}

// 'offline' | 'slow' | 'fast'. Conservative: an unknown effectiveType is
// treated as fast (no downside — Realtime still drives the screen).
export function connectionQuality(target = typeof navigator === 'undefined' ? null : navigator) {
  if (!target) return 'fast'
  if (target.onLine === false) return 'offline'

  const connection = connectionOf(target)
  if (connection?.saveData) return 'slow'

  const type = String(connection?.effectiveType ?? '').toLowerCase()
  if (type === 'slow-2g' || type === '2g' || type === '3g') return 'slow'
  return 'fast'
}

// Minimum gap between two applied rider positions.
export function applyIntervalMs(quality) {
  if (quality === 'offline') return OFFLINE_INTERVAL_MS
  if (quality === 'slow') return SLOW_APPLY_INTERVAL_MS
  return 0
}

// May this position be painted now? Offline never applies (the screen keeps
// the cached fix); slow applies at most once per interval.
export function shouldApplyPosition({ now = Date.now(), lastAt = 0, quality = 'fast' } = {}) {
  const interval = applyIntervalMs(quality)
  if (interval === OFFLINE_INTERVAL_MS) return false
  if (interval === 0) return true
  if (!Number.isFinite(lastAt) || lastAt <= 0) return true
  return now - lastAt >= interval
}

// Safety-net poll (Realtime is primary). A weak link polls LESS often, not
// more: the realtime stream plus the stored position already covers it, and
// the point of the slow mode is to spend fewer requests. null = no polling.
export function pollIntervalMs(quality) {
  if (quality === 'offline') return null
  return quality === 'slow' ? 30000 : 15000
}

// Exponential backoff for Realtime reconnects / bounded fetch retries.
// attempt 0 → 1 s, 1 → 2 s, 2 → 4 s … capped at RECONNECT_CAP_MS.
export function nextRetryDelay(attempt, { baseMs = 1000, capMs = RECONNECT_CAP_MS } = {}) {
  const steps = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0
  return Math.min(capMs, baseMs * 2 ** steps)
}

// Calm banner wording. Empty string = no banner.
export function networkBanner(quality) {
  if (quality === 'offline') return 'You’re offline. Showing last known position.'
  if (quality === 'slow') return 'Weak network, updating slowly.'
  return ''
}

// React wrapper: re-evaluates on online/offline and on connection changes
// (effectiveType / saveData can change mid-ride on a phone).
export function useNetworkQuality() {
  const read = () =>
    typeof navigator === 'undefined' ? 'fast' : connectionQuality(navigator)
  const [quality, setQuality] = useState(read)

  useEffect(() => {
    const update = () => setQuality(read())
    update()

    window.addEventListener('online', update)
    window.addEventListener('offline', update)

    const connection = connectionOf(typeof navigator === 'undefined' ? null : navigator)
    connection?.addEventListener?.('change', update)

    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
      connection?.removeEventListener?.('change', update)
    }
  }, [])

  return quality
}
