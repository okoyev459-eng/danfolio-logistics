import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import CampusMap from '../../components/CampusMap.jsx'
import BottomSheet from '../../components/BottomSheet.jsx'
import { useAuth } from '../../lib/auth.jsx'
import { supabase } from '../../lib/supabase'
import { useGeolocation } from '../../lib/useGeolocation'
import { distanceMeters, formatDistance, validCoord } from '../../lib/geo'
import './book.css'

// BookFlow — the full-screen Bolt-style booking screen for both Drop and Along.
//
// The map IS the screen: it fills the viewport, with a floating glass top bar
// and a draggable bottom sheet (pickup / destination / fare / booking controls)
// layered on top. The entire booking contract from the previous version is
// preserved: the create-ride Edge Function is still the ONLY way a ride is
// created, dispatch states (searching / no_ride_available) are handled the
// same way, errors are extracted the same way, and ride status follows via
// Realtime with polling fallback.
//
// Data sources (all real, no fake markers):
//   - locations / fares        admin-managed tables (Supabase)
//   - nearby keke riders       `kekes` rows with status='online' + fresh
//                              heartbeat (last_seen), updated live via
//                              Realtime (15s poll fallback)
//   - my position               browser geolocation (permission states shown)
//   - route + ETA              public OSRM with straight-line fallback
//
// Failure handling: location permission denied/timeout, offline banner,
// map style failure (retryable), and location-list load errors all degrade
// to a still-usable screen — the sheet never depends on the map rendering.

const RIDE_SELECT =
  'id, status, fare, mode, booking_code, keke_id, created_at, ' +
  'from:locations!rides_from_id_fkey(id, name, lat, lng), ' +
  'to:locations!rides_to_id_fkey(id, name, lat, lng)'

const ACTIVE_STATUSES = ['searching', 'accepted', 'paid', 'arrived', 'on_trip']

// Sheet snaps in visibility order: peek (px), mid (fraction), full (fraction).
const SHEET_SNAPS = [152, 0.46, 0.88]

// Riders heartbeat every 20s; anything not seen for 90s is not "nearby".
const KEKE_FRESH_MS = 90000

const STATUS_COPY = {
  searching: {
    title: 'Finding your Keke…',
    body: 'Your request is being offered to eligible riders one at a time.',
  },
  accepted: {
    title: 'Keke accepted — pay to confirm',
    body: 'A rider is assigned. Complete payment so they can head over.',
  },
  paid: {
    title: 'Paid — waiting for your rider',
    body: 'Show your booking code when your rider arrives.',
  },
  arrived: {
    title: 'Your rider has arrived',
    body: 'Show your booking code to the rider to start the trip.',
  },
  on_trip: {
    title: 'You are on the trip',
    body: 'Enjoy your ride. The rider completes the trip at your destination.',
  },
  completed: {
    title: 'Trip completed',
    body: 'Thank you for riding with Danfolio Logistics.',
  },
  cancelled: {
    title: 'This booking was cancelled',
    body: 'You can book another ride whenever you are ready.',
  },
  refunded: {
    title: 'This booking was refunded',
    body: 'The payment has been refunded. Bank processing can take a little while.',
  },
}

export default function BookFlow({ mode }) {
  const { signOut } = useAuth()
  const geo = useGeolocation()

  const [locations, setLocations] = useState([])
  const [locState, setLocState] = useState('loading') // loading | ready | error
  const [locAttempt, setLocAttempt] = useState(0)

  const [from, setFrom] = useState(null)
  const [to, setTo] = useState(null)
  const [fare, setFare] = useState(null)
  const [fareState, setFareState] = useState('idle') // idle | loading | ready | missing

  const [fromConfirmed, setFromConfirmed] = useState(false)
  const [query, setQuery] = useState('')
  const [sheetIndex, setSheetIndex] = useState(0)
  const [message, setMessage] = useState('')
  const [booking, setBooking] = useState(false)
  const [elapsed, setElapsed] = useState(0)

  const [activeRide, setActiveRide] = useState(null)
  const [statusError, setStatusError] = useState('')

  const [kekes, setKekes] = useState([])
  const [mapFailed, setMapFailed] = useState(false)
  const [mapAttempt, setMapAttempt] = useState(0)
  const [routeEta, setRouteEta] = useState(null)

  const [online, setOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )
  const [cancelling, setCancelling] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)

  // Map camera API (zoom / recenter / fit), driven by the FAB controls.
  const mapRef = useRef(null)

  const isDrop = mode === 'drop'
  const fromKind = isDrop ? 'pickup' : 'station'

  // ------------------------------------------------------------------
  // Locations (admin-managed pickup points / stations / destinations)
  // ------------------------------------------------------------------
  useEffect(() => {
    let active = true

    async function loadLocations() {
      setLocState('loading')
      const { data, error } = await supabase
        .from('locations')
        .select('id, name, kind, lat, lng')
        .eq('mode', mode)
        .eq('active', true)
        .order('name')

      if (!active) return

      if (error) {
        setLocState('error')
      } else {
        setLocations(data ?? [])
        setLocState('ready')
      }
    }

    loadLocations()

    return () => {
      active = false
    }
  }, [mode, locAttempt])

  // ------------------------------------------------------------------
  // Rejoin an already-active booking on mount (e.g. returning to this page)
  // ------------------------------------------------------------------
  const joinedOnceRef = useRef(false)

  useEffect(() => {
    if (joinedOnceRef.current) return
    joinedOnceRef.current = true

    let active = true

    async function joinActiveRide() {
      const { data } = await supabase
        .from('rides')
        .select(RIDE_SELECT)
        .order('created_at', { ascending: false })
        .limit(20)

      if (!active) return
      const row = (data ?? []).find((r) => ACTIVE_STATUSES.includes(r.status))
      if (row) {
        setActiveRide(row)
        setSheetIndex(1)
      }
    }

    joinActiveRide()

    return () => {
      active = false
    }
  }, [])

  // ------------------------------------------------------------------
  // Follow the ride: Realtime always, polling while searching
  // (same contract as before — this page never writes rides directly)
  // ------------------------------------------------------------------
  const fetchRide = useCallback(async (rideId) => {
    const { data, error } = await supabase
      .from('rides')
      .select(RIDE_SELECT)
      .eq('id', rideId)
      .maybeSingle()

    if (error) {
      setStatusError('We could not refresh your ride status. Retrying…')
      return null
    }
    if (!data) {
      setStatusError('We could not find your booking. Please contact support.')
      return null
    }

    setStatusError('')
    setActiveRide(data)
    return data
  }, [])

  const rideId = activeRide?.id
  const rideStatus = activeRide?.status

  useEffect(() => {
    if (!rideId) return

    let active = true
    let loadingStatus = false

    async function refreshRide() {
      if (loadingStatus) return
      loadingStatus = true
      await fetchRide(rideId)
      loadingStatus = false
    }

    if (rideStatus === 'searching') refreshRide()

    const channel = supabase
      .channel(`student-ride-status-${rideId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'rides',
          filter: `id=eq.${rideId}`,
        },
        (payload) => {
          if (active && payload.new) {
            setActiveRide((current) => ({ ...current, ...payload.new }))
          }
        },
      )
      .subscribe()

    // Polling provides a fallback if a realtime update is missed.
    const timer =
      rideStatus === 'searching' ? window.setInterval(refreshRide, 2000) : null

    return () => {
      active = false
      if (timer) window.clearInterval(timer)
      supabase.removeChannel(channel)
    }
  }, [rideId, rideStatus, fetchRide])

  // ------------------------------------------------------------------
  // Nearby keke riders: initial load + Realtime + 15s poll fallback.
  // Riders heartbeat every 20s; rows without a fresh last_seen are hidden.
  // ------------------------------------------------------------------
  useEffect(() => {
    let active = true

    async function loadKekes() {
      const { data } = await supabase
        .from('kekes')
        .select('id, keke_number, status, lat, lng, last_seen')

      if (active && data) setKekes(data)
    }

    loadKekes()
    const timer = window.setInterval(loadKekes, 15000)

    const channel = supabase
      .channel('booking-keke-positions')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'kekes' },
        (payload) => {
          if (!active) return
          if (payload.eventType === 'DELETE') {
            setKekes((rows) => rows.filter((k) => k.id !== payload.old?.id))
          } else if (payload.new?.id) {
            setKekes((rows) => {
              const rest = rows.filter((k) => k.id !== payload.new.id)
              return [...rest, payload.new]
            })
          }
        },
      )
      .subscribe()

    return () => {
      active = false
      window.clearInterval(timer)
      supabase.removeChannel(channel)
    }
  }, [])

  // Offline / back-online banner for poor networks.
  useEffect(() => {
    function goOnline() {
      setOnline(true)
    }
    function goOffline() {
      setOnline(false)
    }
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  // ------------------------------------------------------------------
  // Derived lists
  // ------------------------------------------------------------------
  const froms = useMemo(
    () => locations.filter((l) => l.kind === fromKind),
    [locations, fromKind],
  )
  const tos = useMemo(
    () => locations.filter((l) => l.kind === 'destination' && l.name !== from?.name),
    [locations, from?.name],
  )

  // Destination search field (mockup "Where are you going?").
  const filteredTos = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tos
    return tos.filter((l) => l.name.toLowerCase().includes(q))
  }, [tos, query])

  // Nearest-first ordering once the student shares their location.
  const sortedFroms = useMemo(() => {
    if (!geo.position || !froms.length) return froms
    return [...froms].sort((a, b) => {
      const da = validCoord(a) ? distanceMeters(geo.position, a) : Infinity
      const db = validCoord(b) ? distanceMeters(geo.position, b) : Infinity
      return da - db
    })
  }, [froms, geo.position])

  // Planning stage: pick-up first (explicit "Confirm pick-up"), then
  // destination + fare ("Step 2 of 2") which books the ride.
  const stage = activeRide ? null : !from || !fromConfirmed ? 'from' : 'to'

  // Elapsed seconds on the "Searching · 0:12" counter (real time since the
  // ride row was created — never faked).
  useEffect(() => {
    if (activeRide?.status !== 'searching') return undefined
    const createdAt = activeRide.created_at
      ? new Date(activeRide.created_at).getTime()
      : Date.now()
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - createdAt) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [activeRide?.status, activeRide?.created_at])

  // Fresh = heartbeat within KEKE_FRESH_MS and real coordinates.
  const freshKekes = useMemo(() => {
    const now = Date.now()
    return kekes.filter(
      (k) =>
        validCoord(k) &&
        k.last_seen &&
        now - new Date(k.last_seen).getTime() < KEKE_FRESH_MS,
    )
  }, [kekes])

  const assignedKeke = useMemo(
    () => (activeRide?.keke_id ? kekes.find((k) => k.id === activeRide.keke_id) ?? null : null),
    [kekes, activeRide?.keke_id],
  )

  // Map markers: during planning only 'online' riders; during a ride the
  // assigned rider (highlighted, even if on_trip) plus nearby online ones.
  const mapKekes = useMemo(() => {
    const assignedId = activeRide?.keke_id ?? null
    return freshKekes
      .filter((k) => (assignedId ? true : k.status === 'online'))
      .map((k) => ({ ...k, highlight: Boolean(assignedId) && k.id === assignedId }))
  }, [freshKekes, activeRide?.keke_id])

  const mapPoints = useMemo(() => {
    if (activeRide) {
      return [activeRide.from, activeRide.to].filter((p) => validCoord(p))
    }
    if (to) return [from, to].filter((p) => validCoord(p))
    if (from) return [from, ...tos].filter((p) => validCoord(p))
    return froms.filter((p) => validCoord(p))
  }, [activeRide, from, to, froms, tos])

  const routeLine = useMemo(() => {
    const a = activeRide ? activeRide.from : from
    const b = activeRide ? activeRide.to : to
    return validCoord(a) && validCoord(b) ? { from: a, to: b } : null
  }, [activeRide, from, to])

  const selectedId = activeRide ? null : (to?.id ?? from?.id ?? null)

  // FAB / attribution offset tracks the sheet's visible height.
  const snap = SHEET_SNAPS[Math.min(sheetIndex, SHEET_SNAPS.length - 1)]
  const sheetBottomCss =
    snap < 1 ? `calc(${Math.round(snap * 100)}vh + 12px)` : `${snap + 12}px`

  // Expand the sheet when the trip advances (but never fight the user's
  // own drags on an unchanged status).
  const prevStatusRef = useRef(null)
  useEffect(() => {
    if (rideStatus && rideStatus !== prevStatusRef.current) {
      prevStatusRef.current = rideStatus
      if (['accepted', 'paid', 'arrived', 'on_trip'].includes(rideStatus)) {
        setSheetIndex((i) => Math.max(i, 1))
      }
    }
  }, [rideStatus])

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------
  function pickPickup(location) {
    if (location.id !== from?.id) {
      setTo(null)
      setFare(null)
      setFareState('idle')
      setMessage('')
    }
    setFrom(location)
    setFromConfirmed(false)
  }

  async function pickDestination(location) {
    setTo(location)
    setFare(null)
    setFareState('loading')
    setMessage('')
    setSheetIndex((i) => Math.max(i, 1))

    const { data, error } = await supabase
      .from('fares')
      .select('amount')
      .eq('mode', mode)
      .eq('from_id', from.id)
      .eq('to_id', location.id)
      .maybeSingle()

    if (error) {
      setFareState('missing')
      setMessage(error.message)
      return
    }

    setFare(data?.amount ?? null)
    setFareState(data?.amount === null || data?.amount === undefined ? 'missing' : 'ready')
  }

  async function createRide() {
    if (!from || !to || fare === null || booking) return

    setBooking(true)
    setMessage('')
    setStatusError('')

    try {
      const { data, error } = await supabase.functions.invoke('create-ride', {
        body: {
          mode,
          from_id: from.id,
          to_id: to.id,
        },
      })

      if (error) throw error
      if (data?.error) throw new Error(data.error)
      if (!data?.ride_id) {
        throw new Error('Ride was not created. Please try again.')
      }

      // The server may already have exhausted eligible riders.
      if (
        data.dispatch_state === 'no_ride_available' ||
        data.status === 'cancelled'
      ) {
        setActiveRide({
          id: data.ride_id,
          fare: data.fare,
          status: 'cancelled',
          mode,
          noRide: true,
          from,
          to,
        })
      } else {
        setActiveRide({
          id: data.ride_id,
          fare: data.fare,
          status: data.status ?? 'searching',
          mode,
          from,
          to,
        })
      }
      setSheetIndex(1)
    } catch (error) {
      let detail = error?.message || 'Could not create your ride.'

      if (error?.context && typeof error.context.clone === 'function') {
        try {
          const payload = await error.context.clone().json()
          detail = payload?.error || payload?.message || detail
        } catch {}
      }

      console.error('Ride booking error:', error)
      setMessage(detail)
    } finally {
      setBooking(false)
    }
  }

  async function cancelRide() {
    if (cancelling || !activeRide?.id) return
    setCancelling(true)
    setMessage('')

    const { data, error: fnError } = await supabase.functions.invoke('cancel-ride', {
      body: { ride_id: activeRide.id },
    })

    setCancelling(false)
    setConfirmCancel(false)

    if (fnError) {
      let detail = fnError.message
      try {
        const payload = await fnError.context?.json?.()
        detail = payload?.error || detail
      } catch {}
      setMessage(detail || 'Could not cancel the ride. Please try again.')
      return
    }
    if (data?.error) {
      setMessage(data.error)
      return
    }

    await fetchRide(activeRide.id)
  }

  function tryAgain() {
    setActiveRide(null)
    setStatusError('')
    setMessage('')
    setFrom(null)
    setTo(null)
    setFromConfirmed(false)
    setQuery('')
    setFare(null)
    setFareState('idle')
    setConfirmCancel(false)
    setRouteEta(null)
    setSheetIndex(0)
    prevStatusRef.current = null
  }

  function recenterNow() {
    if (!mapRef.current?.recenter()) geo.request()
  }

  // ------------------------------------------------------------------
  // Sheet content
  // ------------------------------------------------------------------
  function locationDistance(location) {
    if (!geo.position || !validCoord(location)) return null
    return formatDistance(distanceMeters(geo.position, location))
  }

  function planningBody() {
    if (stage === 'from') {
      return (
        <>
          <p className="bk-step">
            {isDrop ? 'Choose your pick-up' : 'Choose your station'}
          </p>
          <p className="bk-sub">
            {isDrop
              ? 'Select one of the campus pick-up points.'
              : 'You must be at the station to be picked up.'}
            {geo.state === 'granted' && ' Nearest points are first.'}
          </p>

          {geo.state === 'asking' && (
            <p className="bk-sub">
              <span className="bk-spin dark" aria-hidden="true" />
              Locating you…
            </p>
          )}
          {(geo.state === 'denied' ||
            geo.state === 'unavailable' ||
            geo.state === 'timeout') && (
            <p className="bk-sub">
              {geo.state === 'denied'
                ? 'Location access is off — you can still pick any point from the list.'
                : 'We could not get your location — you can still pick any point from the list.'}{' '}
              <button
                type="button"
                className="link"
                style={{ display: 'inline', height: 'auto', margin: 0 }}
                onClick={geo.request}
              >
                Try again
              </button>
            </p>
          )}

          <div className="bk-list">
            {sortedFroms.map((location, index) => {
              const dist = locationDistance(location)
              const isNearest = geo.state === 'granted' && index === 0 && dist
              return (
                <button
                  key={location.id}
                  className={'bk-opt' + (from?.id === location.id ? ' sel' : '')}
                  onClick={() => pickPickup(location)}
                >
                  <span style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {location.name}
                    </span>
                    {isNearest && <span className="bk-near">Near you</span>}
                  </span>
                  {dist && <small>{dist}</small>}
                </button>
              )
            })}
          </div>

          <button
            type="button"
            className="bk-cta"
            disabled={!from}
            onClick={() => setFromConfirmed(true)}
          >
            {isDrop ? 'Confirm pick-up' : 'Confirm station'}
          </button>
        </>
      )
    }

    // stage === 'to' — mockup "Step 2 of 2 · Choose destination" + fixed fare
    return (
      <>
        <p className="bk-progress-steps">
          Step 2 of 2 · Choose destination
          <i aria-hidden="true" />
        </p>

        <button
          type="button"
          className="bk-route"
          onClick={() => setFromConfirmed(false)}
        >
          <span className="bk-route-dots" aria-hidden="true">
            <span className="bk-dot" />
            <span className="bk-dot-line" />
            <span className="bk-dot to" />
          </span>
          <span className="bk-route-text">
            <b>{from.name}</b>
            <span>{isDrop ? 'Pick-up (fixed)' : 'Station (fixed)'}</span>
          </span>
          <span className="bk-route-change">Change</span>
        </button>

        <input
          className="bk-search"
          type="search"
          placeholder="Where are you going?"
          aria-label="Search destinations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="bk-list">
          {filteredTos.map((location) => {
            const dist = locationDistance(location)
            return (
              <button
                key={location.id}
                className={'bk-opt' + (to?.id === location.id ? ' sel' : '')}
                onClick={() => pickDestination(location)}
              >
                {location.name}
                {dist && <small>{dist}</small>}
              </button>
            )
          })}
        </div>
        {filteredTos.length === 0 && (
          <p className="bk-sub">
            No destination matches “{query.trim()}”. Check the spelling or pick
            from the full list.
          </p>
        )}

        {to && fareState === 'ready' && (
          <div className="bk-fare">
            <span>
              Fixed fare
              <small>Same price for everyone, every time.</small>
            </span>
            <b>₦{Number(fare).toLocaleString('en-NG')}</b>
          </div>
        )}

        {to && fareState === 'loading' && (
          <p className="bk-sub">
            <span className="bk-spin dark" aria-hidden="true" />
            Estimating your fare…
          </p>
        )}

        {to && fareState === 'missing' && (
          <div className="error">No fare is set for this route yet.</div>
        )}

        {to && routeEta && (
          <p className="bk-sub">
            ≈ {Math.max(1, Math.round(routeEta.seconds / 60))} min by road
            {' '}(OpenStreetMap/OSRM estimate)
          </p>
        )}

        {message && (
          <div className="error" role="alert">
            {message}
          </div>
        )}

        <button
          type="button"
          className="bk-cta"
          disabled={!to || fare === null || booking}
          onClick={createRide}
        >
          {booking && <span className="bk-spin" aria-hidden="true" />}
          {booking ? 'Creating ride…' : 'Continue'}
        </button>
      </>
    )
  }

  function rideBody() {
    const status = activeRide.status
    const copy = STATUS_COPY[status] ?? {
      title: `Ride status: ${String(status).replaceAll('_', ' ')}`,
      body: 'Your booking status has changed.',
    }
    const canCancel = ['searching', 'accepted', 'paid'].includes(status)
    const isFinished = ['completed', 'cancelled', 'refunded'].includes(status)
    const rideFare = Number(activeRide.fare ?? fare ?? 0).toLocaleString('en-NG')

    // Mockup 6b — a dedicated "no keke" screen instead of a status line.
    if (activeRide.noRide) {
      return (
        <div className="bk-empty">
          <div className="bk-empty-icon" aria-hidden="true">!</div>
          <h3>No keke available</h3>
          <p className="bk-sub">
            We couldn’t find an eligible Keke to accept your request right now.
            Please try again shortly.
          </p>
          <button type="button" className="bk-cta" onClick={tryAgain}>
            Try again
          </button>
          <Link className="btn secondary bk-cta" to="/student">
            Return to Home
          </Link>
        </div>
      )
    }

    // Honest trip progress: distance remaining to the destination compared
    // with the straight-line length of the whole route (needs the student's
    // location; hidden entirely when it is unavailable).
    let tripProgress = null
    if (
      status === 'on_trip' &&
      geo.position &&
      validCoord(activeRide.from) &&
      validCoord(activeRide.to)
    ) {
      const total = distanceMeters(activeRide.from, activeRide.to)
      const remaining = distanceMeters(geo.position, activeRide.to)
      if (total > 0) {
        tripProgress = Math.min(100, Math.max(0, Math.round((1 - remaining / total) * 100)))
      }
    }

    const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`

    return (
      <>
        <p className="bk-step">{copy.title}</p>
        <p className="bk-sub">{copy.body}</p>

        {(activeRide.from || activeRide.to) && (
          <div className="bk-route" style={{ cursor: 'default' }}>
            <span className="bk-route-dots" aria-hidden="true">
              <span className="bk-dot" />
              <span className="bk-dot-line" />
              <span className="bk-dot to" />
            </span>
            <span className="bk-route-text">
              <b>
                {activeRide.from?.name ?? from?.name ?? 'Pick-up'} →{' '}
                {activeRide.to?.name ?? to?.name ?? 'Destination'}
              </b>
              <span>₦{rideFare} fixed fare</span>
            </span>
          </div>
        )}

        {assignedKeke && (
          <div className="bk-rider">
            <span>
              <span className="muted">Your rider</span>
              <br />
              <b>Assigned rider</b>
            </span>
            {assignedKeke.keke_number && (
              <span className="plate">{assignedKeke.keke_number}</span>
            )}
          </div>
        )}

        {status === 'searching' && (
          <p className="bk-sub" role="status" aria-live="polite">
            <span className="bk-spin dark" aria-hidden="true" />
            Searching · <span className="bk-count">{mmss}</span> — offering your
            trip to eligible riders one at a time. Keep this screen open.
          </p>
        )}

        {tripProgress !== null && (
          <div className="bk-progress" aria-hidden="true">
            <i style={{ width: `${tripProgress}%` }} />
          </div>
        )}

        {activeRide.booking_code && (
          <p className="bk-sub">
            Booking code: <b>{activeRide.booking_code}</b>
          </p>
        )}

        {statusError && (
          <div className="error" role="alert">
            {statusError}
          </div>
        )}
        {message && (
          <div className="error" role="alert">
            {message}
          </div>
        )}

        {status === 'accepted' && (
          <Link className="btn bk-cta" to={`/student/pay/${activeRide.id}`}>
            Pay ₦{rideFare} with Paystack
          </Link>
        )}

        {['accepted', 'paid', 'arrived', 'on_trip'].includes(status) && (
          <Link className="btn secondary bk-cta" to={`/student/verify/${activeRide.id}`}>
            Show keke I booked
          </Link>
        )}

        {['paid', 'arrived', 'on_trip', 'completed'].includes(status) && (
          <Link className="btn secondary bk-cta" to={`/student/ride/${activeRide.id}`}>
            Open live ride screen
          </Link>
        )}

        {status === 'completed' && (
          <>
            <Link className="btn secondary bk-cta" to={`/student/review/${activeRide.id}`}>
              Rate this ride
            </Link>
            <Link className="btn secondary bk-cta" to={`/student/report/${activeRide.id}`}>
              Report a problem with this keke
            </Link>
          </>
        )}

        {canCancel && !confirmCancel && (
          <button
            type="button"
            className="secondary bk-cta"
            onClick={() => setConfirmCancel(true)}
          >
            Cancel this ride
          </button>
        )}

        {canCancel && confirmCancel && (
          <div className="card" style={{ marginTop: 12 }}>
            <b>Cancel this ride?</b>
            <p className="muted">
              {status === 'paid'
                ? 'Your payment will be refunded through Paystack. Bank processing can take a little while.'
                : 'This cannot be undone.'}
            </p>
            <button type="button" disabled={cancelling} onClick={cancelRide}>
              {cancelling ? 'Cancelling…' : 'Yes, cancel the ride'}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setConfirmCancel(false)}
            >
              Keep the ride
            </button>
          </div>
        )}

        {isFinished && (
          <button type="button" className="secondary bk-cta" onClick={tryAgain}>
            Book another ride
          </button>
        )}
        {isFinished && (
          <Link className="btn secondary bk-cta" to="/student">
            Return to Home
          </Link>
        )}
      </>
    )
  }

  const sheetTitle = activeRide
    ? activeRide.noRide
      ? 'No keke available'
      : STATUS_COPY[activeRide.status]?.title ?? 'Your booking'
    : stage === 'from'
      ? isDrop
        ? 'Book a Drop'
        : 'Book Along'
      : 'Choose destination'

  // Dim the map while the app is deciding (searching / awaiting payment),
  // matching the mockup's overlay treatment.
  const dimMap =
    Boolean(activeRide) && ['searching', 'accepted'].includes(activeRide.status)

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  return (
    <div className="bk" style={{ ['--bk-sheet']: sheetBottomCss }}>
      <div className="bk-map">
        <CampusMap
          key={mapAttempt}
          ref={mapRef}
          points={mapPoints}
          kekes={mapKekes}
          route={routeLine}
          height="100%"
          animate
          selectedId={selectedId}
          userLocation={geo.position}
          userAccuracy={geo.accuracy}
          onSelect={(point) => {
            if (activeRide) return
            if (stage === 'from' && point.kind === fromKind) pickPickup(point)
            else if (stage === 'to' && point.kind === 'destination') {
              pickDestination(point)
            } else if (stage === 'to' && point.kind === fromKind) {
              // Tapping another pick-up point while choosing the destination
              // returns to step 1 with that point selected.
              pickPickup(point)
            }
          }}
          onRouteInfo={setRouteEta}
          onFail={() => setMapFailed(true)}
        />
      </div>

      {dimMap && <div className="bk-dim" aria-hidden="true" />}

      {activeRide && routeEta && (
        <div className="bk-pill">
          ≈ {Math.max(1, Math.round(routeEta.seconds / 60))} min by road
        </div>
      )}

      <div className="bk-top">
        <Link className="bk-back" to="/student/book" aria-label="Back">
          ‹
        </Link>
        <div className="bk-title">Danfolio · {isDrop ? 'Drop' : 'Along'}</div>
        <button
          type="button"
          className="bk-signout"
          onClick={signOut}
          aria-label="Sign out"
          title="Sign out"
        >
          ⏻
        </button>
      </div>

      {!online && (
        <div className="bk-offline" role="status">
          You’re offline — live updates are paused until the connection returns.
        </div>
      )}

      {!mapFailed && (
        <div
          className={'bk-fabs' + (sheetIndex >= SHEET_SNAPS.length - 1 ? ' bk-fabs-off' : '')}
          style={{ bottom: sheetBottomCss }}
        >
          <button
            type="button"
            className="bk-fab"
            aria-label="Zoom in"
            onClick={() => mapRef.current?.zoomIn()}
          >
            +
          </button>
          <button
            type="button"
            className="bk-fab"
            aria-label="Zoom out"
            onClick={() => mapRef.current?.zoomOut()}
          >
            −
          </button>
          <button
            type="button"
            className="bk-fab"
            aria-label="My location"
            onClick={recenterNow}
          >
            ◎
          </button>
        </div>
      )}

      {mapFailed && (
        <div className="bk-fabs" style={{ bottom: sheetBottomCss }}>
          <button
            type="button"
            className="bk-fab"
            aria-label="Retry loading the map"
            title="Retry loading the map"
            onClick={() => {
              setMapFailed(false)
              setMapAttempt((n) => n + 1)
            }}
          >
            ⟳
          </button>
        </div>
      )}

      {locState === 'loading' && (
        <div className="bk-loading" role="status">
          <span className="bk-spin dark" aria-hidden="true" />
          Loading campus locations…
        </div>
      )}

      {locState === 'error' && (
        <div className="bk-loading" role="alert">
          <p>We could not load the campus points. Check your connection.</p>
          <button
            type="button"
            className="secondary"
            style={{ maxWidth: 220 }}
            onClick={() => setLocAttempt((n) => n + 1)}
          >
            Try again
          </button>
        </div>
      )}

      <BottomSheet
        snaps={SHEET_SNAPS}
        index={sheetIndex}
        onIndexChange={setSheetIndex}
        ariaLabel="Booking details"
        header={
          <>
            <div className="bk-step" style={{ margin: 0 }}>
              {sheetTitle}
            </div>
          </>
        }
      >
        {activeRide ? rideBody() : planningBody()}
      </BottomSheet>
    </div>
  )
}
