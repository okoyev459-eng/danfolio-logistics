import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../lib/auth.jsx'
import { supabase } from '../../lib/supabase'
import CampusMap from '../../components/CampusMap.jsx'
import { distanceMeters, validCoord } from '../../lib/geo'
import './home.css'
import './request.css'

const tabs = ['Home', 'Trips', 'Earnings', 'Profile']

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
// from the request's own sent_at -> expires_at window.
function OfferRing({ secondsLeft, totalSeconds }) {
  const r = 58
  const circumference = 2 * Math.PI * r // ≈ 364.4 (mockup uses 365)
  const fraction = Math.max(0, Math.min(1, secondsLeft / Math.max(1, totalSeconds)))
  const mmss = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`

  return (
    <svg
      width="140"
      height="140"
      viewBox="0 0 140 140"
      role="img"
      aria-label={`${secondsLeft} seconds left`}
      style={{ display: 'block', margin: '0 auto' }}
    >
      <circle cx="70" cy="70" r={r} fill="none" stroke="#DBEAFE" strokeWidth="10" />
      <circle
        cx="70"
        cy="70"
        r={r}
        fill="none"
        stroke="#2563EB"
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

export default function KekeHome() {
  const { session, signOut } = useAuth()
  const userId = session?.user?.id

  const [rider, setRider] = useState(null)
  const [online, setOnline] = useState(false)
  const [onlineSince, setOnlineSince] = useState(null)
  const [presenceBusy, setPresenceBusy] = useState(false)
  const [offer, setOffer] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [tab, setTab] = useState('Home')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [handledExpiry, setHandledExpiry] = useState('')
  const [activeTrip, setActiveTrip] = useState(null)
  const [tripStudent, setTripStudent] = useState(null)
  const [tripEta, setTripEta] = useState(null)
  const [stations, setStations] = useState([])
  const [stationChoice, setStationChoice] = useState('')
  const [queuePosition, setQueuePosition] = useState(null)
  const [trips, setTrips] = useState(null)
  const [earnings, setEarnings] = useState(null)
  const [earnPeriod, setEarnPeriod] = useState('week')
  const [boardCode, setBoardCode] = useState('')
  // 'map' = the full-screen mockup trip views (K6/K7/K8); 'card' = the
  // compact trip card. The back button on the trip screens returns here.
  const [tripView, setTripView] = useState('map')

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
        const shouldBeOnline = data.status === 'online' && stillFresh

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
    if (!userId || !online) {
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

  useEffect(() => {
    if (!userId || !online) {
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
  }, [userId, online])

  // Load the ride this rider is physically on, so the trip actions know which
  // ride to act on. Read-only; every status change goes through a backend
  // function (mark-arrived / start-trip / complete-trip).
  useEffect(() => {
    let active = true

    async function loadActiveTrip() {
      if (rider?.status !== 'on_trip') {
        setActiveTrip(null)
        setTripStudent(null)
        return
      }

      const { data, error: tripError } = await supabase
        .from('rides')
        .select(`
          id, status, fare, booking_code, student_id,
          from:locations!rides_from_id_fkey(name, lat, lng),
          to:locations!rides_to_id_fkey(name, lat, lng),
          tickets:tickets(ticket_no, status)
        `)
        .eq('keke_id', userId)
        .in('status', ['accepted', 'paid', 'arrived', 'on_trip'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!active) return

      if (tripError) {
        setError(tripError.message)
      } else {
        setActiveTrip(data)
      }
    }

    loadActiveTrip()

    // Live updates (student pays → 'paid', cancellation frees the rider…).
    const channel = supabase
      .channel(`rider-trip-${userId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rides', filter: `keke_id=eq.${userId}` },
        () => loadActiveTrip()
      )
      .subscribe()

    const poll = window.setInterval(loadActiveTrip, 4000)

    return () => {
      active = false
      window.clearInterval(poll)
      supabase.removeChannel(channel)
    }
  }, [rider?.status, userId])

  // Student details for the trip screens (name + call button). Ride
  // participants may read each other's profiles; degrade gracefully if not.
  useEffect(() => {
    let active = true

    async function loadStudent() {
      if (!activeTrip?.student_id) {
        setTripStudent(null)
        return
      }

      const { data } = await supabase
        .from('profiles')
        .select('full_name, phone')
        .eq('id', activeTrip.student_id)
        .maybeSingle()

      if (active) setTripStudent(data ?? null)
    }

    loadStudent()
    return () => { active = false }
  }, [activeTrip?.student_id])

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

  useEffect(() => {
    if (!online || !userId) return

    let stopped = false

    async function heartbeat() {
      try {
        const position = await getPosition()
        if (stopped) return

        const update = { last_seen: new Date().toISOString() }
        if (position) {
          update.lat = position.lat
          update.lng = position.lng
        }

        const { data, error: updateError } = await supabase
          .from('kekes')
          .update(update)
          .eq('id', userId)
          .eq('status', 'online')
          .select('id, status, last_seen')
          .maybeSingle()

        if (stopped) return

        if (updateError) {
          setError(`Heartbeat failed: ${updateError.message}`)
        } else if (!data) {
          setError('Heartbeat was not saved. Check that this rider account is online.')
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
    const timer = window.setInterval(heartbeat, 20000)

    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [online, userId])

  async function toggleOnline() {
    if (!userId || presenceBusy) return
    if (rider?.status === 'on_trip') return

    setPresenceBusy(true)
    setError('')
    setNotice('')

    const nextOnline = !online
    const position = nextOnline ? await getPosition() : null
    const update = {
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
      setNotice('Ride accepted! The booking has been assigned to you.')
      setOnline(false)
      setOnlineSince(null)
      setTripView('map')
      setRider((current) => current ? { ...current, status: 'on_trip' } : current)
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

  async function markArrived() {
    if (!activeTrip) return
    const result = await invokeTripFunction(
      'mark-arrived',
      { ride_id: activeTrip.id },
      'Arrival recorded. Waiting for the student to board.'
    )
    if (result) setActiveTrip((t) => (t ? { ...t, status: 'arrived' } : t))
  }

  async function startTrip() {
    if (!activeTrip) return
    if (!/^\d{4}$/.test(boardCode.trim())) {
      setError('Enter the 4-digit booking code shown by the student.')
      return
    }
    const result = await invokeTripFunction(
      'start-trip',
      { ride_id: activeTrip.id, booking_code: boardCode.trim() },
      'Trip started. Have a safe ride.'
    )
    if (result) {
      setActiveTrip((t) => (t ? { ...t, status: 'on_trip' } : t))
      setBoardCode('')
    }
  }

  async function completeTrip() {
    if (!activeTrip) return
    const result = await invokeTripFunction(
      'complete-trip',
      { ride_id: activeTrip.id },
      'Trip completed. You are back online and can receive new offers.'
    )
    if (result) {
      setActiveTrip(null)
      setTripView('map')
      setRider((current) => current
        ? { ...current, status: 'online', last_seen: new Date().toISOString() }
        : current)
      setOnline(true)
      setOnlineSince(Date.now())
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

  const unavailable = rider?.status === 'unavailable'
  const onTrip = rider?.status === 'on_trip'
  const sessionMs = online && onlineSince ? now - onlineSince : null

  // The rider's own live position (heartbeat + realtime self-row updates).
  const riderPos = useMemo(
    () => (validCoord(rider) ? { lat: Number(rider.lat), lng: Number(rider.lng) } : null),
    [rider?.lat, rider?.lng]
  )

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

  const tripRoute = useMemo(() => {
    if (!activeTrip) return null
    if (activeTrip.status === 'on_trip') {
      return riderPos && validCoord(tripTo) ? { from: riderPos, to: tripTo } : null
    }
    if (riderPos && validCoord(tripFrom)) return { from: riderPos, to: tripFrom }
    if (tripFrom && tripTo) return { from: tripFrom, to: tripTo }
    return null
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
  if (offer) {
    const isAlong = offer.ride.mode === 'along'
    return (
      <main className="keke-app keke-offer-open">
        <div className="ko-overlay" role="dialog" aria-modal="true" aria-labelledby="ko-title">
          <section className="ko-modal">
            <header className="ko-head">
              <p className="ko-eyebrow">{offer.ride.from?.name ?? 'New request'}</p>
              <h2 id="ko-title">
                {isAlong ? 'New Along request' : 'New Drop request'}
              </h2>
            </header>

            <div className="ko-ring-wrap" aria-live="polite">
              <OfferRing secondsLeft={secondsLeft} totalSeconds={offerWindow} />
            </div>

            <div className="ko-body">
              <div className="ko-route">
                <div>
                  <small>Pick-up</small>
                  <strong>{offer.ride.from?.name ?? 'Pickup location'}</strong>
                </div>
                <div>
                  <small>Destination</small>
                  <strong>{offer.ride.to?.name ?? 'Destination'}</strong>
                </div>
              </div>

              <div className="ko-fare">
                <span>Fare</span>
                <strong>₦{Number(offer.ride.fare).toLocaleString()}</strong>
              </div>

              <p className="ko-timer-note">
                No reply in {offerWindow} seconds moves it to the next keke.
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
  // While on a trip, Home shows the trip (card or map) and the other tabs
  // stay reachable so the rider is never stuck (Profile has Sign out).
  if (onTrip && (tab === 'Home' || tripView === 'map')) {
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

    // Compact trip card — the destination of the back button on the
    // full-screen trip views. Every action is available here too.
    if (tripView === 'card') {
      const paidCard = ['paid', 'arrived', 'on_trip'].includes(activeTrip.status)
      return (
        <main className="keke-app">
          <header className="keke-bar">
            <span className="keke-bar-title">Current trip</span>
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

          <section className="keke-content">
            <div className="keke-hint">
              <span>
                <strong>
                  {tripFrom?.name ?? 'Pick-up'} → {tripTo?.name ?? 'Destination'}
                </strong>
                <span>
                  Booking {activeTrip.booking_code} · ₦
                  {Number(activeTrip.fare).toLocaleString()}
                </span>
                {activeTrip.status === 'accepted' && (
                  <span>
                    Waiting for the student’s payment. Mark arrival once you
                    reach the pickup point.
                  </span>
                )}
                {activeTrip.status === 'paid' && (
                  <span>Head to the pickup point, then mark your arrival.</span>
                )}
                {activeTrip.status === 'arrived' && (
                  <span>
                    Student is boarding. Ask for the 4-digit booking code and
                    start the trip.
                  </span>
                )}
                {activeTrip.status === 'on_trip' && (
                  <span>
                    {paidCard ? 'Paid by student · ticket issued · ' : ''}
                    Heading to {tripTo?.name ?? 'the destination'}.
                  </span>
                )}
              </span>
            </div>

            {tripStudent?.phone && (
              <a className="kr-call" href={`tel:${tripStudent.phone}`} style={{ marginTop: 10 }}>
                Call student
              </a>
            )}

            {(activeTrip.status === 'accepted' || activeTrip.status === 'paid') && (
              <button type="button" className="ko-accept" disabled={busy} onClick={markArrived}>
                {busy ? 'Please wait…' : 'I have arrived'}
              </button>
            )}

            {activeTrip.status === 'arrived' && (
              <>
                <CodeBoxes
                  value={boardCode}
                  onChange={setBoardCode}
                  onSubmit={startTrip}
                  busy={busy}
                />
                <button
                  type="button"
                  className="ko-accept"
                  disabled={busy || boardCode.length !== 4}
                  onClick={startTrip}
                >
                  {busy ? 'Please wait…' : 'Start trip'}
                </button>
              </>
            )}

            {activeTrip.status === 'on_trip' && (
              <>
                {tripProgress !== null && (
                  <div className="bk-progress" aria-hidden="true">
                    <i style={{ width: `${tripProgress}%` }} />
                  </div>
                )}
                <button type="button" className="ko-accept" disabled={busy} onClick={completeTrip}>
                  {busy ? 'Please wait…' : 'Complete trip'}
                </button>
              </>
            )}
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
            <p>
              {tripFrom?.name ?? 'Pick-up'} → {tripTo?.name ?? 'Destination'}
            </p>
          </header>

          <section className="keke-content keke-trip-sheet">
            <p className="ko-eyebrow" style={{ textAlign: 'center', color: '#64748b' }}>
              Ask for the booking code the student is showing
            </p>

            <CodeBoxes
              value={boardCode}
              onChange={setBoardCode}
              onSubmit={startTrip}
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

            <button
              type="button"
              className="ko-accept"
              disabled={busy || boardCode.length !== 4}
              onClick={startTrip}
            >
              {busy ? 'Please wait…' : 'Start trip'}
            </button>

            <button
              type="button"
              className="keke-signout ghost"
              style={{ marginTop: 10 }}
              disabled={busy}
              onClick={() => setBoardCode('')}
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
            disabled={presenceBusy || onTrip || loading || !rider}
            onClick={toggleOnline}
          >
            <span />
          </button>

          <div className="keke-brand">
            <span>Danfolio Logistics</span>
            <h1>
              {unavailable
                ? 'You are unavailable'
                : `You are ${online ? 'online' : 'offline'}`}
            </h1>
          </div>
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
          <div className={`keke-hint ${online ? '' : 'offline'}`}>
            <span>
              {online
                ? 'You are available for student ride requests.'
                : unavailable
                  ? 'You are marked unavailable and will not receive offers.'
                  : 'Go online when you are ready to receive ride requests.'}
            </span>
            <strong>
              {online
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

          {online && !offer && !loading && (
            <div className="keke-hint">
              <strong>Waiting for your next offer</strong>
              <span>Keep this page open while you are online.</span>
            </div>
          )}

          {!online && (
            <p className="keke-data-note">
              {unavailable
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

          <button className="keke-signout" type="button" onClick={signOut}>
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
