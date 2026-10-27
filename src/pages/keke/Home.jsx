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

        if (data.status === 'online' && !stillFresh) {
          await supabase
            .from('kekes')
            .update({ status: 'offline' })
            .eq('id', userId)
        }

        setRider({ ...data, status: shouldBeOnline ? 'online' : data.status === 'on_trip' ? 'on_trip' : 'offline' })
        setOnline(shouldBeOnline)
      }

      setLoading(false)
    }

    loadRider()

    return () => { active = false }
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
        from:locations!rides_from_id_fkey(name),
        to:locations!rides_to_id_fkey(name)
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
      setNotice('You are online and can receive ride offers.')
      loadCurrentOffer()
    } else {
      setNotice('You are now offline.')
    }
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
            disabled={presenceBusy || rider?.status === 'on_trip' || loading || !rider}
            onClick={toggleOnline}
          >
            <span />
          </button>

          <div className="keke-brand">
            <span>Danfolio Logistics</span>
            <h1>
              {rider?.status === 'on_trip'
                ? 'You are on a trip'
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
                : rider?.status === 'on_trip'
                  ? 'Finish your current trip before receiving another request.'
                  : 'Go online when you are ready to receive ride requests.'}
            </span>
            <strong>
              {online
                ? 'A request will appear here automatically.'
                : 'The system will offer rides to eligible riders one at a time.'}
            </strong>
          </div>

          <h2>Ride offers</h2>

          {online && !offer && !loading && (
            <div className="keke-hint">
              <strong>Waiting for your next offer</strong>
              <span>Keep this page open while you are online.</span>
            </div>
          )}

          {!online && rider?.status !== 'on_trip' && (
            <p className="keke-data-note">You are offline and will not receive new offers.</p>
          )}

          {tab === 'Home' && offer && (
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
      ) : (
        <section className="keke-content keke-tab-placeholder">
          <h2>{tab}</h2>
          {tab === 'Trips' && <p>Your trip history will appear here.</p>}
          {tab === 'Earnings' && <p>Your confirmed earnings will appear here.</p>}
          {tab === 'Profile' && (
            <>
              <p>Manage your rider account.</p>
              <button className="keke-signout" type="button" onClick={signOut}>
                Sign out
              </button>
            </>
          )}
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
