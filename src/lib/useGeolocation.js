import { useCallback, useEffect, useRef, useState } from 'react'
import { distanceMeters } from './geo.js'
import { preferFix } from './tracking.js'

// useGeolocation — the device's CURRENT position with honest permission
// states, so the booking map can say "locating…", "location blocked" or
// "location unavailable" instead of silently showing nothing.
//
// state: 'idle' | 'asking' | 'granted' | 'denied' | 'insecure' | 'unavailable' | 'timeout'
// position: { lat, lng } | null   (never a fabricated/assumed location)
// accuracy: metres | null
// cached:   true when the fix on screen came from the browser's cache
// errorMessage / retry: plain wording + a retry handler for UIs
//
// Root-cause fix (2026-11 map task): this hook used to be ONE
// getCurrentPosition call, so a student who kept the page open walked
// around with a frozen dot. It now runs a real watchPosition
// (enableHighAccuracy: true) that is:
//   * cleared on unmount AND on every re-request (never two watches);
//   * filtered through preferFix — a much worse fix never drags the dot,
//     a more accurate one updates the marker + accuracy circle;
//   * coalesced (≥1 s apart unless the phone really moved) so a low-end
//     Android is not re-rendering React at raw GPS rate;
//   * re-armed by a watchdog only when an already-granted watch has gone
//     silently dead (no restart storms while the GPS is simply shielded).
//
// Browsers only expose the Geolocation API on secure contexts. Opened over
// plain http:// (e.g. the dev server via a LAN IP: http://192.168.x.x:5173)
// every request fails with PERMISSION_DENIED and NO prompt is ever shown —
// so telling the user to "allow location" would be a lie only the laptop
// (localhost is exempt) never sees. This is the honest state for it.
export function insecureContext() {
  return typeof window !== 'undefined' && window.isSecureContext === false
}

// A fix older than this came from the browser's cache, not live GPS —
// shown as `cached: true` so callers may label it "approximate".
const CACHED_MAX_AGE_MS = 15000
// Strictly fresh first fix: never accept a pre-existing cached position as
// "my position" (the old 15 s maximumAge window could do exactly that).
const WATCH_OPTIONS = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
// One cached fallback only, after a real GPS timeout with no fix at all —
// flagged as cached, never passed off as live.
const CACHED_FALLBACK_OPTIONS = { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
// Coalesce raw GPS ticks: a position state update at most once per second
// unless the phone moved ≥3 m or the accuracy circle shrank meaningfully.
const COALESCE_MS = 1000
const MIN_MOVE_M = 3
// An already-granted watch this silent is dead (OS throttle, crashed
// location service) — re-arm it so the dot cannot freeze forever.
const DEAD_WATCH_MS = 30000

export const GEO_MESSAGES = {
  denied: 'Location access is off — turn it on to see your position on the map.',
  insecure: 'Location is blocked because this page is open over plain http:// — open the app over HTTPS.',
  unavailable: 'Your location is unavailable right now — you can still browse the campus map.',
  timeout: 'Your location is unavailable right now — you can still browse the campus map.',
}

export function useGeolocation({ auto = true } = {}) {
  const [state, setState] = useState('idle')
  const [position, setPosition] = useState(null)
  const [accuracy, setAccuracy] = useState(null)
  const [cached, setCached] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  const aliveRef = useRef(true)
  const stateRef = useRef('idle')
  const watchIdRef = useRef(null)
  // Last ADOPTED fix (post preferFix/coalesce) — the filter's "previous".
  const appliedRef = useRef(null)
  const lastApplyAtRef = useRef(0)
  const lastFixAtRef = useRef(0)
  const cachedFallbackTriedRef = useRef(false)

  const setStateSafe = useCallback((next) => {
    stateRef.current = next
    setState(next)
  }, [])

  const stopWatch = useCallback(() => {
    if (watchIdRef.current !== null && typeof navigator !== 'undefined' && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(watchIdRef.current)
    }
    watchIdRef.current = null
  }, [])

  // Adopt (or deliberately ignore) one browser fix.
  const apply = useCallback((pos, { forceCached = false } = {}) => {
    if (!aliveRef.current || !pos?.coords) return
    const rawAcc = pos.coords?.accuracy
    const next = {
      lat: Number(pos.coords.latitude),
      lng: Number(pos.coords.longitude),
      // Number(null) === 0 would fake a perfect circle — null stays null.
      accuracy:
        rawAcc !== null && rawAcc !== undefined && rawAcc !== '' && Number.isFinite(Number(rawAcc)) && Number(rawAcc) >= 0
          ? Number(rawAcc)
          : null,
      timestamp: Number.isFinite(Number(pos.timestamp)) ? Number(pos.timestamp) : Date.now(),
    }
    if (!Number.isFinite(next.lat) || !Number.isFinite(next.lng)) return

    // Much worse + barely moved + previous fix fresh → keep the better dot.
    if (!preferFix(appliedRef.current, next)) return

    const now = Date.now()
    const moved = distanceMeters(appliedRef.current, next)
    const improved =
      !appliedRef.current ||
      (next.accuracy !== null &&
        (appliedRef.current.accuracy === null ||
          next.accuracy < appliedRef.current.accuracy * 0.8))
    const bigMove = moved !== null && moved >= MIN_MOVE_M
    if (!forceCached && appliedRef.current && now - lastApplyAtRef.current < COALESCE_MS && !bigMove && !improved) {
      return // coalesce: raw GPS rate must not re-render React
    }

    appliedRef.current = next
    lastApplyAtRef.current = now
    lastFixAtRef.current = now
    setPosition({ lat: next.lat, lng: next.lng })
    setAccuracy(next.accuracy)
    setCached(forceCached || now - next.timestamp > CACHED_MAX_AGE_MS)
    setStateSafe('granted')
    setErrorMessage('')
  }, [setStateSafe])

  const fail = useCallback((kind) => {
    setStateSafe(kind)
    setErrorMessage(GEO_MESSAGES[kind] ?? GEO_MESSAGES.unavailable)
    // The browser will not re-prompt until the user acts — stop watching.
    if (kind === 'denied' || kind === 'insecure') stopWatch()
  }, [setStateSafe, stopWatch])

  const startWatch = useCallback(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setStateSafe('unavailable')
      setErrorMessage(GEO_MESSAGES.unavailable)
      return
    }
    stopWatch()
    cachedFallbackTriedRef.current = false
    lastFixAtRef.current = Date.now() // a re-arm grants a full watchdog window

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => apply(pos),
      (err) => {
        if (!aliveRef.current) return
        if (insecureContext()) {
          fail('insecure')
          return
        }
        if (err?.code === 1) {
          fail('denied')
          return
        }
        // TIMEOUT with no fix yet: one cached fallback (clearly flagged),
        // the watch keeps running for a real fix.
        if (err?.code === 3 && !appliedRef.current && !cachedFallbackTriedRef.current) {
          cachedFallbackTriedRef.current = true
          navigator.geolocation.getCurrentPosition(
            (pos) => apply(pos, { forceCached: true }),
            (retryErr) => {
              if (!aliveRef.current) return
              if (retryErr?.code === 1) fail('denied')
              else if (retryErr?.code === 3) fail('timeout')
              else fail('unavailable')
            },
            CACHED_FALLBACK_OPTIONS,
          )
          return
        }
        if (!appliedRef.current) {
          if (err?.code === 3) fail('timeout')
          else fail('unavailable')
          return
        }
        // Transient error while we already have a position: keep the dot,
        // keep the watch. The watchdog re-arms it if it goes truly silent.
      },
      WATCH_OPTIONS,
    )
  }, [apply, fail, setStateSafe, stopWatch])

  const request = useCallback(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setStateSafe('unavailable')
      setErrorMessage(GEO_MESSAGES.unavailable)
      return
    }
    // Fail fast with the real reason: on an insecure origin the browser
    // denies without ever prompting, so "asking" would be theatre.
    if (insecureContext()) {
      setStateSafe('insecure')
      setErrorMessage(GEO_MESSAGES.insecure)
      return
    }
    setStateSafe('asking')
    setErrorMessage('')
    setCached(false)
    startWatch()
  }, [setStateSafe, startWatch])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      stopWatch()
    }
  }, [stopWatch])

  useEffect(() => {
    if (auto) request()
  }, [auto, request])

  // Watchdog: an already-granted watch that has delivered NOTHING for
  // DEAD_WATCH_MS is dead (OS throttle / suspended service). Restart it so
  // the dot cannot freeze. While still 'asking' the single watch is left
  // alone — a shielded GPS would otherwise restart forever (battery churn
  // on low-end Android); the timeout message + retry button cover that.
  useEffect(() => {
    const check = () => {
      if (!aliveRef.current || watchIdRef.current === null) return
      if (stateRef.current !== 'granted') return
      if (lastFixAtRef.current === 0) return
      if (Date.now() - lastFixAtRef.current < DEAD_WATCH_MS) return
      startWatch()
    }
    const timer = window.setInterval(check, 10000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') check()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onVisible)
    }
  }, [startWatch])

  return {
    state,
    position,
    accuracy,
    cached,
    errorMessage,
    request,
    retry: request,
  }
}
