import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import CampusMap from '../../components/CampusMap.jsx'
import BottomSheet from '../../components/BottomSheet.jsx'
import { supabase } from '../../lib/supabase'
import { useGeolocation } from '../../lib/useGeolocation'
import { distanceMeters, formatDistance, validCoord } from '../../lib/geo'
import { formatDuration, shouldReroute } from '../../lib/routing'
import { positionFreshness, proximityState, estimateArrivalSeconds } from '../../lib/tracking'
// ONE source of truth with start-payment — the fee shown here is the fee
// charged at checkout (no drift between booking and payment).
import { SERVICE_FEE_NGN, rideTotal } from '../../../supabase/functions/_shared/policy.js'
import './book.css'

// BookFlow — the full-screen Bolt-style booking screen for both Drop and Along.
//
// The map IS the screen: it fills the viewport, with a floating glass top bar
// and a draggable bottom sheet (pickup / destination / fare / booking controls)
// layered on top. Entering without a mode (the "Book a ride" button) opens the
// mockup's "How do you want to ride?" sheet over this same map — there is no
// separate choose-type page — and picking Drop or Along continues in place.
// The entire booking contract from the previous version is
// preserved: the create-ride Edge Function is still the ONLY way a ride is
// created, dispatch states (searching / no_ride_available) are handled the
// same way, errors are extracted the same way, and ride status follows via
// Realtime with polling fallback.
//
// Data sources (all real, no fake markers):
//   - locations / fares        admin-managed tables (Supabase), grouped by
//                              the admin's `category` label with search
//   - nearby keke riders       every `kekes` row with real coordinates and a
//                              fresh heartbeat (online or already carrying
//                              passengers), updated live via Realtime
//                              (15s poll fallback)
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

// Locations arrive already grouped by the admin's category label; anything
// without one lands in a visible "Other" group instead of vanishing.
function groupByCategory(list) {
  const groups = new Map()
  for (const location of list) {
    const key = (location.category ?? '').trim() || 'Other'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(location)
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}

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

export default function BookFlow({ initialMode = null }) {
  const geo = useGeolocation()
  const routerLocation = useLocation()
  const navigate = useNavigate()

  // No mode yet = the mockup's Drop/Along sheet over the map. Choosing one
  // flips this state and the booking continues on the same map, no reload.
  const [mode, setMode] = useState(initialMode)
  const choosingType = mode === null

  const [locations, setLocations] = useState([])
  const [locState, setLocState] = useState('loading') // loading | ready | error
  const [locAttempt, setLocAttempt] = useState(0)

  const [from, setFrom] = useState(null)
  const [to, setTo] = useState(null)
  const [fare, setFare] = useState(null)
  const [fareState, setFareState] = useState('idle') // idle | loading | ready | missing

  const [fromConfirmed, setFromConfirmed] = useState(false)
  const [query, setQuery] = useState('')
  const [fromQuery, setFromQuery] = useState('')
  const [sheetIndex, setSheetIndex] = useState(0)
  const [message, setMessage] = useState('')
  const [booking, setBooking] = useState(false)
  const [elapsed, setElapsed] = useState(0)

  const [activeRide, setActiveRide] = useState(null)
  const [statusError, setStatusError] = useState('')
  // True while we check whether this student already has a running ride
  // (blocks the booking CTA so the race is never user-visible).
  const [joining, setJoining] = useState(true)
  // Set when we land on an existing ride *instead of* the booking form —
  // the "you already have an active ride" notice + Return button.
  const [showActiveNotice, setShowActiveNotice] = useState(false)

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

      let request = supabase
        .from('locations')
        .select('id, name, kind, category, lat, lng')
        .eq('active', true)

      // While the ride type is still open we load every active point so the
      // map behind the sheet has the whole campus on it.
      if (mode) request = request.eq('mode', mode)

      const { data, error } = await request.order('category').order('name')

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
  // Quick chip / recent-ride deep link: the home screen passes the chosen
  // destination here so the student lands straight in step 2 with it filled.
  // ------------------------------------------------------------------
  const presetAppliedRef = useRef(false)

  useEffect(() => {
    const preset = routerLocation.state?.presetTo
    if (!preset || presetAppliedRef.current || locState !== 'ready') return

    presetAppliedRef.current = true
    const match = locations.find(
      (l) => l.kind === 'destination' && l.name.toLowerCase() === String(preset).toLowerCase(),
    )

    if (match) {
      setTo(match)
      navigate('/student/book', { state: null, replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routerLocation.state, locState, locations])

  // A pre-selected destination only survives if it actually exists in the
  // ride type the student just picked (Drop and Along have separate lists).
  useEffect(() => {
    if (choosingType || locState !== 'ready' || !to) return
    if (locations.some((l) => l.id === to.id)) return
    setTo(null)
    setFare(null)
    setFareState('idle')
  }, [choosingType, locState, locations, to])

  // ------------------------------------------------------------------
  // Rejoin an already-active booking on mount (e.g. returning to this page)
  // ------------------------------------------------------------------
  // NOTE: deliberately NO "joined once" ref here. Under React.StrictMode
  // (dev) this effect runs twice: the first run is cleaned up before its
  // response lands, so a once-guard would leave the second run with
  // nothing to do and the active-ride check (joining) permanently stuck,
  // disabling the booking CTA. The duplicate query in dev is harmless.
  useEffect(() => {
    let active = true

    async function joinActiveRide() {
      try {
        const { data } = await supabase
          .from('rides')
          .select(RIDE_SELECT)
          .order('created_at', { ascending: false })
          .limit(20)

        if (!active) return
        const row = (data ?? []).find((r) => ACTIVE_STATUSES.includes(r.status))
        if (row) {
          setActiveRide(row)
          setShowActiveNotice(true)
          setSheetIndex(1)
        }
      } finally {
        if (active) setJoining(false)
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
    () => (choosingType ? [] : locations.filter((l) => l.kind === fromKind)),
    [locations, fromKind, choosingType],
  )
  const tos = useMemo(
    () => (choosingType ? [] : locations.filter((l) => l.kind === 'destination' && l.name !== from?.name)),
    [locations, from?.name, choosingType],
  )

  // Nearest-first ordering once the student shares their location.
  const sortedFroms = useMemo(() => {
    if (!geo.position || !froms.length) return froms
    return [...froms].sort((a, b) => {
      const da = validCoord(a) ? distanceMeters(geo.position, a) : Infinity
      const db = validCoord(b) ? distanceMeters(geo.position, b) : Infinity
      return da - db
    })
  }, [froms, geo.position])

  // Search covers the name AND the category, so "hostel" surfaces the whole
  // Hostel group from either box (mockup "Search destinations").
  const matchesQuery = useCallback((location, raw) => {
    const q = raw.trim().toLowerCase()
    if (!q) return true
    return (
      location.name.toLowerCase().includes(q) ||
      (location.category ?? '').toLowerCase().includes(q)
    )
  }, [])

  const filteredFroms = useMemo(
    () => sortedFroms.filter((l) => matchesQuery(l, fromQuery)),
    [sortedFroms, fromQuery, matchesQuery],
  )
  const filteredTos = useMemo(
    () => tos.filter((l) => matchesQuery(l, query)),
    [tos, query, matchesQuery],
  )

  const fromGroups = useMemo(() => groupByCategory(filteredFroms), [filteredFroms])
  const toGroups = useMemo(() => groupByCategory(filteredTos), [filteredTos])

  // Planning stage: pick-up first (explicit "Confirm pick-up"), then
  // destination + fare ("Step 2 of 2") which books the ride.
  const stage = activeRide ? null : !from || !fromConfirmed ? 'from' : 'to'

  // The single closest pick-up point (only meaningful with location shared).
  const nearestId =
    geo.state === 'granted' && sortedFroms.length ? sortedFroms[0].id : null

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

  // Every keke with real coordinates — CampusMap colours each badge by
  // its heartbeat (live / updating slowly / offline), so the booking map
  // shows what actually exists without ever claiming a stale fix is live.
  const mapKekes = useMemo(() => {
    const assignedId = activeRide?.keke_id ?? null
    return kekes
      .filter((k) => validCoord(k))
      .map((k) => ({
        ...k,
        highlight: Boolean(assignedId) && k.id === assignedId,
      }))
  }, [kekes, activeRide?.keke_id])

  const assignedKeke = useMemo(
    () => (activeRide?.keke_id ? kekes.find((k) => k.id === activeRide.keke_id) ?? null : null),
    [kekes, activeRide?.keke_id],
  )

  // How far the assigned keke is from where the student is waiting.
  // Straight-line distance against the live position — a real measurement,
  // displayed to the student as a time-to-arrival (kekeArrivalEta), never
  // a made-up number. Hidden once the trip is under way (the progress bar
  // covers that) or when coordinates are missing.
  const kekeProximity = useMemo(() => {
    if (!assignedKeke || !validCoord(assignedKeke)) return null
    if (!['accepted', 'paid', 'arrived'].includes(activeRide?.status)) return null

    const atPickup = Boolean(activeRide?.from && validCoord(activeRide.from))
    const target = atPickup ? activeRide.from : geo.position
    if (!target) return null

    return {
      meters: distanceMeters(assignedKeke, target),
      label: atPickup ? 'from your pick-up' : 'from you',
    }
  }, [assignedKeke, activeRide?.status, activeRide?.from, geo.position])

  // Honest proximity phase for the badge above: only a LIVE heartbeat may
  // claim "nearby" or "approaching" — a stale/lost fix reports
  // "unavailable" with its real age instead of a made-up closeness.
  const kekePhase = useMemo(() => {
    if (!kekeProximity) return null
    const freshness = positionFreshness(assignedKeke?.last_seen)
    return {
      freshness,
      state: proximityState({
        distance: kekeProximity.meters,
        fresh: freshness.state === 'live',
      }),
    }
  }, [kekeProximity, assignedKeke?.last_seen])

  const mapPoints = useMemo(() => {
    if (activeRide) {
      return [activeRide.from, activeRide.to].filter((p) => validCoord(p))
    }
    // Ride-type sheet open: the whole campus sits behind the dim overlay.
    if (choosingType) return locations.filter((p) => validCoord(p))
    if (to) return [from, to].filter((p) => validCoord(p))
    if (from) return [from, ...tos].filter((p) => validCoord(p))
    return froms.filter((p) => validCoord(p))
  }, [activeRide, choosingType, locations, from, to, froms, tos])

  // Phase-aware route (spec 5/7): while the assigned rider heads over, the
  // real road path runs keke → pick-up; otherwise (planning, searching,
  // on trip) it runs pick-up → destination. A road route is only
  // re-requested after a real ≥30 m origin move (shouldReroute), so live
  // GPS ticks don't hammer the routing provider.
  const routeRef = useRef(null)
  const routeLine = useMemo(() => {
    let desired = null

    if (activeRide) {
      const kekePos =
        assignedKeke && validCoord(assignedKeke)
          ? { lat: Number(assignedKeke.lat), lng: Number(assignedKeke.lng) }
          : null
      if (
        ['accepted', 'paid', 'arrived'].includes(activeRide.status) &&
        kekePos &&
        validCoord(activeRide.from)
      ) {
        desired = { from: kekePos, to: activeRide.from }
      } else if (validCoord(activeRide.from) && validCoord(activeRide.to)) {
        desired = { from: activeRide.from, to: activeRide.to }
      }
    } else if (validCoord(from) && validCoord(to)) {
      desired = { from, to }
    }

    if (!desired) {
      routeRef.current = null
      return null
    }

    const destKey = String(desired.to?.id ?? `${desired.to.lat},${desired.to.lng}`)
    const gate = routeRef.current
    if (gate && gate.destKey === destKey && gate.route && !shouldReroute(desired.from, gate.origin)) {
      return gate.route // same object → the map does not re-fetch
    }
    routeRef.current = { origin: desired.from, destKey, route: desired }
    return desired
  }, [activeRide, assignedKeke, from, to])

  // Which leg the current ETA measures — used so the pill's words always
  // match the line drawn on the map (never label a full-route estimate as
  // a keke arrival time).
  const etaIsKekeLeg = Boolean(
    activeRide &&
      ['accepted', 'paid', 'arrived'].includes(activeRide.status) &&
      assignedKeke &&
      validCoord(assignedKeke),
  )

  // Time-to-arrival for the proximity badge (the user wants minutes, not
  // metres): the road ETA when the router answered for the keke leg,
  // otherwise an honest estimate scaled from the REAL measured distance.
  // Null without a distance — never a number from nothing.
  const kekeArrivalEta = useMemo(() => {
    if (!kekeProximity || !Number.isFinite(kekeProximity.meters)) return null
    const roadSeconds =
      etaIsKekeLeg && Number.isFinite(routeEta?.seconds) && routeEta.seconds > 0
        ? routeEta.seconds
        : null
    const estimateSeconds = estimateArrivalSeconds({
      distanceMeters: kekeProximity.meters,
    })
    const seconds = roadSeconds ?? estimateSeconds
    if (seconds === null) return null
    return { seconds, source: roadSeconds !== null ? 'road' : 'estimate' }
  }, [kekeProximity, etaIsKekeLeg, routeEta?.seconds])

  const selectedId = activeRide ? null : (to?.id ?? from?.id ?? null)

  // FAB / attribution offset tracks the sheet's visible height. The
  // ride-type sheet is one fixed snap; everything else drags.
  const CHOOSING_SNAP = 0.56
  const snap = choosingType
    ? CHOOSING_SNAP
    : SHEET_SNAPS[Math.min(sheetIndex, SHEET_SNAPS.length - 1)]
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
  // One fare lookup shared by picking a destination and re-pricing after a
  // different pick-up is chosen (a quick chip can pre-fill the destination).
  const fareReqRef = useRef(0)

  async function fetchFare(fromLoc, toLoc) {
    const requestId = (fareReqRef.current += 1)

    const { data, error } = await supabase
      .from('fares')
      .select('amount')
      .eq('mode', mode)
      .eq('from_id', fromLoc.id)
      .eq('to_id', toLoc.id)
      .maybeSingle()

    if (requestId !== fareReqRef.current) return // a newer choice won

    if (error) {
      setFare(null)
      setFareState('missing')
      setMessage(error.message)
      return
    }

    const amount = data?.amount ?? null
    setFare(amount)
    setFareState(amount === null || amount === undefined ? 'missing' : 'ready')
  }

  // Mockup artboard 3: the Drop/Along choice is a sheet over this map, so
  // picking one continues on the same screen — no navigation, no remount.
  function chooseMode(next) {
    setMode(next)
    setFrom(null)
    setFromConfirmed(false)
    setFare(null)
    setFareState('idle')
    setQuery('')
    setFromQuery('')
    setMessage('')
    setSheetIndex(1)
  }

  function pickPickup(location) {
    const changed = location.id !== from?.id

    if (changed) {
      setMessage('')
      if (to) {
        // A destination is already chosen (quick chip, or re-picking the
        // pick-up): keep it and re-price the route for this pick-up instead
        // of throwing the student's choice away.
        setFare(null)
        setFareState('loading')
        fetchFare(location, to)
      } else {
        setFare(null)
        setFareState('idle')
      }
      setFromConfirmed(false)
    }

    setFrom(location)
  }

  async function pickDestination(location) {
    setTo(location)
    setFare(null)
    setFareState('loading')
    setMessage('')
    setSheetIndex((i) => Math.max(i, 1))

    if (from) await fetchFare(from, location)
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
      setShowActiveNotice(false)
    } catch (error) {
      let detail = error?.message || 'Could not create your ride.'
      let existingRideId = null

      if (error?.context && typeof error.context.clone === 'function') {
        try {
          const payload = await error.context.clone().json()
          detail = payload?.error || payload?.message || detail
          if (payload?.ride_id) existingRideId = payload.ride_id
        } catch {}
      }

      // 409 — this student already has a running ride. Load THAT ride so
      // the screen shows it (with the Return to Active Ride button) instead
      // of a dead-end error message.
      if (existingRideId) {
        const row = await fetchRide(existingRideId)
        if (row) {
          setShowActiveNotice(true)
          setSheetIndex(1)
          setMessage('')
          return
        }
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
    setShowActiveNotice(false)
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
    // Back to the picker, expanded enough to actually show the list.
    setSheetIndex(1)
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

  // Both pickers render the same grouped shape: a category header with its
  // locations underneath (mockup's categorized destination list).
  function renderGroups(groups, selectedId, onPick, nearestId) {
    return groups.map(([category, items]) => (
      <div className="bk-group" key={category}>
        <p className="bk-cat">
          {category}
          <span>{items.length}</span>
        </p>
        <div className="bk-list">
          {items.map((location) => {
            const dist = locationDistance(location)
            return (
              <button
                key={location.id}
                className={'bk-opt' + (selectedId === location.id ? ' sel' : '')}
                onClick={() => onPick(location)}
              >
                <span style={{ display: 'flex', alignItems: 'center', minWidth: 0, gap: 8 }}>
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {location.name}
                  </span>
                  {nearestId === location.id && <span className="bk-near">Near you</span>}
                </span>
                {dist && <small>{dist}</small>}
              </button>
            )
          })}
        </div>
      </div>
    ))
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
            geo.state === 'insecure' ||
            geo.state === 'unavailable' ||
            geo.state === 'timeout') && (
            <p className="bk-sub">
              {geo.state === 'insecure'
                ? 'Location is blocked because this page is open over plain http:// — open the app over HTTPS. You can still pick any point from the list.'
                : geo.state === 'denied'
                  ? 'Location access is off — you can still pick any point from the list.'
                  : 'We could not get your location — you can still pick any point from the list.'}{' '}
              {/* Retrying cannot fix an insecure origin — only HTTPS can. */}
              {geo.state !== 'insecure' && (
                <button
                  type="button"
                  className="link"
                  style={{ display: 'inline', height: 'auto', margin: 0 }}
                  onClick={geo.request}
                >
                  Try again
                </button>
              )}
            </p>
          )}

          <input
            className="bk-search"
            type="search"
            placeholder={isDrop ? 'Search pick-up points' : 'Search stations'}
            aria-label="Search pick-up locations"
            value={fromQuery}
            onChange={(e) => setFromQuery(e.target.value)}
          />

          {renderGroups(fromGroups, from?.id, pickPickup, nearestId)}

          {fromGroups.length === 0 && (
            <p className="bk-sub">
              No pick-up matches “{fromQuery.trim()}”. Check the spelling or
              pick from the full list.
            </p>
          )}

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

        {renderGroups(toGroups, to?.id, pickDestination, null)}

        {filteredTos.length === 0 && (
          <p className="bk-sub">
            No destination matches “{query.trim()}”. Check the spelling or pick
            from the full list.
          </p>
        )}

        {to && fareState === 'ready' && (
          <>
            <div className="bk-fare">
              <span>
                Fixed fare
                <small>Same price for everyone, every time.</small>
              </span>
              <b>₦{Number(fare).toLocaleString('en-NG')}</b>
            </div>
            <p className="bk-sub bk-fee-note">
              + ₦{SERVICE_FEE_NGN} service fee ={' '}
              <strong>₦{rideTotal(Number(fare), SERVICE_FEE_NGN).toLocaleString('en-NG')}</strong>{' '}
              total at payment. Your Keke receives the full fare.
            </p>
          </>
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

        {to && routeEta?.seconds != null && (
          <p className="bk-sub">
            ≈ {formatDuration(routeEta.seconds)} by road
            {' '}(road estimate from OpenStreetMap/OSRM)
          </p>
        )}

        {joining && (
          <p className="bk-sub" role="status">
            <span className="bk-spin dark" aria-hidden="true" />
            Checking for an active ride…
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
          disabled={!to || fare === null || booking || joining}
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
        {/* The student came here to book; this running ride is why they
            can't. Explain it and take them straight to the real ride. */}
        {showActiveNotice && !isFinished && (
          <div className="bk-already" role="status">
            <b>You already have an active ride</b>
            <p>
              A booking is still running — you can’t start another one until
              it finishes or is cancelled.
            </p>
            <Link className="btn bk-cta" to={`/student/ride/${activeRide.id}`}>
              Return to Active Ride
            </Link>
          </div>
        )}

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

        {/* Live proximity of the assigned keke — straight-line distance to
            wherever the student is waiting, straight from its heartbeat.
            The state word (nearby / approaching) only appears while the
            heartbeat is live; a stale or missing fix says so instead. */}
        {kekeProximity && kekePhase && (
          <p
            className={'bk-proximity' + (kekePhase.state === 'unavailable' ? ' off' : '')}
            role="status"
          >
            {kekePhase.state === 'unavailable' ? (
              <>
                <span className="bk-live dim" aria-hidden="true" />
                Keke location unavailable — {kekePhase.freshness.label}
              </>
            ) : (
              <>
                <span className="bk-live" aria-hidden="true" />
                {/* Time-to-arrival, not metres — same honest wording as
                    the ride screen; the phase word stays beside it. */}
                {kekeArrivalEta
                  ? `Keke reaching you in ≈ ${formatDuration(kekeArrivalEta.seconds)}${
                      kekeArrivalEta.source === 'road' ? ' by road' : ' (distance estimate)'
                    }`
                  : `Keke ${formatDistance(kekeProximity.meters)} ${kekeProximity.label}`}
                {kekePhase.state !== 'far' && (
                  <>
                    {' · '}
                    <b>{kekePhase.state}</b>
                  </>
                )}
              </>
            )}
          </p>
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

        {['paid', 'arrived', 'on_trip', 'completed'].includes(status) && (
          <Link className="btn secondary bk-cta" to={`/student/ticket/${activeRide.id}`}>
            Open ticket
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

  const sheetTitle = choosingType
    ? 'How do you want to ride?'
    : activeRide
    ? activeRide.noRide
      ? 'No keke available'
      : STATUS_COPY[activeRide.status]?.title ?? 'Your booking'
    : stage === 'from'
      ? isDrop
        ? 'Book a Drop'
        : 'Book Along'
      : 'Choose destination'

  // Dim the map while the app is deciding (searching / awaiting payment) and
  // behind the ride-type sheet, matching the mockup's overlay treatment.
  const dimMap =
    choosingType ||
    (Boolean(activeRide) && ['searching', 'accepted'].includes(activeRide.status))

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
            if (activeRide || choosingType) return
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

      {activeRide && routeEta?.seconds != null && (
        <div className="bk-pill">
          {etaIsKekeLeg
            ? `Keke reaching you in ≈ ${formatDuration(routeEta.seconds)}`
            : activeRide.status === 'on_trip'
              ? `Trip ≈ ${formatDuration(routeEta.seconds)} by road`
              : `≈ ${formatDuration(routeEta.seconds)} by road`}
        </div>
      )}

      <div className="bk-top">
        {/* A real button: linking to the route we are already on is a
            no-op in the router (that is why this back control "did
            nothing" on the active-ride notice). Going home from the
            notice, or one step back to the type chooser from Drop/Along,
            always changes the screen. */}
        <button
          type="button"
          className="bk-back"
          aria-label="Back"
          onClick={() => {
            if (choosingType || activeRide) navigate('/student')
            else setMode(null)
          }}
        >
          ‹
        </button>
        <div className="bk-title">
          Danfolio ·{' '}
          {choosingType ? 'Book a ride' : isDrop ? 'Drop' : 'Along'}
        </div>
        {/* Sign-out lives on the Profile tab only — no scattered ⏻ buttons. */}
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

      {choosingType ? (
        // Mockup artboard 3: map + dim overlay + the Drop/Along sheet.
        // Choosing one continues on this same map — no separate page.
        <BottomSheet
          snaps={[CHOOSING_SNAP]}
          index={0}
          ariaLabel="Choose ride type"
          header={
            <div className="bk-step" style={{ margin: 0 }}>
              {sheetTitle}
            </div>
          }
        >
          <p className="bk-sub">
            Pick the ride type that fits your trip. You choose the exact
            points on the next step.
          </p>

          <button type="button" className="bk-type" onClick={() => chooseMode('drop')}>
            <span className="bk-type-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 21s-7-6.1-7-11a7 7 0 1 1 14 0c0 4.9-7 11-7 11z" />
                <circle cx="12" cy="10" r="2.5" />
              </svg>
            </span>
            <span className="bk-type-text">
              <b>Drop</b>
              <small>Door-to-door pickup</small>
            </span>
            <span className="bk-type-arrow" aria-hidden="true">›</span>
          </button>

          <button type="button" className="bk-type" onClick={() => chooseMode('along')}>
            <span className="bk-type-icon bk-type-icon-alt" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="6" r="2.5" />
                <circle cx="18" cy="18" r="2.5" />
                <path d="M6 8.5v4a5 5 0 0 0 5 5h4.5" />
              </svg>
            </span>
            <span className="bk-type-text">
              <b>Along</b>
              <small>Join at a ride station</small>
            </span>
            <span className="bk-type-arrow" aria-hidden="true">›</span>
          </button>
        </BottomSheet>
      ) : (
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
      )}
    </div>
  )
}
