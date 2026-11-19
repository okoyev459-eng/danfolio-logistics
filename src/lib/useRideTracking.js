import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabase'
import { insecureContext } from './useGeolocation'
import {
  normalizeFix,
  shouldPublishFix,
  shouldRearmWatch,
  trackingConfig,
  trackableRideIds,
} from './tracking'

// useRideTracking — the rider device's live GPS publisher (spec section 6).
//
// While (and ONLY while) rides assigned to this rider are active
// (accepted → paid → arrived → on_trip), it watches real device positions
// with watchPosition({ enableHighAccuracy: true }), validates + throttles
// them (lib/tracking.js) and upserts ONE current row per ride into
// `ride_locations` (RLS: this rider, this ride, active only).
//
// Stops the moment the ride list empties (completed / cancelled) and deletes
// the rows for rides that ended, so sharing genuinely stops. Students can
// never write this table (no write policy exists), and another rider's rides
// are unreachable (WITH CHECK requires keke_id = auth.uid()).
//
// Honest states returned for the UI:
//   idle        — no active rides, nothing watched
//   starting    — asking for / acquiring the first fix
//   sharing     — publishing real fixes
//   denied      — permission refused (the browser will not re-prompt)
//   insecure    — the page is NOT a secure context (plain http://): the
//                 browser blocks location without ever prompting, so the
//                 fix must say "open over HTTPS", never "allow location"
//   unsupported — no Geolocation API on this device
//   blocked     — the ride_locations migration is not applied yet
//   error       — publish failing (network / RLS); watch continues, retries
//
// Foreground-only: a web PWA cannot promise background GPS (documented in
// docs/map-and-live-tracking.md); sharing pauses when the OS suspends the
// tab and resumes on the next fix. A watchdog re-arms a watch that has gone
// silent past rearmAfterMs (and on returning to the foreground), so a
// quietly dead watch cannot leave the student staring at a frozen marker.

function classifyWatchError(err) {
  if (err?.code === 1) return 'denied'
  if (err?.code === 3) return 'timeout'
  return 'unavailable' // POSITION_UNAVAILABLE / unknown — transient
}

function isMissingTableError(error) {
  if (!error) return false
  const code = error.code ?? error.error?.code
  if (code === 'PGRST205' || code === '42P01') return true
  const message = String(error.message ?? error.error?.message ?? '')
  return /could not find the table|relation .* does not exist|schema cache/i.test(message)
}

export function useRideTracking({ kekeId, rides = [] }) {
  const config = useMemo(() => trackingConfig(), [])
  const rideIds = useMemo(() => trackableRideIds(rides), [rides])
  const rideIdsKey = rideIds.join(',')

  const [phase, setPhase] = useState('idle')
  const [lastPublishedAt, setLastPublishedAt] = useState(null)
  const [lastFix, setLastFix] = useState(null)
  const [error, setError] = useState('')
  const [restartKey, setRestartKey] = useState(0)

  const watchIdRef = useRef(null)
  const rideIdsRef = useRef(rideIds)
  const prevIdsRef = useRef(rideIds)
  const publishedRef = useRef({ fix: null, at: null })
  const blockedRef = useRef(false)
  const phaseRef = useRef('idle')
  // Silence tracking for the watchdog: when the watch was last (re-)armed
  // and when it last delivered a usable fix. Refs only — the student-facing
  // freshness label always comes from the SERVER-stamped updated_at.
  const watchStartedAtRef = useRef(0)
  const lastFixAtRef = useRef(0)

  rideIdsRef.current = rideIds

  function setPhaseSafe(next) {
    if (phaseRef.current !== next) {
      phaseRef.current = next
      setPhase(next)
    }
  }

  function stopWatch() {
    if (watchIdRef.current !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(watchIdRef.current)
    }
    watchIdRef.current = null
  }

  // Force a fresh watch: stop + restart so the OS re-delivers a REAL, recent
  // fix (maximumAge: 2000) instead of letting a quietly dead watch leave the
  // student staring at a frozen keke. The baseline moves immediately, so the
  // watchdog can never tight-loop while the GPS itself is unavailable.
  function rearmWatch() {
    if (blockedRef.current || rideIdsRef.current.length === 0) return
    if (!('geolocation' in navigator)) return
    watchStartedAtRef.current = Date.now()
    stopWatch()
    setPhaseSafe('starting')
    setRestartKey((k) => k + 1)
  }

  // Publish one fix to every currently tracked ride (upsert: one row per
  // ride). Everything mutable lives in refs, so the watch callback captured
  // on the first render stays correct for the life of the component.
  async function publish(fix) {
    const ids = rideIdsRef.current
    if (!ids.length || !kekeId) return

    const rows = ids.map((rideId) => ({
      ride_id: rideId,
      keke_id: kekeId,
      lat: fix.lat,
      lng: fix.lng,
      accuracy: fix.accuracy,
      heading: fix.heading,
      speed: fix.speed,
    }))

    const { error: writeError } = await supabase
      .from('ride_locations')
      .upsert(rows, { onConflict: 'ride_id' })

    if (writeError) {
      if (isMissingTableError(writeError)) {
        blockedRef.current = true
        setPhaseSafe('blocked')
        stopWatch()
        return
      }
      setError(writeError.message)
      setPhaseSafe('error')
      return
    }

    publishedRef.current = { fix, at: Date.now() }
    setError('')
    setLastPublishedAt(new Date().toISOString())
    setLastFix({ lat: fix.lat, lng: fix.lng })
    setPhaseSafe('sharing')
  }

  // Ride-list transitions: delete rows for rides that ended (sharing stops
  // for real), then start/stop the watch as a whole.
  useEffect(() => {
    const current = new Set(rideIds)
    const ended = [...prevIdsRef.current].filter((id) => !current.has(id))
    prevIdsRef.current = rideIds

    if (ended.length > 0 && kekeId && !blockedRef.current) {
      // Best effort: even if this delete fails, RLS hides finished rides'
      // rows from students and the rider can no longer refresh them.
      supabase
        .from('ride_locations')
        .delete()
        .eq('keke_id', kekeId)
        .in('ride_id', ended)
        .then(() => {}, () => {})
    }

    if (rideIds.length === 0) {
      stopWatch()
      publishedRef.current = { fix: null, at: null }
      watchStartedAtRef.current = 0
      lastFixAtRef.current = 0
      if (!blockedRef.current) setPhaseSafe('idle')
      return undefined
    }

    if (blockedRef.current) return undefined
    if (watchIdRef.current !== null) return undefined // already watching

    if (!('geolocation' in navigator)) {
      setPhaseSafe('unsupported')
      return undefined
    }

    // Plain-http origins are not secure contexts: the browser denies the
    // watch WITHOUT prompting, which would otherwise surface as the
    // misleading "denied" state (the phone's exact complaint — localhost
    // on the laptop is exempt, so the laptop never sees it).
    if (insecureContext()) {
      setPhaseSafe('insecure')
      return undefined
    }

    setPhaseSafe('starting')
    watchStartedAtRef.current = Date.now()
    lastFixAtRef.current = 0

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const fix = normalizeFix(position?.coords, { maxAccuracyM: config.maxAccuracyM })
        if (!fix) return // dropped: invalid, (0,0) or too inaccurate
        fix.timestamp = position.timestamp ?? Date.now()
        lastFixAtRef.current = Date.now()
        setLastFix({ lat: fix.lat, lng: fix.lng })

        if (
          shouldPublishFix({
            previous: publishedRef.current.fix,
            previousAt: publishedRef.current.at,
            fix,
            config,
          })
        ) {
          publish(fix)
        } else {
          setPhaseSafe('sharing')
        }
      },
      (watchError) => {
        // An insecure origin denies without prompting — report the real
        // cause (open over HTTPS), not "allow location for this site".
        if (insecureContext()) {
          setPhaseSafe('insecure')
          stopWatch()
          return
        }
        const kind = classifyWatchError(watchError)
        if (kind === 'denied') {
          setPhaseSafe('denied')
          stopWatch()
          return
        }
        // unavailable / timeout are transient — the watch stays alive; only
        // surface the message while nothing has been shared yet.
        if (phaseRef.current !== 'sharing') {
          setError(
            kind === 'timeout'
              ? 'Waiting for a GPS fix — move to open sky if this persists.'
              : 'GPS is temporarily unavailable — retrying automatically.',
          )
          setPhaseSafe('starting')
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 20000,
        // Accept a fix at most 2 s old (was 5 s) so the first paint after a
        // restart shows a genuinely recent position, not a cached one.
        maximumAge: 2000,
      },
    )

    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rideIdsKey, kekeId, restartKey])

  // Manual retry: clears a denial/block state and re-arms the watch (the
  // browser decides whether to re-prompt for permission).
  function retry() {
    blockedRef.current = false
    setError('')
    stopWatch()
    setPhaseSafe(rideIdsRef.current.length > 0 ? 'starting' : 'idle')
    setRestartKey((k) => k + 1)
  }

  // Unmount: stop watching. Rows for STILL-active rides remain on purpose
  // (the rides are active; the student sees honest staleness until the app
  // returns); rows for ended rides were deleted by the transition above.
  useEffect(() => () => stopWatch(), [])

  // Reconnection (Task 6): a dropped network or a tab that was backgrounded
  // can leave the watch quietly stale. When the device comes back online and
  // rides are still active, re-arm the watch so the first fresh fix re-publishes
  // immediately instead of waiting out maximumAge. No new subscription is
  // created — just a restart of the existing watch.
  useEffect(() => {
    function handleOnline() {
      if (rideIdsRef.current.length === 0 || blockedRef.current) return
      stopWatch()
      setPhaseSafe('starting')
      setRestartKey((k) => k + 1)
    }

    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [])

  // Watchdog (Task 7): a watch can die quietly — OS throttle, a crashed
  // geolocation service, a tab that was suspended long enough that nothing
  // re-delivers a fix. While rides are active, if the watch has been silent
  // past rearmAfterMs, re-arm it so a REAL fresh fix goes out and the
  // student's marker keeps moving. shouldRearmWatch's baseline moves on
  // every re-arm, so a genuinely dead GPS costs one restart per window,
  // never a tight loop.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (rideIdsRef.current.length === 0 || blockedRef.current) return
      if (watchIdRef.current === null) return // not watching (yet)
      if (
        !shouldRearmWatch({
          lastFixAt: lastFixAtRef.current,
          startedAt: watchStartedAtRef.current,
        })
      ) {
        return
      }
      rearmWatch()
    }, 5000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Foreground re-arm: coming back to the app (tab switch, screen unlock,
  // PWA out of the tray) is the moment browsers most often leave a watch
  // paused. If it has been silent while we were away, restart it so the
  // first fix re-publishes immediately instead of waiting out maximumAge.
  useEffect(() => {
    function handleVisible() {
      if (document.visibilityState !== 'visible') return
      if (rideIdsRef.current.length === 0 || blockedRef.current) return
      if (watchIdRef.current === null) return
      if (
        !shouldRearmWatch({
          lastFixAt: lastFixAtRef.current,
          startedAt: watchStartedAtRef.current,
        })
      ) {
        return
      }
      rearmWatch()
    }

    document.addEventListener('visibilitychange', handleVisible)
    return () => document.removeEventListener('visibilitychange', handleVisible)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    phase,
    lastPublishedAt,
    lastFix,
    error,
    trackedRideIds: rideIds,
    config,
    retry,
  }
}
