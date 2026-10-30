import { useEffect, useState } from 'react'
import { useAuth } from '../../lib/auth.jsx'
import { supabase } from '../../lib/supabase'
import './home.css'

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

export default function KekeHome() {
  const { session, signOut } = useAuth()
  const userId = session?.user?.id

  const [rider, setRider] = useState(null)
  const [online, setOnline] = useState(false)
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
  const [stations, setStations] = useState([])
  const [stationChoice, setStationChoice] = useState('')
  const [queuePosition, setQueuePosition] = useState(null)
  const [trips, setTrips] = useState(null)
  const [earnings, setEarnings] = useState(null)
  const [boardCode, setBoardCode] = useState('')

  useEffect(() => {
    if (!userId) return

    let active = true

    async function loadRider() {
      const { data, error: readError } = await supabase
        .from('kekes')
        .select('id, keke_number, status, station_id, lat, lng, last_seen')
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
        return
      }

      const { data, error: tripError } = await supabase
        .from('rides')
        .select(`
          id, status, fare, booking_code,
          from:locations!rides_from_id_fkey(name),
          to:locations!rides_to_id_fkey(name)
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
      .select('id, keke_number, status, station_id, lat, lng, last_seen')
      .maybeSingle()

    setPresenceBusy(false)

    if (updateError || !data) {
      setError(updateError?.message || 'Could not update your online status.')
      return
    }

    setRider(data)
    setOnline(data.status === 'online')

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
      .select('id, keke_number, status, station_id, lat, lng, last_seen')
      .maybeSingle()

    setPresenceBusy(false)

    if (updateError || !data) {
      setError(updateError?.message || 'Could not update your status.')
      return
    }

    setRider(data)
    setOnline(false)
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
      setRider((current) => current
        ? { ...current, status: 'online', last_seen: new Date().toISOString() }
        : current)
      setOnline(true)
    }
  }

  // Trip history + earnings (Trips / Earnings tabs).
  useEffect(() => {
    if (!userId || (tab !== 'Trips' && tab !== 'Earnings')) return
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
        .limit(30)

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
      })
    }

    loadHistory()
    return () => { active = false }
  }, [userId, tab])

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

  const unavailable = rider?.status === 'unavailable'
  const onTrip = rider?.status === 'on_trip'

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
              {onTrip
                ? 'You are on a trip'
                : unavailable
                  ? 'You are unavailable'
                  : `You are ${online ? 'online' : 'offline'}`}
            </h1>
            {rider?.keke_number && <small>Keke {rider.keke_number}</small>}
          </div>
        </div>

        <section className="keke-earnings-today" aria-label="Rider availability">
          <span>Rider status</span>
          <strong>{loading ? 'Loading…' : rider?.status ?? 'Unavailable'}</strong>
        </section>
      </header>

      {error && <div className="keke-hint offline" role="alert">{error}</div>}
      {notice && <div className="keke-hint" role="status">{notice}</div>}

      {tab === 'Home' ? (
        <section className="keke-content">
          <div className={`keke-hint ${online ? '' : 'offline'}`}>
            <span>
              {online
                ? 'You are available for student ride requests.'
                : onTrip
                  ? 'Finish your current trip before receiving another request.'
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
                style={{ width: '100%', height: 48, borderRadius: 14, border: '1px solid #cbd5e1', font: 'inherit', padding: '0 12px', marginTop: 8 }}
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

          {!onTrip && online && (
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

          {onTrip && (
            <div className="keke-hint offline" aria-label="Current trip">
              <span>
                <strong>Current trip</strong>
                <span>
                  {activeTrip
                    ? `${activeTrip.from?.name ?? 'Pickup'} to ${activeTrip.to?.name ?? 'Destination'}`
                    : 'No active trip was found for this account.'}
                </span>
                {activeTrip && (
                  <span>
                    Booking {activeTrip.booking_code} · ₦
                    {Number(activeTrip.fare).toLocaleString()}
                  </span>
                )}
                {activeTrip && activeTrip.status === 'accepted' && (
                  <span>
                    Waiting for the student’s payment. Mark arrival once you
                    reach the pickup point.
                  </span>
                )}
                {activeTrip && activeTrip.status === 'paid' && (
                  <span>Head to the pickup point, then mark your arrival.</span>
                )}
                {activeTrip && activeTrip.status === 'arrived' && (
                  <span>
                    Student is boarding. Ask for the 4-digit booking code and
                    start the trip.
                  </span>
                )}
              </span>

              {activeTrip && activeTrip.status === 'accepted' && (
                <button type="button" className="ko-accept" disabled={busy} onClick={markArrived}>
                  {busy ? 'Please wait…' : 'Mark arrived at pickup'}
                </button>
              )}

              {activeTrip && activeTrip.status === 'paid' && (
                <button type="button" className="ko-accept" disabled={busy} onClick={markArrived}>
                  {busy ? 'Please wait…' : 'Mark arrived at pickup'}
                </button>
              )}

              {activeTrip && activeTrip.status === 'arrived' && (
                <div style={{ marginTop: 10 }}>
                  <input
                    inputMode="numeric"
                    pattern="\d{4}"
                    maxLength={4}
                    value={boardCode}
                    onChange={(e) => setBoardCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="4-digit booking code"
                    aria-label="4-digit booking code"
                    style={{ textAlign: 'center', letterSpacing: 8, fontWeight: 700 }}
                  />
                  <button
                    type="button"
                    className="ko-accept"
                    disabled={busy || boardCode.length !== 4}
                    onClick={startTrip}
                    style={{ marginTop: 8 }}
                  >
                    {busy ? 'Please wait…' : 'Start trip'}
                  </button>
                </div>
              )}

              {activeTrip && activeTrip.status === 'on_trip' && (
                <button
                  type="button"
                  className="ko-accept"
                  disabled={busy}
                  onClick={completeTrip}
                >
                  {busy ? 'Please wait…' : 'Trip completed'}
                </button>
              )}
            </div>
          )}

          <h2>Ride offers</h2>

          {online && !offer && !loading && (
            <div className="keke-hint">
              <strong>Waiting for your next offer</strong>
              <span>Keep this page open while you are online.</span>
            </div>
          )}

          {!online && !onTrip && (
            <p className="keke-data-note">
              {unavailable
                ? 'You are unavailable and will not receive new offers.'
                : 'You are offline and will not receive new offers.'}
            </p>
          )}

          {offer && (
            <div className="ko-overlay" role="dialog" aria-modal="true" aria-labelledby="ko-title">
              <section className="ko-modal">
                <p className="ko-eyebrow">NEW RIDE REQUEST</p>
                <h2 id="ko-title">Accept this ride?</h2>
                <div className="ko-countdown" aria-live="polite">
                  <strong>{secondsLeft}</strong>
                  <span>seconds left</span>
                </div>

                <div className="ko-route">
                  <div>
                    <small>PICKUP</small>
                    <strong>{offer.ride.from?.name ?? 'Pickup location'}</strong>
                  </div>
                  <div>
                    <small>DESTINATION</small>
                    <strong>{offer.ride.to?.name ?? 'Destination'}</strong>
                  </div>
                </div>

                <div className="ko-fare">
                  <span>Fare</span>
                  <strong>₦{Number(offer.ride.fare).toLocaleString()}</strong>
                </div>

                <p className="ko-timer-note">
                  If you do not respond within 15 seconds, this request will be offered
                  to the next eligible rider.
                </p>

                {error && <p role="alert" className="ko-error">{error}</p>}

                <div className="ko-actions">
                  <button
                    type="button"
                    className="ko-decline"
                    disabled={busy}
                    onClick={() => respond('declined')}
                  >
                    Decline
                  </button>
                  <button
                    type="button"
                    className="ko-accept"
                    disabled={busy || secondsLeft <= 0}
                    onClick={() => respond('accepted')}
                  >
                    {busy ? 'Please wait…' : 'Accept ride'}
                  </button>
                </div>
              </section>
            </div>
          )}
        </section>
      ) : tab === 'Trips' ? (
        <section className="keke-content keke-tab-placeholder">
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
          <h2>Earnings</h2>
          {earnings === null && <p>Loading…</p>}
          {earnings && (
            <>
              <div className="keke-hint">
                <span><strong>Today</strong></span>
                <span>
                  ₦{earnings.todayTotal.toLocaleString()} · {earnings.todayCount} trip{earnings.todayCount === 1 ? '' : 's'}
                </span>
              </div>
              <div className="keke-hint">
                <span><strong>All time (completed trips)</strong></span>
                <span>
                  ₦{earnings.total.toLocaleString()} · {earnings.count} trip{earnings.count === 1 ? '' : 's'}
                </span>
              </div>
              <p className="muted" style={{ fontSize: 13 }}>
                Totals count completed trips only. Payments settle directly
                through Paystack.
              </p>
            </>
          )}
        </section>
      ) : (
        <section className="keke-content keke-tab-placeholder">
          <h2>Profile</h2>
          <p>
            Keke {rider?.keke_number ?? '—'}
            <br />
            <span className="muted">{session?.user?.email}</span>
          </p>
          {rider?.station_id && (
            <p className="muted">
              Station: {stations.find((s) => s.id === rider.station_id)?.name ?? 'assigned'}
            </p>
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
