import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'
import CampusMap from '../../components/CampusMap.jsx'
import { supabase } from '../../lib/supabase'

// One screen flow used by both Drop and Along.
// Drop: pick a pick-up point, then a destination.
// Along: pick a station, then a destination.
export default function BookFlow({ mode }) {
  const [locations, setLocations] = useState([])
  const [from, setFrom] = useState(null)
  const [to, setTo] = useState(null)
  const [fare, setFare] = useState(null)
  const [step, setStep] = useState(1)
  const [message, setMessage] = useState('')
  const [booking, setBooking] = useState(false)
  const [activeRide, setActiveRide] = useState(null)
  const [statusError, setStatusError] = useState('')

  const isDrop = mode === 'drop'
  const fromKind = isDrop ? 'pickup' : 'station'

  useEffect(() => {
    let active = true

    async function loadLocations() {
      const { data, error } = await supabase
        .from('locations')
        .select('id, name, kind, lat, lng')
        .eq('mode', mode)
        .eq('active', true)
        .order('name')

      if (!active) return

      if (error) setMessage(error.message)
      else setLocations(data ?? [])
    }

    loadLocations()

    return () => {
      active = false
    }
  }, [mode])

  // Follow the ride until a rider accepts or dispatch is exhausted.
  useEffect(() => {
    const rideId = activeRide?.id

    if (!rideId || activeRide?.status !== 'searching') return

    let active = true
    let loadingStatus = false

    async function refreshRide() {
      if (loadingStatus) return
      loadingStatus = true

      const { data, error } = await supabase
        .from('rides')
        .select('id, status, keke_id, booking_code, fare, mode')
        .eq('id', rideId)
        .maybeSingle()

      loadingStatus = false

      if (!active) return

      if (error) {
        setStatusError('We could not refresh your ride status. Retrying…')
        return
      }

      if (!data) {
        setStatusError('We could not find your booking. Please contact support.')
        return
      }

      setStatusError('')
      setActiveRide(data)
    }

    refreshRide()

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
            setActiveRide((current) => ({
              ...current,
              ...payload.new,
            }))
          }
        }
      )
      .subscribe()

    // Polling provides a fallback if a realtime update is missed.
    const timer = window.setInterval(refreshRide, 2000)

    return () => {
      active = false
      window.clearInterval(timer)
      supabase.removeChannel(channel)
    }
  }, [activeRide?.id, activeRide?.status])

  const froms = locations.filter((l) => l.kind === fromKind)
  const tos = locations.filter(
    (l) => l.kind === 'destination' && l.name !== from?.name
  )

  // Map points for the current step (only locations with coordinates show).
  const hasCoords = (l) =>
    l.lat !== null && l.lng !== null && !(l.lat === 0 && l.lng === 0)
  const mapPoints =
    step === 2 && to
      ? [from, to].filter(hasCoords)
      : step === 2
        ? [from, ...tos].filter(hasCoords)
        : froms.filter(hasCoords)

  async function pickDestination(location) {
    setTo(location)
    setFare(null)
    setMessage('')

    const { data, error } = await supabase
      .from('fares')
      .select('amount')
      .eq('mode', mode)
      .eq('from_id', from.id)
      .eq('to_id', location.id)
      .maybeSingle()

    if (error) {
      setMessage(error.message)
      return
    }

    setFare(data?.amount ?? null)
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
        })
      } else {
        setActiveRide({
          id: data.ride_id,
          fare: data.fare,
          status: data.status ?? 'searching',
          mode,
        })
      }
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

  function tryAgain() {
    setActiveRide(null)
    setStatusError('')
    setMessage('')
    setFrom(null)
    setTo(null)
    setFare(null)
    setStep(1)
  }

  // Dispatch status screens.
  if (activeRide) {
    const searching = activeRide.status === 'searching'
    const accepted = activeRide.status === 'accepted'
    const noRide = activeRide.status === 'cancelled'

    return (
      <Layout title={isDrop ? 'Drop' : 'Along'}>
        <section style={{ paddingTop: 12 }}>
          {searching && (
            <div className="fare" role="status" aria-live="polite">
              <h2>Finding your Keke…</h2>
              <p className="muted">
                Your request is being offered to eligible riders one at a time.
                Please keep this screen open while we look for someone to accept.
              </p>
              <p><strong>₦{Number(activeRide.fare ?? fare).toLocaleString()}</strong></p>
              <p className="muted">You’ll see an update here when a rider accepts.</p>
              {statusError && <p className="error">{statusError}</p>}
            </div>
          )}

          {accepted && (
            <div className="fare" role="status">
              <h2>Ride accepted!</h2>
              <p>Your Keke has accepted your request.</p>
              <p className="muted">
                Your booking is now assigned to a rider. Keep this screen available
                for your trip details.
              </p>
              {activeRide.booking_code && (
                <p>Booking code: <strong>{activeRide.booking_code}</strong></p>
              )}

              <p>
                <strong>
                  Fare: ₦{Number(activeRide.fare ?? fare).toLocaleString('en-NG')}
                </strong>
              </p>

              <Link
                className="btn"
                to={`/student/pay/${activeRide.id}`}
              >
                Pay now with Paystack
              </Link>

              <div style={{ marginTop: 12 }}>
                <Link to={`/student/verify/${activeRide.id}`}>
                  Show Keke I booked
                </Link>
              </div>

              <div style={{ marginTop: 12 }}>
                <Link to={`/student/ride/${activeRide.id}`}>
                  Open live ride screen
                </Link>
              </div>

              <div style={{ marginTop: 12 }}>
                <Link to="/student">Return to Home</Link>
              </div>
            </div>
          )}

          {noRide && (
            <div className="fare" role="status">
              <h2>No ride available</h2>
              <p className="muted">
                We couldn’t find an eligible Keke to accept your request right now.
                Please try again shortly.
              </p>
              <button type="button" onClick={tryAgain}>
                Try again
              </button>
              <div style={{ marginTop: 12 }}>
                <Link to="/student">Return to Home</Link>
              </div>
            </div>
          )}

          {!searching && !accepted && !noRide && (
            <div className="fare" role="status">
              <h2>Ride status: {activeRide.status?.replaceAll('_', ' ')}</h2>
              <p className="muted">Your booking status has changed.</p>
              <button type="button" onClick={tryAgain}>Book another ride</button>
            </div>
          )}
        </section>
      </Layout>
    )
  }

  return (
    <Layout title={isDrop ? 'Drop' : 'Along'}>
      <Link to="/student/book">← Back</Link>

      {step === 1 && (
        <>
          <h2 style={{ marginTop: 12 }}>
            {isDrop ? 'Choose your pick-up' : 'Choose your station'}
          </h2>

          <p className="muted">
            {isDrop
              ? 'Select one of the campus pick-up points.'
              : 'You must be at the station to be picked up.'}
          </p>

          <CampusMap
            points={from ? [from] : mapPoints}
            height={180}
            onSelect={(point) => setFrom(point)}
          />

          {froms.map((location) => (
            <button
              key={location.id}
              className={'opt' + (from?.id === location.id ? ' sel' : '')}
              onClick={() => setFrom(location)}
            >
              {location.name}
            </button>
          ))}

          <button
            disabled={!from}
            onClick={() => {
              setStep(2)
              setTo(null)
              setFare(null)
              setMessage('')
            }}
          >
            Continue
          </button>
        </>
      )}

      {step === 2 && (
        <>
          <p className="muted" style={{ marginTop: 12 }}>
            From <b>{from.name}</b> ·{' '}
            <a
              href="#"
              onClick={(event) => {
                event.preventDefault()
                setStep(1)
              }}
            >
              change
            </a>
          </p>

          <h2>Where are you going?</h2>

          <CampusMap
            points={mapPoints}
            route={to && hasCoords(from) && hasCoords(to) ? { from, to } : null}
            height={180}
            onSelect={(point) => {
              if (point.id !== from?.id && point.kind === 'destination') {
                pickDestination(point)
              }
            }}
          />

          {tos.map((location) => (
            <button
              key={location.id}
              className={'opt' + (to?.id === location.id ? ' sel' : '')}
              onClick={() => pickDestination(location)}
            >
              {location.name}
            </button>
          ))}

          {to && fare !== null && (
            <div className="fare">
              <b>₦{fare}</b>
              <span className="badge">Fixed fare</span>
              <div style={{ marginTop: 8 }}>
                Same price for everyone, every time.
              </div>
            </div>
          )}

          {to && fare === null && (
            <div className="error">No fare is set for this route yet.</div>
          )}

          <button
            disabled={!to || fare === null || booking}
            onClick={createRide}
          >
            {booking
              ? 'Creating ride...'
              : isDrop
                ? 'Find available rides'
                : 'Find me a ride'}
          </button>

          {message && <div className="error" role="alert">{message}</div>}
        </>
      )}
    </Layout>
  )
}
