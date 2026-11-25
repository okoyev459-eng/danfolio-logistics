import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../lib/auth.jsx'
import { supabase } from '../../lib/supabase'
import CampusMap from '../../components/CampusMap.jsx'
import { distanceMeters, validCoord } from '../../lib/geo'
import { shouldReroute } from '../../lib/routing'
import { positionFreshness } from '../../lib/tracking'
import { useRideTracking } from '../../lib/useRideTracking'
import {
  notificationPermission,
  requestNotificationPermission,
  useOfferNotice,
} from '../../lib/notify'
// ONE source of truth shared with dispatch_next_ride_request() and
// respond_to_ride_request() on the server — the seat count can never drift
// between the app and the dispatcher.
import { MAX_ACTIVE_RIDES, canInterrupt, canRedispatch } from '../../../supabase/functions/_shared/policy.js'
import './home.css'
import './request.css'

const tabs = ['Home', 'Trips', 'Earnings', 'Profile']

// Active-trip selects. The interruption columns (interrupted_at /
// interrupted_reason / replacement_at) only exist once the rider
// cancellation migration is applied, so we probe for them ONCE and fall
// back to the base columns on a database that does not have them yet —
// without re-probing (and logging a400) on every poll. Statuses and
// ordering are identical either way; only the incident banner (which reads
// those columns) is unavailable before the migration.
const TRIP_SELECT_BASE = `
  id, status, fare, mode, booking_code, student_id, created_at,
  from:locations!rides_from_id_fkey(name, lat, lng),
  to:locations!rides_to_id_fkey(name, lat, lng),
  tickets:tickets(ticket_no, status)
`
const TRIP_SELECT_WITH_INCIDENT = `
  id, status, fare, mode, booking_code, student_id, created_at,
  interrupted_at, interrupted_reason, replacement_at,
  from:locations!rides_from_id_fkey(name, lat, lng),
  to:locations!rides_to_id_fkey(name, lat, lng),
  tickets:tickets(ticket_no, status)
`

// null = unknown yet; false = this database predates the migration.
let incidentColumnsAvailable = null

async function fetchActiveTrips(kekeId) {
  const usedIncidentSelect = incidentColumnsAvailable !== false
  const selectColumns = usedIncidentSelect ? TRIP_SELECT_WITH_INCIDENT : TRIP_SELECT_BASE

  let { data, error } = await supabase
    .from('rides')
    .select(selectColumns)
    .eq('keke_id', kekeId)
    .in('status', ['accepted', 'paid', 'arrived', 'on_trip'])
    .order('created_at', { ascending: true })

  // 42703 = undefined_column: the migration adding the interruption
  // columns has not been applied to this database yet. Remember it for
  // every later load in this session, then retry with the base columns.
  if (error?.code === '42703') {
    incidentColumnsAvailable = false
    ;({ data, error } = await supabase
      .from('rides')
      .select(TRIP_SELECT_BASE)
      .eq('keke_id', kekeId)
      .in('status', ['accepted', 'paid', 'arrived', 'on_trip'])
      .order('created_at', { ascending: true }))
  } else if (!error && usedIncidentSelect) {
    // Only a SUCCESSFUL full select proves the columns exist — a base-select
    // success must never flip the flag back (that caused a probe loop).
    incidentColumnsAvailable = true
  }

  return { data, error }
}

function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null)

    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lng: coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 15000 }
    )
  })
}

// "H:MM:SS" of this riding session — real time since the rider went online in
// this app session (or since last_seen when already online at load). Never
// faked: no session → "—".
function formatSession(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

// Countdown ring for the offer modal (mockup K3/K5): a real SVG ring sized
// from the request's own sent_at -> expires_at window. The timer reads
// GREEN for an Along request and brand blue for a Drop, so the two request
// types are tellable apart at a glance (task: along timer ≠ drop colour).
function OfferRing({ secondsLeft, totalSeconds, along = false }) {
  const r = 58
  const circumference = 2 * Math.PI * r // ≈ 364.4 (mockup uses 365)
  const fraction = Math.max(0, Math.min(1, secondsLeft / Math.max(1, totalSeconds)))
  const mmss = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`
  const ringColor = along ? '#16A34A' : '#2563EB'
  const trackColor = along ? '#DCFCE7' : '#DBEAFE'

  return (
    <svg
      width="140"
      height="140"
      viewBox="0 0 140 140"
      role="img"
      aria-label={`${secondsLeft} seconds left`}
      style={{ display: 'block', margin: '0 auto' }}
    >
      <circle cx="70" cy="70" r={r} fill="none" stroke={trackColor} strokeWidth="10" />
      <circle
        cx="70"
        cy="70"
        r={r}
        fill="none"
        stroke={ringColor}
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={Math.round(circumference)}
        strokeDashoffset={Math.round(circumference * (1 - fraction))}
        transform="rotate(-90 70 70)"
      />
      <text
        x="70"
        y="80"
        textAnchor="middle"
        fontFamily="Poppins, sans-serif"
        fontWeight="700"
        fontSize="34"
        fill="#1E3A8A"
      >
        {mmss}
      </text>
    </svg>
  )
}

// 4-digit booking-code entry (mockup K7): real input, visual boxes on top.
function CodeBoxes({ value, onChange, onSubmit, busy }) {
  return (
    <div className="ko-code">
      <div className="ko-code-boxes" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={value.length === i ? 'cur' : ''}>
            {value[i] ?? ''}
          </span>
        ))}
      </div>
      <input
        className="ko-code-input"
        inputMode="numeric"
        pattern="\d{4}"
        maxLength={4}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.length === 4 && !busy) onSubmit()
        }}
        placeholder="Booking code"
        aria-label="4-digit booking code"
      />
    </div>
  )
}

// Tracking status chip (spec sections 6/10): what the rider's device is
// actually doing right now — real permission/publish states, never a fake
// "sharing" light. `now` comes from the parent's 250ms clock for the
// freshness label.
function TrackingChip({ tracking, now }) {
  const { phase, lastPublishedAt, error, retry } = tracking
  if (phase === 'idle') return null

  const fresh = positionFreshness(lastPublishedAt, { now })

  let tone = 'live'
  let text = ''

  if (phase === 'starting') {
    tone = 'wait'
    text = 'Starting live location…'
  } else if (phase === 'sharing') {
    tone = fresh.state === 'live' ? 'live' : fresh.state === 'stale' ? 'wait' : 'bad'
    text =
      fresh.state === 'live'
        ? `Sharing live location · ${fresh.label}`
        : `Sharing paused · ${fresh.label}`
  } else if (phase === 'denied') {
    tone = 'bad'
    text =
      'Location access is blocked — students cannot see your keke. Allow location for this site, then retry.'
  } else if (phase === 'insecure') {
    tone = 'bad'
    // Plain-http origins are never "allowed": the browser refuses location
    // without prompting (the phone loads http://<lan-ip>:5175 while the
    // laptop's localhost is exempt). Say the real cause and the real fix.
    text =
      'Location is blocked because this page is open over plain http:// — browsers only allow location on secure (HTTPS) pages. Open the app over HTTPS, then reload.'
  } else if (phase === 'unsupported') {
    tone = 'bad'
    text = 'This device cannot share location (Geolocation API unavailable).'
  } else if (phase === 'blocked') {
    tone = 'flat'
    text = 'Live tracking is not enabled yet — the database update has not been applied.'
  } else if (phase === 'error') {
    tone = 'bad'
    text = `Location update failed${error ? `: ${error}` : ''}`
  }

  return (
    <p className={`kr-track ${tone}`} role="status">
      <span className="kr-track-dot" aria-hidden="true" />
      <span>{text}</span>
      {(phase === 'denied' || phase === 'error' || phase === 'blocked') && (
        <button type="button" onClick={retry}>
          Retry
        </button>
      )}
    </p>
  )
}

export default function KekeHome() {
  const { session, signOut } = useAuth()
  const userId = session?.user?.id

  const [rider, setRider] = useState(null)
  const [online, setOnline] = useState(false)
  const [onlineSince, setOnlineSince] = useState(null)
  const [presenceBusy, setPresenceBusy] = useState(false)
  // Mirrors of the live presence flags for the background/logout listener,
  // which is registered once (deps [userId]) and must read current values.
  // Assigned below, where `online` / `onTrip` are derived.
  const onlineRef = useRef(false)
  const onTripRef = useRef(false)
  const [offer, setOffer] = useState(null)
  // New-request notification opt-in (a tap, because browsers only grant
  // permission from a user gesture). 'unsupported' hides the control.
  const [notifPerm, setNotifPerm] = useState(() => notificationPermission())
  const [now, setNow] = useState(Date.now())
  const [tab, setTab] = useState('Home')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [handledExpiry, setHandledExpiry] = useState('')
  // Every ride this rider is carrying right now — a keke holds MAX_ACTIVE_RIDES
  // at once, so this is a list, not a single trip. `selectedTripId` decides
  // which one the full-screen trip views (K6/K7/K8) act on.
  const [activeTrips, setActiveTrips] = useState([])
  const [selectedTripId, setSelectedTripId] = useState(null)
  const [tripStudents, setTripStudents] = useState({})
  // Per-trip boarding codes (each arrived trip has its own student code).
  const [tripCodes, setTripCodes] = useState({})
  const [tripEta, setTripEta] = useState(null)
  const [stations, setStations] = useState([])
  const [stationChoice, setStationChoice] = useState('')
  const [queuePosition, setQueuePosition] = useState(null)
  const [trips, setTrips] = useState(null)
  const [earnings, setEarnings] = useState(null)
  const [earnPeriod, setEarnPeriod] = useState('week')
  // 'map' = the full-screen mockup trip views (K6/K7/K8); 'card' = the
  // compact trip queue. The back button on the trip screens returns here.
  const [tripView, setTripView] = useState('map')

  // A keke carries MAX_ACTIVE_RIDES passengers (excluding the rider): the
  // dispatcher offers rides to free ('online') riders AND to riders already
  // carrying some ('on_trip'), as long as fewer than MAX_ACTIVE_RIDES rides
  // are held. `online` keeps meaning "free and fresh"; these flags are the
  // broader availability picture.
  const unavailable = rider?.status === 'unavailable'
  const onTrip = rider?.status === 'on_trip'
  const atCapacity = activeTrips.length >= MAX_ACTIVE_RIDES
  // Availability mirrors for the one-shot background listener (see above).
  onlineRef.current = online
  onTripRef.current = onTrip
  // Available for another offer: on duty (online, or on_trip with a fresh
  // heartbeat) and holding fewer than MAX_ACTIVE_RIDES rides. The server
  // enforces the same gate — this only mirrors it for the UI.
  const availableForWork = Boolean(rider) && (online || onTrip) && !atCapacity
  // Heartbeat runs for every rider on duty — the dispatcher only offers
  // rides to riders seen in the last 75 seconds, on_trip included.
  const heartbeatOn = Boolean(rider) && (online || onTrip)

  useEffect(() => {
    if (!userId) return

    let active = true

    async function loadRider() {
      const { data, error: readError } = await supabase
        .from('kekes')
        .select('id, keke_number, status, station_id, lat, lng, last_seen, rating')
        .eq('id', userId)
        .maybeSingle()

      if (!active) return

      if (readError) {
        setError(readError.message)
      } else if (!data) {
        setError('This account has no Keke rider record. Please contact an administrator.')
      } else {
        const lastSeen = data.last_seen ? new Date(data.last_seen).getTime() : 0
        const stillFresh = Date.now() - lastSeen < 75000
        // On duty = free ('online', fresh) OR carrying trips ('on_trip'):
        // both states receive offers until the keke's MAX_ACTIVE_RIDES seats
        // are full. Only a stale *free* row self-heals to offline — an
        // 'on_trip' row keeps its state regardless of heartbeat age, because
        // its trips are real (match-tick never touches it either).
        const shouldBeOnline =
          data.status === 'on_trip' || (data.status === 'online' && stillFresh)

        // Self-heal a stale 'online' row on load (the server sweep does this
        // too; this just keeps the first paint honest). Never touches on_trip
        // or unavailable.
        if (data.status === 'online' && !stillFresh) {
          await supabase
            .from('kekes')
            .update({ status: 'offline' })
            .eq('id', userId)
            .eq('status', 'online')
          data.status = 'offline'
        }

        setRider(data)
        setOnline(shouldBeOnline)
        // Already online at load: the session started at latest at last_seen.
        if (shouldBeOnline && lastSeen) setOnlineSince(lastSeen)
        setStationChoice(data.station_id ?? '')
      }

      setLoading(false)
    }

    loadRider()

    supabase
      .from('locations')
      .select('id, name')
      .eq('kind', 'station')
      .eq('mode', 'along')
      .eq('active', true)
      .order('name')
      .then(({ data }) => {
        if (active) setStations(data ?? [])
      })

    return () => { active = false }
  }, [userId])

  // Live-sync this rider's own row (server-side releases/cancellations).
  useEffect(() => {
    if (!userId) return

    const channel = supabase
      .channel(`rider-self-${userId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'kekes', filter: `id=eq.${userId}` },
        (payload) => {
          if (!payload.new) return
          setRider((current) => (current ? { ...current, ...payload.new } : current))
          if (payload.new.status === 'online') setOnline(true)
        }
      )
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [userId])

  async function loadCurrentOffer() {
    if (!userId || !availableForWork) {
      setOffer(null)
      return
    }

    const { data: request, error: requestError } = await supabase
      .from('ride_requests')
      .select('id, ride_id, sent_at, expires_at, response')
      .eq('keke_id', userId)
      .eq('response', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (requestError) {
      setError(requestError.message)
      return
    }

    if (!request) {
      setOffer(null)
      return
    }

    const { data: ride, error: rideError } = await supabase
      .from('rides')
      .select(`
        id, fare, mode, status, from_id, to_id,
        from:locations!rides_from_id_fkey(name, lat, lng),
        to:locations!rides_to_id_fkey(name, lat, lng)
      `)
      .eq('id', request.ride_id)
      .maybeSingle()

    if (rideError) {
      setError(rideError.message)
      return
    }

    if (ride && ride.status === 'searching') {
      setOffer({ ...request, ride })
    } else {
      setOffer(null)
    }
  }

  // Offers keep arriving while the rider is on duty — including mid-trip,
  // until every seat is taken (mirrors the server's capacity gate).
  useEffect(() => {
    if (!userId || !availableForWork) {
      setOffer(null)
      return
    }

    loadCurrentOffer()

    const channel = supabase
      .channel(`rider-offers-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ride_requests' },
        () => loadCurrentOffer()
      )
      .subscribe()

    // Polling is a fallback in case a realtime event is missed.
    const poll = window.setInterval(loadCurrentOffer, 1500)

    return () => {
      window.clearInterval(poll)
      supabase.removeChannel(channel)
    }
  }, [userId, availableForWork])

  // Load every ride this rider is carrying (up to MAX_ACTIVE_RIDES at once),
  // so the trip queue, the seat counter and the trip screens all agree.
  // Read-only; every status change goes through a backend function
  // (mark-arrived / start-trip / complete-trip / rider-cancel-ride).
  useEffect(() => {
    let active = true

    async function loadActiveTrips() {
      const { data, error: tripError } = await fetchActiveTrips(userId)

      if (!active) return

      if (tripError) {
        setError(tripError.message)
      } else {
        const rows = data ?? []
        setActiveTrips(rows)
        // Keep the selected trip pointing at a trip that still exists.
        setSelectedTripId((current) =>
          current && rows.some((t) => t.id === current) ? current : rows[0]?.id ?? null
        )
      }
    }

    loadActiveTrips()

    // Live updates (student pays → 'paid', cancellation frees a seat…).
    const channel = supabase
      .channel(`rider-trip-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rides', filter: `keke_id=eq.${userId}` },
        () => loadActiveTrips()
      )
      .subscribe()

    const poll = window.setInterval(loadActiveTrips, 4000)

    return () => {
      active = false
      window.clearInterval(poll)
      supabase.removeChannel(channel)
    }
  }, [userId])

  // Student details for every active trip (name + call button on the trip
  // screens). Ride participants may read each other's profiles; degrade
  // gracefully if not.
  useEffect(() => {
    let active = true
    const ids = [...new Set(activeTrips.map((t) => t.student_id).filter(Boolean))]

    if (ids.length === 0) {
      setTripStudents({})
      return () => { active = false }
    }

    supabase
      .from('profiles')
      .select('id, full_name, phone')
      .in('id', ids)
      .then(({ data }) => {
        if (!active) return
        setTripStudents(
          Object.fromEntries((data ?? []).map((p) => [p.id, p]))
        )
      })

    return () => { active = false }
  }, [activeTrips])

  // Queue position at the chosen station (Along dispatch order helper).
  useEffect(() => {
    if (!stationChoice || rider?.station_id !== stationChoice) {
      setQueuePosition(null)
      return
    }

    let active = true

    async function loadQueue() {
      const { data } = await supabase
        .from('kekes')
        .select('id, queue_joined_at')
        .eq('station_id', stationChoice)
        .eq('status', 'online')
        .not('queue_joined_at', 'is', null)
        .order('queue_joined_at', { ascending: true })

      if (!active || !data) return
      const index = data.findIndex((k) => k.id === userId)
      setQueuePosition(index >= 0 ? index + 1 : null)
    }

    loadQueue()
    const timer = window.setInterval(loadQueue, 10000)
    return () => { active = false; window.clearInterval(timer) }
  }, [stationChoice, rider?.station_id, userId])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [])

  // Heartbeat while on duty — 'online' AND 'on_trip' rows both need a fresh
  // last_seen, because the dispatcher's 75s freshness filter applies to
  // riders carrying passengers too (a rider mid-trip can still take more).
  //
  // Preferred path is the keke_heartbeat RPC, which stamps last_seen with
  // NOW() on the SERVER — the client can never backdate its own freshness.
  // The legacy column write below stays as the fallback so a database
  // without the RPC (or a transient RPC failure) keeps heartbeating exactly
  // as it did before.
  useEffect(() => {
    if (!heartbeatOn || !userId) return

    let stopped = false

    async function heartbeat() {
      try {
        const position = await getPosition()
        if (stopped) return

        const { data: rpcData, error: rpcError } = await supabase.rpc('keke_heartbeat', {
          p_lat: position?.lat ?? null,
          p_lng: position?.lng ?? null,
        })

        if (stopped) return

        if (!rpcError && rpcData) {
          if (rpcData.ok) setError('')
          else setError('Heartbeat was not saved. Check that this rider account is on duty.')
          return
        }

        // Fallback: legacy direct write (still granted at the column level).
        const update = { last_seen: new Date().toISOString() }
        if (position) {
          update.lat = position.lat
          update.lng = position.lng
        }

        const { data, error: updateError } = await supabase
          .from('kekes')
          .update(update)
          .eq('id', userId)
          .in('status', ['online', 'on_trip'])
          .select('id, status, last_seen')
          .maybeSingle()

        if (stopped) return

        if (updateError) {
          setError(`Heartbeat failed: ${updateError.message}`)
        } else if (!data) {
          setError('Heartbeat was not saved. Check that this rider account is on duty.')
        } else {
          setError('')
        }
      } catch (heartbeatError) {
        if (!stopped) {
          setError(`Heartbeat failed: ${heartbeatError?.message || 'Unknown error'}`)
        }
      }
    }

    heartbeat()
    const timer = window.setInterval(heartbeat, 15000)

    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [heartbeatOn, userId])

  // Background / logout → offline. A rider who leaves the app (tab hidden,
  // page unloaded) must not keep receiving offers: dispatch only offers to
  // 'online' rows, and flipping the row here makes that immediate instead
  // of waiting for notify-tick's 45s expiry (which is the backstop when the
  // unload request never lands). Never touches 'on_trip' (server-managed:
  // accepted rides stay assigned) or 'unavailable' (a deliberate pause), and
  // never touches another rider's row — the RPC uses auth.uid() only.
  //
  // queue_joined_at is deliberately KEPT on a background flip, so a quick
  // app switch does not cost the queue spot; returning within
  // AUTO_RESUME_MS resumes the same position seamlessly. Longer than that
  // (or a reload) leaves the rider offline with an explicit notice — never
  // silently back online while the user was away.
  const AUTO_RESUME_MS = 30000
  const autoOfflineAtRef = useRef(null)

  useEffect(() => {
    if (!userId) return undefined

    async function goOfflineInBackground() {
      if (!onlineRef.current || onTripRef.current) return
      const { error } = await supabase.rpc('keke_set_presence', { p_status: 'offline' })
      if (error) return // leave state alone; the 45s server sweep is the backstop
      autoOfflineAtRef.current = Date.now()
      setOnline(false)
      setOnlineSince(null)
      setRider((current) => (current ? { ...current, status: 'offline' } : current))
    }

    async function goOnlineAgain() {
      // Direct column write (same path as the toggle): only ever flips a
      // row that is still offline, so an admin change or a server-side
      // transition is never clobbered.
      const { data, error } = await supabase
        .from('kekes')
        .update({ status: 'online', last_seen: new Date().toISOString() })
        .eq('id', userId)
        .eq('status', 'offline')
        .select('id, status')
        .maybeSingle()

      if (error || !data) return
      setOnline(true)
      setOnlineSince(Date.now())
      setRider((current) => (current ? { ...current, status: 'online' } : current))
      setNotice('Welcome back — you are online and can receive ride offers.')
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        goOfflineInBackground()
        return
      }
      if (document.visibilityState !== 'visible') return
      const offlineAt = autoOfflineAtRef.current
      if (!offlineAt) return
      autoOfflineAtRef.current = null
      if (Date.now() - offlineAt <= AUTO_RESUME_MS) {
        goOnlineAgain()
      } else {
        setNotice('You were offline while the app was in the background. Tap Go online to receive offers again.')
      }
    }

    function onPageHide() {
      // Best effort: on a real unload the request may not land — the 45s
      // server sweep clears the row then. On a bfcache freeze it lands.
      goOfflineInBackground()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [userId])

  async function toggleOnline() {
    if (!userId || presenceBusy) return
    // Unavailable is a deliberate pause that only an explicit go-online
    // clears; the toggle above shows 'unavailable' state separately.

    setPresenceBusy(true)
    setError('')
    setNotice('')

    const nextOnline = !online
    const position = nextOnline ? await getPosition() : null
    const update = {
      // Going offline mid-trip only stops NEW offers — rides already
      // accepted stay assigned and can still be completed (the server only
      // releases the rider back to 'online' after their last trip ends, and
      // leaves riders who chose 'offline' alone).
      status: nextOnline ? 'online' : 'offline',
      last_seen: new Date().toISOString(),
    }

    if (nextOnline && stationChoice) {
      // Along queue: joining a station stamps the queue time (spec section 4
      // allows the keke to write its own station_id / queue_joined_at).
      update.station_id = stationChoice
      update.queue_joined_at = new Date().toISOString()
    } else if (!nextOnline) {
      update.queue_joined_at = null
    }

    if (position) {
      update.lat = position.lat
      update.lng = position.lng
    }

    const { data, error: updateError } = await supabase
      .from('kekes')
      .update(update)
      .eq('id', userId)
      .select('id, keke_number, status, station_id, lat, lng, last_seen, rating')
      .maybeSingle()

    setPresenceBusy(false)

    if (updateError || !data) {
      setError(updateError?.message || 'Could not update your online status.')
      return
    }

    setRider(data)
    setOnline(data.status === 'online')
    if (data.status === 'online') setOnlineSince(Date.now())
    else setOnlineSince(null)

    if (data.status === 'online') {
      setNotice(
        stationChoice
          ? 'You are online and queued at your station.'
          : 'You are online and can receive ride offers.'
      )
      loadCurrentOffer()
    } else if (onTrip) {
      setNotice(
        'You will not receive new offers. Your accepted rides stay in the queue — finish them below.'
      )
    } else {
      setNotice('You are now offline.')
    }
  }

  async function setUnavailable() {
    if (!userId || presenceBusy || onTrip || unavailable) return

    setPresenceBusy(true)
    setError('')
    setNotice('')

    const { data, error: updateError } = await supabase
      .from('kekes')
      .update({ status: 'unavailable', queue_joined_at: null, last_seen: new Date().toISOString() })
      .eq('id', userId)
      .neq('status', 'on_trip')
      .select('id, keke_number, status, station_id, lat, lng, last_seen, rating')
      .maybeSingle()

    setPresenceBusy(false)

    if (updateError || !data) {
      setError(updateError?.message || 'Could not update your status.')
      return
    }

    setRider(data)
    setOnline(false)
    setOnlineSince(null)
    setNotice('You are marked unavailable. You will not receive offers until you go online again.')
  }

  // Signing out must not leave a ghost 'online' row that dispatch would go
  // on offering to for the next 45 seconds. Same guard as the background
  // flip: only an 'online' row is touched, never 'on_trip' (accepted rides
  // stay assigned — the server releases the rider when the last trip ends)
  // and never 'unavailable' (already paused). Best effort: if this request
  // does not land, notify-tick's 45s expiry still clears the row.
  async function handleSignOut() {
    if (online && !onTrip) {
      try {
        await supabase.rpc('keke_set_presence', { p_status: 'offline' })
      } catch {
        /* expiry sweep is the backstop */
      }
    }
    await signOut()
  }

  async function respond(response) {
    if (!offer || busy) return

    setBusy(true)
    setError('')
    setNotice('')

    const { data, error: responseError } = await supabase.rpc(
      'respond_to_ride_request',
      {
        p_request_id: offer.id,
        p_response: response,
      }
    )

    setBusy(false)

    if (responseError) {
      setError(responseError.message)
      return
    }

    if (response === 'accepted' && data?.state === 'accepted') {
      setOffer(null)
      setNotice('Ride accepted! The booking has been added to your trips.')
      // Stay on duty: a keke holds MAX_ACTIVE_RIDES passengers, so accepting
      // one ride does not end availability — offers keep coming until every
      // seat is full.
      setTripView('map')
      setSelectedTripId(data.ride_id ?? null)
      setRider((current) => current ? { ...current, status: 'on_trip' } : current)
      return
    }

    if (response === 'accepted' && data?.state === 'at_capacity') {
      setOffer(null)
      setNotice(
        `Your keke is full — ${MAX_ACTIVE_RIDES} active rides. Finish a trip before accepting more.`
      )
      return
    }

    setOffer(null)

    if (response === 'declined') {
      setNotice('Request declined. The system is checking the next rider.')
    } else if (data?.state === 'pending') {
      setNotice('The offer has expired. Checking the next rider.')
    }

    await loadCurrentOffer()
  }

  async function invokeTripFunction(name, body, successNotice) {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')

    const { data, error: fnError } = await supabase.functions.invoke(name, { body })

    setBusy(false)

    if (fnError) {
      let detail = fnError.message || 'Something went wrong.'
      try {
        const payload = await fnError.context?.json?.()
        detail = payload?.error || detail
      } catch {}
      setError(detail)
      return null
    }

    if (data?.error) {
      setError(data.error)
      return null
    }

    if (successNotice) setNotice(successNotice)
    return data
  }

  // Trip actions act on a specific trip (the trip queue lets the rider work
  // through up to MAX_ACTIVE_RIDES at once); defaults to the trip the screens
  // show.
  async function markArrived(trip = activeTrip) {
    if (!trip) return
    const result = await invokeTripFunction(
      'mark-arrived',
      { ride_id: trip.id },
      'Arrival recorded. Waiting for the student to board.'
    )
    if (result) {
      setActiveTrips((rows) =>
        rows.map((t) => (t.id === trip.id ? { ...t, status: 'arrived' } : t))
      )
    }
  }

  async function startTrip(trip = activeTrip) {
    if (!trip) return
    const code = (tripCodes[trip.id] ?? '').trim()
    if (!/^\d{4}$/.test(code)) {
      setError('Enter the 4-digit booking code shown by the student.')
      return
    }
    const result = await invokeTripFunction(
      'start-trip',
      { ride_id: trip.id, booking_code: code },
      'Trip started. Have a safe ride.'
    )
    if (result) {
      setActiveTrips((rows) =>
        rows.map((t) => (t.id === trip.id ? { ...t, status: 'on_trip' } : t))
      )
      setTripCodes((codes) => ({ ...codes, [trip.id]: '' }))
    }
  }

  async function completeTrip(trip = activeTrip) {
    if (!trip) return
    const wasLastTrip = activeTrips.length <= 1
    const result = await invokeTripFunction(
      'complete-trip',
      { ride_id: trip.id },
      wasLastTrip
        ? 'Trip completed. You are back online and can receive new offers.'
        : 'Trip completed. You still have trips in progress — finish them below.'
    )
    if (result) {
      // Re-read the rider row instead of guessing: release_keke_if_idle()
      // only flips 'on_trip' → 'online' after the LAST trip, and leaves a
      // rider who chose to go offline mid-trip offline.
      setActiveTrips((rows) => rows.filter((t) => t.id !== trip.id))
      setTripView('map')

      const { data: fresh } = await supabase
        .from('kekes')
        .select('id, status, last_seen')
        .eq('id', userId)
        .maybeSingle()

      if (fresh) {
        setRider((current) => (current ? { ...current, ...fresh } : current))
        if (fresh.status === 'online') {
          setOnline(true)
          if (!onlineSince) setOnlineSince(Date.now())
        } else if (fresh.status === 'offline') {
          setOnline(false)
          setOnlineSince(null)
        }
      }
    }
  }

  // ---- Rider incident actions (Task 1) ---------------------------------
  // PRE-boarding (accepted / paid / arrived): the student is NOT aboard, so
  // the booking is handed back to dispatch (payment preserved, never
  // double-charged). POST-boarding (on_trip): the student IS aboard — this
  // records an interruption, it never cancels the trip.
  // Every call goes to the rider-cancel-ride function; nothing here writes
  // ride status directly.
  async function reportIncident(trip, action, reason) {
    if (!trip) return

    const confirmText =
      action === 'interrupt'
        ? `Report a ${reason === 'emergency' ? 'n emergency' : ' breakdown'} while the student is aboard?\n\n` +
          'The trip is recorded as interrupted, the student and admin are ' +
          'notified, and your live location keeps sharing so the student ' +
          'stays visible. An admin will arrange a replacement keke.'
        : `Report: ${reason}?\n\n` +
          'The student has not boarded, so this booking will be released ' +
          'and re-offered to another keke. Any digital payment is preserved ' +
          '— you are never charged again.'

    if (!window.confirm(confirmText)) return

    const labels = {
      redispatch: 'Booking released — the system is re-offering it to another keke.',
      interrupt: 'Interruption recorded. Keep sharing your location; a replacement is being arranged.',
    }

    const result = await invokeTripFunction(
      'rider-cancel-ride',
      { ride_id: trip.id, action, reason },
      labels[action],
    )

    if (!result) return

    // Re-read trips from the server instead of guessing the outcome: a
    // re-dispatched booking leaves this rider's list, an interrupted trip
    // stays with its new columns filled in.
    const { data: rows } = await fetchActiveTrips(userId)

    if (rows) {
      setActiveTrips(rows)
      setSelectedTripId((current) =>
        current && rows.some((t) => t.id === current) ? current : rows[0]?.id ?? null
      )
    }
  }

  // Trip history + earnings — loaded once per session so the Home hero can
  // show today's real earnings too.
  useEffect(() => {
    if (!userId) return
    let active = true

    async function loadHistory() {
      const { data } = await supabase
        .from('rides')
        .select(`
          id, status, fare, mode, created_at, completed_at,
          from:locations!rides_from_id_fkey(name),
          to:locations!rides_to_id_fkey(name)
        `)
        .eq('keke_id', userId)
        .order('created_at', { ascending: false })
        .limit(60)

      if (!active || !data) return
      setTrips(data)

      const done = data.filter((r) => r.status === 'completed')
      const today = new Date().toISOString().slice(0, 10)
      const todayDone = done.filter(
        (r) => r.completed_at && r.completed_at.slice(0, 10) === today
      )
      setEarnings({
        count: done.length,
        total: done.reduce((sum, r) => sum + Number(r.fare || 0), 0),
        todayCount: todayDone.length,
        todayTotal: todayDone.reduce((sum, r) => sum + Number(r.fare || 0), 0),
        completed: done,
      })
    }

    loadHistory()
    return () => { active = false }
  }, [userId])

  useEffect(() => {
    if (!offer || busy) return

    const remaining = new Date(offer.expires_at).getTime() - now
    if (remaining > 0 || handledExpiry === offer.id) return

    setHandledExpiry(offer.id)
    respond('expired')
  }, [offer, now, busy, handledExpiry])

  const secondsLeft = offer
    ? Math.max(0, Math.ceil((new Date(offer.expires_at).getTime() - now) / 1000))
    : 0
  const offerWindow = offer
    ? Math.max(1, Math.round((new Date(offer.expires_at) - new Date(offer.sent_at)) / 1000))
    : 15

  const sessionMs = online && onlineSince ? now - onlineSince : null

  // The trip the full-screen views act on: the selected one, else the
  // oldest still active. Trip student details come from the batch-loaded map.
  const activeTrip = useMemo(
    () =>
      activeTrips.find((t) => t.id === selectedTripId) ?? activeTrips[0] ?? null,
    [activeTrips, selectedTripId],
  )
  const tripStudent = activeTrip?.student_id
    ? tripStudents[activeTrip.student_id] ?? null
    : null

  // The rider's own live position (heartbeat + realtime self-row updates).
  const riderPos = useMemo(
    () => (validCoord(rider) ? { lat: Number(rider.lat), lng: Number(rider.lng) } : null),
    [rider?.lat, rider?.lng]
  )

  // Live GPS publishing (spec section 6): real watchPosition fixes go to
  // ride_locations for every active trip — only while trips are active.
  const tracking = useRideTracking({ kekeId: userId, rides: activeTrips })

  // One notification per request the moment a new offer lands (including a
  // request already waiting when the rider opens the app). The offer modal
  // still opens exactly as before — this is an extra signal, not a new flow.
  useOfferNotice(offer)

  // Bell tap: the explicit gesture browsers require before showing their
  // permission prompt. Re-taps while granted do nothing.
  async function askNotifications() {
    if (notifPerm === 'unsupported' || notifPerm === 'granted') return
    const result = await requestNotificationPermission()
    setNotifPerm(result)
  }

  // Trip-map geometry for K6 (to pick-up) and K8 (on trip).
  const tripFrom = activeTrip?.from
  const tripTo = activeTrip?.to
  const tripPoints = useMemo(
    () =>
      [
        tripFrom && validCoord(tripFrom)
          ? { ...tripFrom, kind: 'pickup' }
          : null,
        tripTo && validCoord(tripTo)
          ? { ...tripTo, kind: 'destination' }
          : null,
      ].filter(Boolean),
    [tripFrom, tripTo]
  )

  // Route for K6 (rider → pick-up) and K8 (rider → destination). The origin
  // follows the rider's live position, but a road route is only re-requested
  // after a real ≥30 m move (routing.js) so GPS ticks don't hammer the OSRM
  // demo server.
  const tripRouteRef = useRef(null)
  const tripRoute = useMemo(() => {
    if (!activeTrip) return null
    const status = activeTrip.status
    const desired =
      status === 'on_trip'
        ? riderPos && validCoord(tripTo)
          ? { from: riderPos, to: tripTo }
          : null
        : riderPos && validCoord(tripFrom)
          ? { from: riderPos, to: tripFrom }
          : tripFrom && tripTo
            ? { from: tripFrom, to: tripTo }
            : null
    if (!desired) return null

    const gate = tripRouteRef.current
    const destKey = String(desired.to?.id ?? `${desired.to?.lat},${desired.to?.lng}`)
    if (gate && gate.destKey === destKey && gate.route) {
      if (!shouldReroute(desired.from, gate.origin)) return gate.route
    }
    tripRouteRef.current = { origin: desired.from, destKey, route: desired }
    return desired
  }, [activeTrip?.status, riderPos, tripFrom, tripTo])

  // Honest trip progress for K8: remaining straight-line distance vs the
  // whole route; hidden when the rider's location is unavailable.
  let tripProgress = null
  if (
    activeTrip?.status === 'on_trip' &&
    riderPos &&
    validCoord(tripFrom) &&
    validCoord(tripTo)
  ) {
    const total = distanceMeters(tripFrom, tripTo)
    const remaining = distanceMeters(riderPos, tripTo)
    if (total > 0) {
      tripProgress = Math.min(100, Math.max(0, Math.round((1 - remaining / total) * 100)))
    }
  }

  const tripEtaMinutes = tripEta
    ? Math.max(1, Math.round(tripEta.seconds / 60))
    : null

  // ---- Earnings period (This week / All time) --------------------------
  const weekSeries = useMemo(() => {
    const done = earnings?.completed ?? []
    const days = []
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      const total = done
        .filter((r) => r.completed_at && r.completed_at.slice(0, 10) === key)
        .reduce((sum, r) => sum + Number(r.fare || 0), 0)
      days.push({
        key,
        total,
        label: d.toLocaleDateString(undefined, { weekday: 'narrow' }),
      })
    }
    return days
  }, [earnings])

  const weekTotal = weekSeries.reduce((sum, d) => sum + d.total, 0)

  const periodRows = useMemo(() => {
    const done = earnings?.completed ?? []
    if (earnPeriod === 'all') return done
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    return done.filter(
      (r) => r.completed_at && new Date(r.completed_at).getTime() >= weekAgo
    )
  }, [earnings, earnPeriod])

  // ---- Offer modal (mockup K3 Drop / K5 Along) -------------------------
  // Task 3: the ride type, route direction, passenger count and fare are
  // all on screen at once so a rider can tell DROP from ALONG at a glance
  // before accepting. Business rules are untouched — this is presentation.
  if (offer) {
    const isAlong = offer.ride.mode === 'along'
    const pickupName = offer.ride.from?.name ?? 'Pickup location'
    const destName = offer.ride.to?.name ?? 'Destination'
    return (
      <main className="keke-app keke-offer-open">
        <div className="ko-overlay" role="dialog" aria-modal="true" aria-labelledby="ko-title">
          <section className="ko-modal">
            <header className="ko-head">
              <span className={`ko-mode-badge ${isAlong ? 'is-along' : 'is-drop'}`}>
                {isAlong ? 'ALONG' : 'DROP'}
              </span>
              <p className="ko-eyebrow">{pickupName}</p>
              <h2 id="ko-title">
                {isAlong ? 'New Along request' : 'New Drop request'}
              </h2>
              <p className="ko-mode-sub">
                {isAlong
                  ? 'Student boards at your pickup point and rides along this route to the destination.'
                  : 'Direct trip: pick the student up and take them straight to the destination.'}
              </p>
            </header>

            <div className="ko-ring-wrap" aria-live="polite">
              <OfferRing secondsLeft={secondsLeft} totalSeconds={offerWindow} along={isAlong} />
            </div>

            <div className="ko-body">
              <div className="ko-route">
                <div>
                  <small>{isAlong ? 'Board at (route start)' : 'Pick-up'}</small>
                  <strong>{pickupName}</strong>
                </div>
                <div className="ko-route-arrow" aria-hidden="true">→</div>
                <div>
                  <small>{isAlong ? 'Ride along to' : 'Destination'}</small>
                  <strong>{destName}</strong>
                </div>
              </div>

              <div className="ko-fare">
                <span>Fare {isAlong ? '(Along route price)' : '(Drop price)'}</span>
                <strong>₦{Number(offer.ride.fare).toLocaleString()}</strong>
              </div>

              <div className="ko-seats">
                <span>Seats in use</span>
                <strong>
                  {activeTrips.length} of {MAX_ACTIVE_RIDES} passengers
                </strong>
              </div>

              <p className="ko-timer-note">
                No reply in {offerWindow} seconds moves it to the next keke.
                {activeTrips.length > 0 &&
                  ` You are carrying ${activeTrips.length} of ${MAX_ACTIVE_RIDES} rides.`}
              </p>

              {error && <p role="alert" className="ko-error">{error}</p>}

              <div className="ko-actions">
                <button
                  type="button"
                  className="ko-accept"
                  disabled={busy || secondsLeft <= 0}
                  onClick={() => respond('accepted')}
                >
                  {busy ? 'Please wait…' : 'Accept'}
                </button>
                <button
                  type="button"
                  className="ko-decline"
                  disabled={busy}
                  onClick={() => respond('declined')}
                >
                  Decline
                </button>
              </div>
            </div>
          </section>
        </div>
      </main>
    )
  }

  // ---- Trip screens (mockup K6 / K7 / K8) — full screen, no bottom nav -
  // While carrying trips, Home shows the trip (queue or map) and the other
  // tabs stay reachable so the rider is never stuck (Profile has Sign out).
  // Covers riders who went offline mid-trip too: the trips stay open until
  // they are finished, whatever the availability switch says.
  const carryingTrips = onTrip || activeTrips.length > 0
  if (carryingTrips && (tab === 'Home' || tripView === 'map')) {
    if (!activeTrip) {
      return (
        <main className="keke-app">
          <section className="keke-content">
            <h2>Current trip</h2>
            <div className="keke-hint">
              <strong>Loading your trip…</strong>
              <span>
                We are checking your assigned booking. This refreshes every few
                seconds.
              </span>
            </div>
            {error && <div className="keke-hint offline" role="alert">{error}</div>}
            {notice && <div className="keke-hint" role="status">{notice}</div>}
          </section>
        </main>
      )
    }

    const ticket = activeTrip.tickets?.[0] ?? null
    const studentName = tripStudent?.full_name ?? 'Student'

    // Trip queue — the destination of the back button on the full-screen
    // trip views. A keke carries up to MAX_ACTIVE_RIDES passengers, so every
    // active trip gets its own card with its own actions; tapping one
    // selects it for the full-screen trip view.
    if (tripView === 'card') {
      return (
        <main className="keke-app">
          <header className="keke-bar">
            <span className="keke-bar-title">
              Trips · {activeTrips.length}/{MAX_ACTIVE_RIDES} seats
            </span>
            <button
              type="button"
              className="keke-bar-btn"
              onClick={() => setTripView('map')}
            >
              Open trip screen
            </button>
          </header>

          {error && <div className="keke-hint offline" role="alert">{error}</div>}
          {notice && <div className="keke-hint" role="status">{notice}</div>}
          <TrackingChip tracking={tracking} now={now} />

          <section className="keke-content">
            {activeTrips.map((trip) => {
              const ticket = trip.tickets?.[0] ?? null
              const student = tripStudents[trip.student_id] ?? null
              const isSelected = trip.id === activeTrip?.id
              const code = tripCodes[trip.id] ?? ''
              const tripIsAlong = trip.mode === 'along'
              // Pre-boarding: the student has not boarded, so the booking can
              // be released and re-offered. Post-boarding: interruption only.
              const preBoard = canRedispatch(trip.status)
              const interruptible = canInterrupt(trip.status, trip.interrupted_at)

              return (
                <div
                  key={trip.id}
                  className={
                    'kr-trip-card' + (isSelected ? ' kr-trip-sel' : '')
                  }
                >
                  <button
                    type="button"
                    className="kr-trip-head"
                    onClick={() => setSelectedTripId(trip.id)}
                    aria-pressed={isSelected}
                  >
                    <span>
                      <span className="kr-mode-row">
                        <span
                          className={`ko-mode-badge sm ${tripIsAlong ? 'is-along' : 'is-drop'}`}
                        >
                          {tripIsAlong ? 'ALONG' : 'DROP'}
                        </span>
                        <strong>
                          {trip.from?.name ?? 'Pick-up'} → {trip.to?.name ?? 'Destination'}
                        </strong>
                      </span>
                      <span>
                        Booking {trip.booking_code} · ₦
                        {Number(trip.fare).toLocaleString()}
                        {ticket ? ` · ticket ${ticket.ticket_no}` : ''}
                      </span>
                      {trip.status === 'accepted' && (
                        <span>Waiting for the student’s payment.</span>
                      )}
                      {trip.status === 'paid' && (
                        <span>Head to the pickup point, then mark your arrival.</span>
                      )}
                      {trip.status === 'arrived' && (
                        <span>Student is boarding — ask for the booking code.</span>
                      )}
                      {trip.status === 'on_trip' && (
                        <span>Heading to {trip.to?.name ?? 'the destination'}.</span>
                      )}
                    </span>
                    <span className="kr-trip-tag">
                      {String(trip.status).replaceAll('_', ' ')}
                    </span>
                  </button>

                  {trip.interrupted_at && (
                    <div className="kr-interrupted" role="alert">
                      <strong>
                        Trip interrupted · {String(trip.interrupted_reason ?? 'breakdown')}
                      </strong>
                      <span>
                        {trip.replacement_at
                          ? 'Replacement keke assigned — continue the trip.'
                          : 'A replacement is being arranged. Keep sharing your location so the student can be found.'}
                      </span>
                    </div>
                  )}

                  {student?.phone && (
                    <a className="kr-call" href={`tel:${student.phone}`}>
                      Call student
                    </a>
                  )}

                  {(trip.status === 'accepted' || trip.status === 'paid') && (
                    <button
                      type="button"
                      className="ko-accept"
                      disabled={busy}
                      onClick={() => markArrived(trip)}
                    >
                      {busy ? 'Please wait…' : 'I have arrived'}
                    </button>
                  )}

                  {trip.status === 'arrived' && (
                    <>
                      <CodeBoxes
                        value={code}
                        onChange={(value) =>
                          setTripCodes((codes) => ({ ...codes, [trip.id]: value }))
                        }
                        onSubmit={() => startTrip(trip)}
                        busy={busy}
                      />
                      <button
                        type="button"
                        className="ko-accept"
                        disabled={busy || code.length !== 4}
                        onClick={() => startTrip(trip)}
                      >
                        {busy ? 'Please wait…' : 'Start trip'}
                      </button>
                    </>
                  )}

                  {trip.status === 'on_trip' && (
                    <button
                      type="button"
                      className="ko-accept"
                      disabled={busy}
                      onClick={() => completeTrip(trip)}
                    >
                      {busy ? 'Please wait…' : 'Complete trip'}
                    </button>
                  )}

                  {/* Incident controls (Task 1): large, clearly separated
                      from the primary action so a moving rider cannot hit
                      them by accident. */}
                  {(preBoard || interruptible) && (
                    <div className="kr-incident">
                      <span className="kr-incident-label">
                        {interruptible
                          ? 'Problem after the student boarded?'
                          : 'Cannot continue this booking?'}
                      </span>
                      <div className="kr-incident-actions">
                        {interruptible && (
                          <>
                            <button
                              type="button"
                              className="kr-incident-btn warn"
                              disabled={busy}
                              onClick={() => reportIncident(trip, 'interrupt', 'breakdown')}
                            >
                              Breakdown
                            </button>
                            <button
                              type="button"
                              className="kr-incident-btn danger"
                              disabled={busy}
                              onClick={() => reportIncident(trip, 'interrupt', 'emergency')}
                            >
                              Emergency
                            </button>
                          </>
                        )}
                        {preBoard && (
                          <>
                            <button
                              type="button"
                              className="kr-incident-btn warn"
                              disabled={busy}
                              onClick={() => reportIncident(trip, 'redispatch', 'breakdown')}
                            >
                              Breakdown — release booking
                            </button>
                            <button
                              type="button"
                              className="kr-incident-btn"
                              disabled={busy}
                              onClick={() => reportIncident(trip, 'redispatch', 'cancelled')}
                            >
                              Cancel booking
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </section>

          <nav className="keke-bottom-nav" aria-label="Rider navigation">
            {tabs.map((item) => (
              <button
                key={item}
                type="button"
                className={tab === item ? 'active' : ''}
                onClick={() => setTab(item)}
              >
                {item}
              </button>
            ))}
          </nav>
        </main>
      )
    }

    // K7 — Verify passenger (arrived at pick-up)
    if (activeTrip.status === 'arrived') {
      const tripIsAlong = activeTrip.mode === 'along'
      return (
        <main className="keke-app keke-trip-app">
          <header className="keke-trip-head">
            <button
              type="button"
              className="keke-back-float"
              onClick={() => setTripView('card')}
              aria-label="Back to trip card"
            >
              ←
            </button>
            <div className="kr-avatar" aria-hidden="true">
              {studentName.charAt(0).toUpperCase()}
            </div>
            <h1>{studentName}</h1>
            <span className={`ko-mode-badge ${tripIsAlong ? 'is-along' : 'is-drop'}`}>
              {tripIsAlong ? 'ALONG' : 'DROP'}
            </span>
            <p>
              {tripFrom?.name ?? 'Pick-up'} → {tripTo?.name ?? 'Destination'}
            </p>
          </header>

          <section className="keke-content keke-trip-sheet">
            <p className="ko-eyebrow" style={{ textAlign: 'center', color: '#64748b' }}>
              Ask for the booking code the student is showing
            </p>

            <CodeBoxes
              value={tripCodes[activeTrip.id] ?? ''}
              onChange={(value) =>
                setTripCodes((codes) => ({ ...codes, [activeTrip.id]: value }))
              }
              onSubmit={() => startTrip(activeTrip)}
              busy={busy}
            />

            <div className="kr-ticket">
              <div>
                <small>Ticket</small>
                <strong>{ticket ? ticket.ticket_no : '—'}</strong>
              </div>
              <div>
                <small>Fare</small>
                <strong>
                  {ticket ? `Paid ₦${Number(activeTrip.fare).toLocaleString()}` : 'Awaiting payment'}
                </strong>
              </div>
              <div>
                <small>Status</small>
                <strong>
                  {ticket
                    ? String(ticket.status).replaceAll('_', ' ')
                    : 'awaiting payment'}
                </strong>
              </div>
            </div>

            {error && <div className="keke-hint offline" role="alert">{error}</div>}
            <TrackingChip tracking={tracking} now={now} />

            <button
              type="button"
              className="ko-accept"
              disabled={busy || (tripCodes[activeTrip.id] ?? '').length !== 4}
              onClick={() => startTrip(activeTrip)}
            >
              {busy ? 'Please wait…' : 'Start trip'}
            </button>

            {canRedispatch(activeTrip.status) && (
              <div className="kr-incident">
                <span className="kr-incident-label">
                  Cannot continue before the student boards?
                </span>
                <div className="kr-incident-actions">
                  <button
                    type="button"
                    className="kr-incident-btn warn"
                    disabled={busy}
                    onClick={() => reportIncident(activeTrip, 'redispatch', 'breakdown')}
                  >
                    Breakdown — release booking
                  </button>
                  <button
                    type="button"
                    className="kr-incident-btn"
                    disabled={busy}
                    onClick={() => reportIncident(activeTrip, 'redispatch', 'cancelled')}
                  >
                    Cancel booking
                  </button>
                </div>
              </div>
            )}

            <button
              type="button"
              className="keke-signout ghost"
              style={{ marginTop: 10 }}
              disabled={busy}
              onClick={() =>
                setTripCodes((codes) => ({ ...codes, [activeTrip.id]: '' }))
              }
            >
              Clear code
            </button>
          </section>
        </main>
      )
    }

    // K6 (to pick-up) and K8 (on trip) share the map + sheet layout.
    const headingTo = activeTrip.status === 'on_trip'
    const paid = ['paid', 'arrived', 'on_trip'].includes(activeTrip.status)
    const tripIsAlong = activeTrip.mode === 'along'
    const showInterrupt = Boolean(activeTrip.interrupted_at)
    const interruptibleTrip = canInterrupt(activeTrip.status, activeTrip.interrupted_at)
    const preBoardTrip = canRedispatch(activeTrip.status)

    return (
      <main className="keke-trip-screen">
        <div className="keke-trip-map">
          <CampusMap
            points={tripPoints}
            route={tripRoute}
            userLocation={riderPos}
            onRouteInfo={setTripEta}
            height="100%"
          />
        </div>

        <div className="keke-trip-top">
          <button
            type="button"
            className="keke-back"
            onClick={() => setTripView('card')}
            aria-label="Back to trip card"
          >
            ←
          </button>
          <span className={`ko-mode-badge sm ${tripIsAlong ? 'is-along' : 'is-drop'}`}>
            {tripIsAlong ? 'ALONG' : 'DROP'}
          </span>
          <div className="keke-trip-pill">
            {headingTo
              ? tripEtaMinutes
                ? `${tripEtaMinutes} min left`
                : 'On trip'
              : tripEtaMinutes
                ? `${tripEtaMinutes} min to pick-up`
                : 'Head to pick-up'}
          </div>
        </div>

        <section className="keke-trip-sheet" role="region" aria-label="Trip details">
          {showInterrupt && (
            <div className="kr-interrupted" role="alert">
              <strong>
                Trip interrupted · {String(activeTrip.interrupted_reason ?? 'breakdown')}
              </strong>
              <span>
                {activeTrip.replacement_at
                  ? 'Replacement keke assigned — continue the trip.'
                  : 'A replacement is being arranged. Keep sharing your location so the student can be found.'}
              </span>
            </div>
          )}

          {!headingTo && (
            <div className="kr-student-row">
              <div className="kr-avatar sm" aria-hidden="true">
                {studentName.charAt(0).toUpperCase()}
              </div>
              <div className="kr-student-text">
                <strong>{studentName}</strong>
                <span>
                  {tripFrom?.name ?? 'Pick-up'} → {tripTo?.name ?? 'Destination'}
                </span>
              </div>
            </div>
          )}

          <div className="kr-fare-row">
            <span>{headingTo ? 'Heading to' : 'Pick-up'}</span>
            <strong>
              {headingTo ? tripTo?.name ?? 'Destination' : tripFrom?.name ?? 'Pick-up'}
            </strong>
            <b>₦{Number(activeTrip.fare).toLocaleString()}</b>
          </div>

          {!headingTo && (
            <p className="kr-paid-note">
              {paid
                ? 'Paid by student · ticket issued'
                : 'Waiting for the student’s payment'}
            </p>
          )}

          {headingTo && tripProgress !== null && (
            <>
              <div className="bk-progress" aria-hidden="true">
                <i style={{ width: `${tripProgress}%` }} />
              </div>
              <p className="kr-progress-note">{tripProgress}% of the way</p>
            </>
          )}

          {error && <div className="keke-hint offline" role="alert">{error}</div>}
          <TrackingChip tracking={tracking} now={now} />

          {headingTo ? (
            <button type="button" className="ko-accept" disabled={busy} onClick={completeTrip}>
              {busy ? 'Please wait…' : 'Complete trip'}
            </button>
          ) : (
            <>
              {tripStudent?.phone && (
                <a className="kr-call" href={`tel:${tripStudent.phone}`}>
                  Call student
                </a>
              )}
              {(activeTrip.status === 'accepted' || activeTrip.status === 'paid') && (
                <button type="button" className="ko-accept" disabled={busy} onClick={markArrived}>
                  {busy ? 'Please wait…' : 'I have arrived'}
                </button>
              )}
            </>
          )}

          {/* Incident controls (Task 1) on the full-screen trip views. */}
          {(interruptibleTrip || preBoardTrip) && (
            <div className="kr-incident">
              <span className="kr-incident-label">
                {interruptibleTrip
                  ? 'Problem while the student is aboard?'
                  : 'Cannot continue before pickup?'}
              </span>
              <div className="kr-incident-actions">
                {interruptibleTrip && (
                  <>
                    <button
                      type="button"
                      className="kr-incident-btn warn"
                      disabled={busy}
                      onClick={() => reportIncident(activeTrip, 'interrupt', 'breakdown')}
                    >
                      Breakdown
                    </button>
                    <button
                      type="button"
                      className="kr-incident-btn danger"
                      disabled={busy}
                      onClick={() => reportIncident(activeTrip, 'interrupt', 'emergency')}
                    >
                      Emergency
                    </button>
                  </>
                )}
                {preBoardTrip && (
                  <>
                    <button
                      type="button"
                      className="kr-incident-btn warn"
                      disabled={busy}
                      onClick={() => reportIncident(activeTrip, 'redispatch', 'breakdown')}
                    >
                      Breakdown — release booking
                    </button>
                    <button
                      type="button"
                      className="kr-incident-btn"
                      disabled={busy}
                      onClick={() => reportIncident(activeTrip, 'redispatch', 'cancelled')}
                    >
                      Cancel booking
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </section>
      </main>
    )
  }

  // ---- Regular tabs ----------------------------------------------------
  return (
    <main className="keke-app">
      <header className="keke-hero">
        <div className="keke-hero-top">
          <button
            className={`keke-online-toggle ${online ? 'is-online' : ''}`}
            type="button"
            role="switch"
            aria-checked={online}
            aria-label={online ? 'Go offline' : 'Go online'}
            disabled={presenceBusy || loading || !rider}
            onClick={toggleOnline}
          >
            <span />
          </button>

          <div className="keke-brand">
            <span>Danfolio Logistics</span>
            <h1>
              {unavailable
                ? 'You are unavailable'
                : atCapacity
                  ? `Your keke is full · ${MAX_ACTIVE_RIDES}/${MAX_ACTIVE_RIDES}`
                  : onTrip
                    ? `On a trip · ${activeTrips.length}/${MAX_ACTIVE_RIDES}`
                    : `You are ${online ? 'online' : 'offline'}`}
            </h1>
          </div>

          {/* Notification opt-in for new requests. Hidden when the browser
              has no Notification API; honest about a blocked permission.
              The offer modal itself never depends on this. */}
          {notifPerm !== 'unsupported' && (
            <button
              type="button"
              className={`keke-notif-bell ${notifPerm === 'granted' ? 'is-on' : ''}`}
              aria-label={
                notifPerm === 'granted'
                  ? 'New-request notifications are on'
                  : notifPerm === 'denied'
                    ? 'Notifications blocked in browser settings'
                    : 'Turn on new-request notifications'
              }
              title={
                notifPerm === 'granted'
                  ? 'New-request notifications on'
                  : notifPerm === 'denied'
                    ? 'Notifications blocked — allow them in your browser settings'
                    : 'Notify me about new ride requests'
              }
              disabled={notifPerm === 'granted'}
              onClick={askNotifications}
            >
              {notifPerm === 'granted' ? '🔔' : notifPerm === 'denied' ? '🔕' : '🔔?'}
            </button>
          )}
        </div>

        <section className="keke-earnings-today" aria-label="Today earnings">
          <span>Today earnings</span>
          <strong>
            ₦{(earnings?.todayTotal ?? 0).toLocaleString('en-NG')}
          </strong>
        </section>
      </header>

      <div className="keke-stats-wrap">
        <div className="keke-stats">
          <div className="keke-stat">
            <strong>{earnings?.todayCount ?? '—'}</strong>
            <span>Trips today</span>
          </div>
          <div className="keke-stat">
            <strong>
              {rider?.rating != null ? Number(rider.rating).toFixed(1) : '—'}
            </strong>
            <span>Rating</span>
          </div>
          <div className="keke-stat">
            <strong>{formatSession(sessionMs)}</strong>
            <span>Online</span>
          </div>
        </div>
      </div>

      {error && <div className="keke-hint offline" role="alert">{error}</div>}
      {notice && <div className="keke-hint" role="status">{notice}</div>}

      {tab === 'Home' ? (
        <section className="keke-content">
          <div className={`keke-hint ${online || onTrip ? '' : 'offline'}`}>
            <span>
              {onTrip
                ? `You are carrying ${activeTrips.length} of ${MAX_ACTIVE_RIDES} rides.`
                : online
                  ? 'You are available for student ride requests.'
                  : unavailable
                    ? 'You are marked unavailable and will not receive offers.'
                    : 'Go online when you are ready to receive ride requests.'}
            </span>
            <strong>
              {onTrip
                ? `New requests keep arriving until all ${MAX_ACTIVE_RIDES} seats are taken.`
                : online
                  ? 'A request will appear here automatically.'
                  : 'The system will offer rides to eligible riders one at a time.'}
            </strong>
          </div>

          {!onTrip && stations.length > 0 && (
            <div className="keke-hint">
              <span>
                <strong>Station (for Along rides)</strong>
                {rider?.station_id === stationChoice && queuePosition && (
                  <> · you are #{queuePosition} in this station’s queue</>
                )}
              </span>
              <select
                value={stationChoice}
                onChange={(e) => setStationChoice(e.target.value)}
                style={{ width: '100%', height: 52, borderRadius: 14, border: '1px solid #cbd5e1', font: 'inherit', padding: '0 12px', marginTop: 8 }}
                aria-label="Choose your station"
              >
                <option value="">No station (Drop rides only)</option>
                {stations.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <span className="muted" style={{ fontSize: 13 }}>
                Choosing a station saves when you go online.
              </span>
            </div>
          )}

          {online && (
            <button
              type="button"
              className="keke-signout"
              disabled={presenceBusy}
              onClick={setUnavailable}
              style={{ marginTop: 4 }}
            >
              Take a break (mark unavailable)
            </button>
          )}

          <h2>Ride offers</h2>

          {availableForWork && !offer && !loading && (
            <div className="keke-hint">
              <strong>Waiting for your next offer</strong>
              <span>
                Keep this page open — offers stop arriving when all{' '}
                {MAX_ACTIVE_RIDES} seats are taken.
              </span>
            </div>
          )}

          {!availableForWork && (
            <p className="keke-data-note">
              {atCapacity
                ? `All ${MAX_ACTIVE_RIDES} seats are in use. Finish a trip to receive new offers.`
                : unavailable
                  ? 'You are unavailable and will not receive new offers.'
                  : 'You are offline and will not receive new offers.'}
            </p>
          )}
        </section>
      ) : tab === 'Trips' ? (
        <section className="keke-content keke-tab-placeholder">
          <button type="button" className="keke-tab-back" onClick={() => setTab('Home')}>
            ← Home
          </button>
          <h2>Trips</h2>
          {trips === null && <p>Loading…</p>}
          {trips && trips.length === 0 && <p>No trips yet.</p>}
          {(trips ?? []).map((trip) => (
            <div className="keke-hint" key={trip.id}>
              <span>
                <strong>{trip.from?.name} → {trip.to?.name}</strong>
                <span className="muted">
                  {new Date(trip.created_at).toLocaleString()}
                </span>
              </span>
              <span>
                ₦{Number(trip.fare).toLocaleString()} · {String(trip.status).replaceAll('_', ' ')}
              </span>
            </div>
          ))}
        </section>
      ) : tab === 'Earnings' ? (
        <section className="keke-content keke-tab-placeholder">
          <button type="button" className="keke-tab-back" onClick={() => setTab('Home')}>
            ← Home
          </button>
          <h2>Earnings</h2>

          <div className="keke-period" role="tablist" aria-label="Earnings period">
            <button
              type="button"
              role="tab"
              aria-selected={earnPeriod === 'week'}
              className={earnPeriod === 'week' ? 'active' : ''}
              onClick={() => setEarnPeriod('week')}
            >
              This week
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={earnPeriod === 'all'}
              className={earnPeriod === 'all' ? 'active' : ''}
              onClick={() => setEarnPeriod('all')}
            >
              All time
            </button>
          </div>

          {earnings === null && <p>Loading…</p>}
          {earnings && (
            <>
              <div className="keke-hint">
                <span>
                  <strong>
                    {earnPeriod === 'week' ? 'This week' : 'All time'}
                  </strong>
                </span>
                <span>
                  ₦{(earnPeriod === 'week' ? weekTotal : earnings.total).toLocaleString()} ·{' '}
                  {earnPeriod === 'week'
                    ? `${periodRows.length} trip${periodRows.length === 1 ? '' : 's'}`
                    : `${earnings.count} trip${earnings.count === 1 ? '' : 's'}`}
                </span>
              </div>

              {earnPeriod === 'week' && (
                <div className="keke-chart" aria-label="Last 7 days earnings">
                  {weekSeries.map((day) => {
                    const max = Math.max(1, ...weekSeries.map((d) => d.total))
                    const height = day.total > 0
                      ? Math.max(8, Math.round((day.total / max) * 100))
                      : 0
                    return (
                      <div className="keke-chart-col" key={day.key}>
                        <div className="keke-chart-track">
                          {height > 0 && (
                            <div
                              className="keke-chart-bar"
                              style={{ height: `${height}%` }}
                              title={`₦${day.total.toLocaleString()}`}
                            />
                          )}
                        </div>
                        <span>{day.label}</span>
                      </div>
                    )
                  })}
                </div>
              )}

              {periodRows.length === 0 && (
                <p className="keke-data-note">No completed trips in this period yet.</p>
              )}
              {periodRows.slice(0, 20).map((trip) => (
                <div className="keke-hint" key={trip.id}>
                  <span>
                    <strong>{trip.from?.name} → {trip.to?.name}</strong>
                    <span className="muted">
                      {new Date(trip.completed_at ?? trip.created_at).toLocaleDateString()}
                    </span>
                  </span>
                  <span>₦{Number(trip.fare).toLocaleString()}</span>
                </div>
              ))}

              <p className="muted" style={{ fontSize: 13 }}>
                Totals count completed trips only. Payments settle directly
                through Paystack.
              </p>
            </>
          )}
        </section>
      ) : (
        <section className="keke-content keke-tab-placeholder">
          <button type="button" className="keke-tab-back" onClick={() => setTab('Home')}>
            ← Home
          </button>
          <header className="keke-profile-head">
            <div className="kr-avatar" aria-hidden="true">
              K
            </div>
            <h1>Keke {rider?.keke_number ?? '—'}</h1>
            <p>{session?.user?.email}</p>
          </header>

          <div className="keke-stats two">
            <div className="keke-stat">
              <strong>
                {rider?.rating != null ? Number(rider.rating).toFixed(1) : '—'}
              </strong>
              <span>Rating</span>
            </div>
            <div className="keke-stat">
              <strong>{earnings?.count ?? '—'}</strong>
              <span>Trips</span>
            </div>
          </div>

          {rider?.station_id && (
            <div className="keke-hint">
              <span>
                <strong>Station</strong>
                {stations.find((s) => s.id === rider.station_id)?.name ?? 'assigned'}
              </span>
            </div>
          )}

          <button className="keke-signout" type="button" onClick={handleSignOut}>
            Sign out
          </button>
        </section>
      )}

      <nav className="keke-bottom-nav" aria-label="Rider navigation">
        {tabs.map((item) => (
          <button
            key={item}
            type="button"
            className={tab === item ? 'active' : ''}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </nav>
    </main>
  )
}
