import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'
import CampusMap from '../../components/CampusMap.jsx'
import { supabase } from '../../lib/supabase'

// Ride — the live status page for one booking.
//
// Covers the whole spec lifecycle:
//   searching -> accepted -> paid -> arrived -> on_trip -> completed
//   (+ cancelled / refunded side exits)
// with live updates via Realtime (polling fallback), the trip map, ticket and
// verify links, cancellation (with refund when already paid), and review /
// report entry points once the ride finishes.
//
// All status changes go through Edge Functions or the dispatch RPC — this
// page never writes rides/payments/tickets directly (spec section 4).

const ACTIVE_STATUSES = ['searching', 'accepted', 'paid', 'arrived', 'on_trip']

const STATUS_COPY = {
  searching: {
    title: 'Finding your Keke…',
    body: 'Your request is being offered to eligible riders one at a time. Keep this screen open.',
  },
  accepted: {
    title: 'Keke accepted — pay to confirm',
    body: 'A rider is assigned to you. Payment must be completed before the rider starts heading over.',
  },
  paid: {
    title: 'Paid — waiting for your rider',
    body: 'Your ticket is ready. Show it, and the booking code on “Show keke I booked”, when your rider arrives.',
  },
  arrived: {
    title: 'Your rider has arrived',
    body: 'Show your booking code to the rider to start the trip.',
  },
  on_trip: {
    title: 'You are on the trip',
    body: 'Enjoy your ride. The trip can be completed by the rider when you reach your destination.',
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
    body: 'The payment for this ride has been refunded. Bank processing can take a little while.',
  },
}

export default function Ride() {
  const { rideId } = useParams()
  const navigate = useNavigate()

  const [ride, setRide] = useState(null)
  const [ticket, setTicket] = useState(null)
  const [payment, setPayment] = useState(null)
  const [keke, setKeke] = useState(null)
  const [kekePos, setKekesPos] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [notice, setNotice] = useState('')
  const [eta, setEta] = useState(null)

  const load = useCallback(async () => {
    const { data, error: rideError } = await supabase
      .from('rides')
      .select(`
        id, status, fare, mode, booking_code, created_at, completed_at, keke_id,
        from:locations!rides_from_id_fkey(id, name, lat, lng),
        to:locations!rides_to_id_fkey(id, name, lat, lng)
      `)
      .eq('id', rideId)
      .maybeSingle()

    if (rideError) {
      setError('Could not load this booking. Check your connection and try again.')
      return
    }
    if (!data) {
      setError('We could not find this booking.')
      setLoading(false)
      return
    }

    setRide(data)

    if (['paid', 'arrived', 'on_trip', 'completed'].includes(data.status)) {
      const [{ data: t }, { data: p }] = await Promise.all([
        supabase.from('tickets').select('ticket_no, status').eq('ride_id', rideId).maybeSingle(),
        supabase.from('payments').select('status, amount').eq('ride_id', rideId).maybeSingle(),
      ])
      setTicket(t ?? null)
      setPayment(p ?? null)
    }

    if (data.keke_id) {
      const [{ data: profile }, { data: k }, { data: pos }] = await Promise.all([
        supabase.from('profiles').select('full_name, avatar_url').eq('id', data.keke_id).maybeSingle(),
        supabase.from('kekes').select('keke_number').eq('id', data.keke_id).maybeSingle(),
        supabase.from('kekes').select('lat, lng, last_seen').eq('id', data.keke_id).maybeSingle(),
      ])
      setKeke({ name: profile?.full_name, avatar: profile?.avatar_url, number: k?.keke_number })
      if (pos?.lat && pos?.lng) setKekesPos(pos)
    }

    setLoading(false)
  }, [rideId])

  useEffect(() => {
    load()
  }, [load])

  // Live updates: ride row via Realtime, keke position while assigned.
  useEffect(() => {
    if (!rideId) return

    const channel = supabase
      .channel(`student-ride-${rideId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rides', filter: `id=eq.${rideId}` },
        (payload) => {
          if (payload.new) {
            setRide((current) => ({ ...current, ...payload.new }))
          }
        }
      )
      .subscribe()

    // Polling fallback if a realtime event is missed.
    const timer = window.setInterval(load, 4000)

    return () => {
      window.clearInterval(timer)
      supabase.removeChannel(channel)
    }
  }, [rideId, load])

  // Track the assigned keke's position live.
  useEffect(() => {
    if (!ride?.keke_id || !ACTIVE_STATUSES.includes(ride.status)) return

    const channel = supabase
      .channel(`student-keke-pos-${ride.keke_id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'kekes', filter: `id=eq.${ride.keke_id}` },
        (payload) => {
          if (payload.new?.lat && payload.new?.lng) {
            setKekesPos({ lat: payload.new.lat, lng: payload.new.lng })
          }
        }
      )
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [ride?.keke_id, ride?.status])

  const routePoints = useMemo(() => {
    if (!ride) return []
    return [ride.from, ride.to].filter(
      (p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) && !(Number(p.lat) === 0 && Number(p.lng) === 0)
    )
  }, [ride])

  const routeLine = useMemo(() => {
    if (routePoints.length !== 2) return null
    return { from: routePoints[0], to: routePoints[1] }
  }, [routePoints])

  const kekeMarkers = useMemo(
    () => (kekePos ? [{ ...kekePos, keke_number: keke?.number }] : []),
    [kekePos, keke?.number]
  )

  async function cancelRide() {
    if (cancelling) return
    setCancelling(true)
    setError('')
    setNotice('')

    const { data, error: fnError } = await supabase.functions.invoke('cancel-ride', {
      body: { ride_id: rideId },
    })

    setCancelling(false)
    setConfirmCancel(false)

    if (fnError) {
      let detail = fnError.message
      try {
        const payload = await fnError.context?.json?.()
        detail = payload?.error || detail
      } catch {}
      setError(detail || 'Could not cancel the ride. Please try again.')
      return
    }
    if (data?.error) {
      setError(data.error)
      return
    }

    setNotice(
      data?.status === 'refunded'
        ? 'Your ride was cancelled and the payment refunded.'
        : 'Your ride was cancelled.'
    )
    load()
  }

  if (loading) {
    return (
      <Layout title="My ride">
        <p className="muted">Loading your booking…</p>
      </Layout>
    )
  }

  if (!ride) {
    return (
      <Layout title="My ride">
        <div className="error">{error || 'Booking not found.'}</div>
        <Link className="btn" to="/student">Back to home</Link>
      </Layout>
    )
  }

  const copy = STATUS_COPY[ride.status] ?? {
    title: `Ride status: ${String(ride.status).replaceAll('_', ' ')}`,
    body: 'Your booking status has changed.',
  }
  const canCancel = ['searching', 'accepted', 'paid'].includes(ride.status)
  const isFinished = ['completed', 'cancelled', 'refunded'].includes(ride.status)

  return (
    <Layout title="My ride">
      <section style={{ paddingTop: 12 }}>
        <Link to="/student">← Back to home</Link>

        <div className="fare" role="status" aria-live="polite" style={{ marginTop: 16 }}>
          <h2>{copy.title}</h2>
          <p>{copy.body}</p>
          <p>
            <strong>
              {ride.from?.name} → {ride.to?.name}
            </strong>
          </p>
          <p>
            ₦{Number(ride.fare).toLocaleString('en-NG')} ·{' '}
            {ride.mode === 'drop' ? 'Drop' : 'Along'} ·{' '}
            <span className="badge">{String(ride.status).replaceAll('_', ' ')}</span>
          </p>
        </div>

        {error && <div className="error" role="alert">{error}</div>}
        {notice && <div className="ok" role="status">{notice}</div>}

        {keke && (
          <div className="card row">
            <span>
              <span className="muted">Your rider</span>
              <br />
              <b>{keke.name ?? 'Assigned rider'}</b>
            </span>
            {keke.number && <span className="plate">{keke.number}</span>}
          </div>
        )}

        {(routePoints.length > 0 || kekeMarkers.length > 0) && (
          <div style={{ margin: '12px 0' }}>
            <CampusMap
              points={routePoints}
              kekes={kekeMarkers}
              route={routeLine}
              height={220}
              interactive={false}
              onRouteInfo={setEta}
            />
            {eta && ['accepted', 'paid', 'arrived'].includes(ride.status) && (
              <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                Estimated ride time ≈ {Math.max(1, Math.round(eta.seconds / 60))} min
                {' '}(road estimate from OpenStreetMap/OSRM)
              </p>
            )}
          </div>
        )}

        {ride.status === 'accepted' && (
          <Link className="btn" to={`/student/pay/${ride.id}`}>
            Pay ₦{Number(ride.fare).toLocaleString('en-NG')} with Paystack
          </Link>
        )}

        {['paid', 'arrived', 'on_trip'].includes(ride.status) && (
          <Link className="btn" to={`/student/verify/${ride.id}`}>
            Show keke I booked
          </Link>
        )}

        {ticket && (
          <div style={{ marginTop: 12 }}>
            <Link to={`/student/ticket/${ride.id}`}>
              Open ticket {ticket.ticket_no} ({ticket.status})
            </Link>
          </div>
        )}

        {payment && (
          <p className="muted" style={{ marginTop: 8 }}>
            Payment: {payment.status}
          </p>
        )}

        {ride.status === 'completed' && (
          <div style={{ marginTop: 12 }}>
            <Link className="btn secondary" to={`/student/review/${ride.id}`}>
              Rate this ride
            </Link>
            <Link className="btn secondary" to={`/student/report/${ride.id}`} style={{ marginTop: 8 }}>
              Report a problem with this keke
            </Link>
          </div>
        )}

        {canCancel && !confirmCancel && (
          <button
            type="button"
            className="secondary"
            style={{ marginTop: 16 }}
            onClick={() => setConfirmCancel(true)}
          >
            Cancel this ride
          </button>
        )}

        {canCancel && confirmCancel && (
          <div className="card" style={{ marginTop: 16 }}>
            <b>Cancel this ride?</b>
            <p className="muted">
              {ride.status === 'paid'
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
          <button
            type="button"
            className="secondary"
            style={{ marginTop: 16 }}
            onClick={() => navigate('/student/book')}
          >
            Book another ride
          </button>
        )}
      </section>
    </Layout>
  )
}
