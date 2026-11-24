import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'
import CampusMap from '../../components/CampusMap.jsx'
import { supabase } from '../../lib/supabase'
import { useGeolocation } from '../../lib/useGeolocation'
import { distanceMeters, formatDistance, validCoord } from '../../lib/geo'
import { formatDuration, shouldReroute } from '../../lib/routing'
import { matchAnchor, useAnchors } from '../../lib/anchorCoords'
import {
  estimateArrivalSeconds,
  nearbyArrival,
  positionFreshness,
  proximityState,
  routePhaseFor,
} from '../../lib/tracking'
import {
  notificationPermission,
  requestNotificationPermission,
  useArrivalNotice,
} from '../../lib/notify'
// Reuses the live-proximity badge styles (.bk-proximity / .bk-live) shared
// with the booking screen.
import './book.css'

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
  const geo = useGeolocation()

  const [ride, setRide] = useState(null)
  const [ticket, setTicket] = useState(null)
  const [payment, setPayment] = useState(null)
  const [keke, setKeke] = useState(null)
  const [kekePos, setKekesPos] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  // Notification opt-in (a tap, because browsers only grant permission from
  // a user gesture). 'unsupported' hides the control instead of lying.
  const [notifPerm, setNotifPerm] = useState(() => notificationPermission())
  const [notice, setNotice] = useState('')
  const [eta, setEta] = useState(null)
  const [rideLoc, setRideLoc] = useState(null) // ride_locations row (live GPS)
  const [trackSource, setTrackSource] = useState('unknown') // 'live' | 'heartbeat'
  // Dedicated tracking view (spec §3): the Track-ride button expands the
  // map and re-frames the camera on the keke + pick-up, food-delivery style.
  const [trackingView, setTrackingView] = useState(false)
  const mapApiRef = useRef(null) // CampusMap imperative handle (fitPoints)
  const mapWrapRef = useRef(null) // scroll target for the Track button
  const [now, setNow] = useState(Date.now())
  const [online, setOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )

  // Network loss / reconnection: banner + honest "Connecting…" copy so a
  // dropped connection is never mistaken for a dead keke.
  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

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
      setLoading(false)
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
      const [{ data: profile }, { data: k }, { data: pos }, live] = await Promise.all([
        supabase.from('profiles').select('full_name, avatar_url').eq('id', data.keke_id).maybeSingle(),
        supabase.from('kekes')
          .select('keke_number, rating, rating_count, lat, lng, last_seen')
          .eq('id', data.keke_id)
          .maybeSingle(),
        supabase.from('kekes').select('lat, lng, last_seen').eq('id', data.keke_id).maybeSingle(),
        // Live per-ride GPS (migration 20261103100000). Probed, never assumed:
        // if the table has not been applied yet, the page keeps working from
        // the rider's public heartbeat and says so in the freshness line.
        supabase.from('ride_locations')
          .select('lat, lng, accuracy, updated_at')
          .eq('ride_id', rideId)
          .maybeSingle(),
      ])
      setKeke({
        name: profile?.full_name,
        avatar: profile?.avatar_url,
        number: k?.keke_number,
        rating: k?.rating ?? null,
        ratingCount: k?.rating_count ?? 0,
      })
      if (pos?.lat && pos?.lng) setKekesPos(pos)

      if (live?.error) {
        const message = String(live.error.message ?? '')
        const missing =
          live.error.code === 'PGRST205' ||
          live.error.code === '42P01' ||
          /could not find the table|relation .* does not exist|schema cache/i.test(message)
        if (missing) {
          setTrackSource('heartbeat')
          setRideLoc(null)
        }
        // Any other (transient) read error keeps the last known state —
        // a flaky network must not drop the map back to heartbeat mode.
      } else {
        setTrackSource('live')
        setRideLoc(live?.data ?? null)
      }
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
            setKekesPos({
              lat: payload.new.lat,
              lng: payload.new.lng,
              last_seen: payload.new.last_seen ?? null,
            })
          }
        }
      )

    // Live per-ride GPS — subscribed only once the table is confirmed to
    // exist, so a not-yet-applied migration can never break the heartbeat
    // feed that carries this page today.
    if (trackSource === 'live') {
      // '*' so the rider's FIRST fix (an upsert INSERT) shows immediately,
      // and the row DELETE on ride end clears the live pin instead of
      // leaving a dead coordinate on screen.
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ride_locations', filter: `ride_id=eq.${rideId}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            setRideLoc(null)
            return
          }
          const row = payload.new
          if (row?.lat != null && row?.lng != null) {
            setRideLoc({
              lat: row.lat,
              lng: row.lng,
              accuracy: row.accuracy ?? null,
              updated_at: row.updated_at ?? null,
            })
          }
        }
      )
    }

    channel.subscribe()

    return () => supabase.removeChannel(channel)
  }, [ride?.keke_id, ride?.status, rideId, trackSource])

  const routePoints = useMemo(() => {
    if (!ride) return []
    return [ride.from, ride.to].filter(
      (p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) && !(Number(p.lat) === 0 && Number(p.lng) === 0)
    )
  }, [ride])

  // The position the student sees: per-ride live GPS when it exists,
  // otherwise the rider's public heartbeat. Real coordinates only — nothing
  // here is ever interpolated into new "data".
  const kekeLivePos = useMemo(
    () =>
      rideLoc && validCoord(rideLoc)
        ? { lat: Number(rideLoc.lat), lng: Number(rideLoc.lng), accuracy: rideLoc.accuracy ?? null }
        : null,
    [rideLoc],
  )
  const effPos = kekeLivePos ?? kekePos ?? null
  const usingLive = Boolean(kekeLivePos)
  const effUpdatedAt = usingLive
    ? rideLoc?.updated_at ?? null
    : kekePos?.last_seen ?? null

  const rideActive = Boolean(ride) && ACTIVE_STATUSES.includes(ride.status)

  // Freshness clock — only ticks while there is a live position to age.
  useEffect(() => {
    if (!rideActive || !effPos) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 5000)
    return () => window.clearInterval(timer)
  }, [rideActive, Boolean(effPos)])

  // Phase-aware road route (spec 5/7): keke → pick-up while the rider heads
  // over, pick-up → destination once planned / on trip / finished. The
  // origin only re-requests a road route after a real ≥30 m move
  // (shouldReroute), so GPS ticks don't hammer the routing provider.
  const routeRef = useRef(null)
  const routeLine = useMemo(() => {
    if (!ride) return null

    const phase = routePhaseFor(ride.status, Boolean(effPos))
    let desired = null
    if (phase === 'keke_to_pickup' && effPos && validCoord(ride.from)) {
      desired = { from: effPos, to: ride.from }
    } else if (validCoord(ride.from) && validCoord(ride.to)) {
      desired = { from: ride.from, to: ride.to }
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
  }, [ride?.status, effPos, ride?.from, ride?.to])

  const kekeMarkers = useMemo(
    () =>
      effPos
        ? [
            {
              ...effPos,
              // CampusMap classifies the badge from THIS heartbeat, so a
              // delayed position is shown as delayed, never as live.
              last_seen: effUpdatedAt,
              keke_number: keke?.number,
              highlight: true,
            },
          ]
        : [],
    [effPos, effUpdatedAt, keke?.number],
  )

  // One notification per ride the moment its status becomes 'arrived' —
  // fires whether the change arrives by realtime or by the 4 s poll, and
  // never on a page that mounted ALREADY showing the arrival.
  useArrivalNotice(ride)

  // Reference pins for pick-up rows that still carry lat/lng = null (loaded
  // once; last-resort distance reference ONLY — see lib/anchorCoords.js).
  const anchors = useAnchors()

  // Bell tap = the explicit user gesture browsers require before they will
  // even show the permission prompt. Re-taps while granted do nothing.
  async function askNotifications() {
    if (notifPerm === 'unsupported' || notifPerm === 'granted') return
    const result = await requestNotificationPermission()
    setNotifPerm(result)
  }

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
        <p className="muted">{online ? 'Loading your booking…' : 'Connecting…'}</p>
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
  // Pre-boarding states only: a student whose keke has arrived but who has
  // not boarded yet can still walk away (mirrors REDISPATCHABLE_STATUSES
  // minus 'paid' → that one refunds instead). On-trip rides are never
  // cancelled from here — an interruption is the rider/admin flow.
  const canCancel = ['searching', 'accepted', 'paid', 'arrived'].includes(ride.status)
  const isFinished = ['completed', 'cancelled', 'refunded'].includes(ride.status)

  // Honest trip progress (mockup Trip screen bar): remaining straight-line
  // distance vs the full route; hidden when the student's location is off.
  let tripProgress = null
  if (ride.status === 'on_trip' && geo.position && validCoord(ride.from) && validCoord(ride.to)) {
    const total = distanceMeters(ride.from, ride.to)
    const remaining = distanceMeters(geo.position, ride.to)
    if (total > 0) {
      tripProgress = Math.min(100, Math.max(0, Math.round((1 - remaining / total) * 100)))
    }
  }

  // Live proximity of the assigned keke while it is heading over — a real
  // distance from the rider's GPS, SHOWN AS a time-to-arrival (the user
  // thinks in minutes, not metres); never a made-up number. Hidden once
  // the trip is under way, or when NO reference point has coordinates:
  // the student's
  // own position when shared, else the pick-up row's coordinates, else the
  // pick-up's curated reference pin (some location rows still have
  // lat/lng = null — a pin fallback keeps the distance measurable without
  // inventing anything; unmatched names simply stay hidden).
  let kekeProximity = null
  if (
    effPos &&
    ['accepted', 'paid', 'arrived'].includes(ride.status) &&
    validCoord(effPos)
  ) {
    const studentHasPos = Boolean(geo.position && validCoord(geo.position))
    const pickupPoint = validCoord(ride.from)
      ? ride.from
      : matchAnchor(ride.from?.name, anchors)
    // Measure against wherever the student is actually waiting (their own
    // position when shared, otherwise the pick-up point they chose).
    const reference = studentHasPos ? geo.position : pickupPoint
    if (reference && validCoord(reference)) {
      kekeProximity = {
        meters: distanceMeters(reference, effPos),
        label: studentHasPos ? 'from you' : 'from your pick-up',
      }
    }
  }

  // Freshness of the keke's position — computed from the SERVER-stamped
  // updated_at (live GPS) or the rider's heartbeat last_seen, never from a
  // client-set time, so the label cannot be faked by the publisher.
  const freshness = positionFreshness(effUpdatedAt, { now })

  // Arrival countdown: the ROUTING provider's road ETA when it answers,
  // otherwise a distance-based estimate from the REAL measured distance
  // (× campus detour ÷ keke pace) — so a time-to-arrival stays on screen
  // and moves down (or up) as the distance does. Never a made-up number:
  // both inputs are measured, and without a distance there is no line.
  // Hidden only when the position is LOST (>2 min): the rider heartbeat
  // ticks every ~20 s, so a strict "live" (20 s) gate would make the
  // countdown blink on every heartbeat cycle. While the fix is merely
  // stale, the freshness line directly below states the real age
  // ("updating slowly"), and a lost position shows no countdown at all.
  let arrivalEta = null
  if (
    kekeProximity &&
    Number.isFinite(kekeProximity.meters) &&
    freshness.state !== 'lost'
  ) {
    const roadSeconds =
      Number.isFinite(eta?.seconds) && eta.seconds > 0 ? eta.seconds : null
    const estimateSeconds = estimateArrivalSeconds({
      distanceMeters: kekeProximity.meters,
    })
    const seconds = roadSeconds ?? estimateSeconds
    if (seconds !== null) {
      arrivalEta = {
        seconds,
        source: roadSeconds !== null ? 'road' : 'estimate',
      }
    }
  }

  // Honest proximity phase for the badge: only a LIVE heartbeat may claim
  // "nearby" or "approaching"; a stale/lost fix reports "unavailable"
  // with its real age instead of a made-up closeness.
  const proxState = proximityState({
    distance: kekeProximity?.meters ?? null,
    fresh: freshness.state === 'live',
  })

  // "Nearby" is proximity only, and only from a FRESH fix (a stale coordinate
  // can never trigger a false arrival). It never changes ride state — states
  // move exclusively through the existing authorised server-side functions.
  const nearby =
    ['accepted', 'paid'].includes(ride.status) &&
    nearbyArrival({
      distance: kekeProximity?.meters ?? null,
      fresh: freshness.state === 'live',
    })

  return (
    <Layout title="My ride">
      <section style={{ paddingTop: 12 }}>
        {/* A real button (was a Link): same destination, an actual
            control with a proper tap target. */}
        <button
          type="button"
          className="link"
          style={{
            width: 'auto',
            minHeight: 44,
            marginTop: 0,
            padding: '0 2px',
            fontSize: 14,
            fontWeight: 500,
            textAlign: 'left',
          }}
          onClick={() => navigate('/student')}
        >
          ← Back to home
        </button>

        {!online && (
          <div className="error" role="alert" style={{ marginTop: 12 }}>
            You’re offline — live updates will resume when you reconnect.
          </div>
        )}

        {/* Keyed on the status so the words re-enter when the ride actually
            changes state (accepted → paid → arrived → on trip → completed),
            and never on an unrelated re-render. */}
        <h2
          className="ride-status"
          key={`ride-status-${ride.status}`}
          style={{ marginTop: 20 }}
        >
          {copy.title}
        </h2>
        <p
          className="muted ride-status-sub"
          key={`ride-status-sub-${ride.status}`}
          style={{ marginTop: -4 }}
        >
          {copy.body}
        </p>

        <div className="fare" role="status" aria-live="polite">
          <span>{ride.mode === 'drop' ? 'Drop' : 'Along'} · fixed fare</span>
          <b>₦{Number(ride.fare).toLocaleString('en-NG')}</b>
          <span className="badge">{String(ride.status).replaceAll('_', ' ')}</span>
        </div>

        <div className="card" style={{ marginTop: -4 }}>
          <div className="rowline">
            <span className="muted">Route</span>
            <b>{ride.from?.name} → {ride.to?.name}</b>
          </div>
        </div>

        {tripProgress !== null && (
          <>
            <div className="bk-progress" aria-hidden="true">
              <i style={{ width: `${tripProgress}%` }} />
            </div>
            <p className="muted" style={{ fontSize: 13, marginTop: -8 }}>
              {tripProgress}% of the way to {ride.to?.name}
            </p>
          </>
        )}

        {error && <div className="error" role="alert">{error}</div>}
        {notice && <div className="ok" role="status">{notice}</div>}

        {keke && (
          <div className="card row ride-rider">
            <span>
              <span className="muted">Your rider</span>
              <br />
              <b>{keke.name ?? 'Assigned rider'}</b>
              {keke.ratingCount > 0 && (
                <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>
                  ★ {Number(keke.rating).toFixed(1)} · {keke.ratingCount} review
                  {keke.ratingCount === 1 ? '' : 's'}
                </p>
              )}
              {keke.ratingCount === 0 && (
                <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>
                  New rider — no reviews yet
                </p>
              )}
            </span>
            {keke.number && <span className="plate">{keke.number}</span>}
          </div>
        )}

        {/* Nearby arrival indicator — proximity + freshness only; the ride
            status itself is never changed here. */}
        {nearby && (
          <div className="ok" role="status">
            Your keke is nearby —{' '}
            {geo.position && validCoord(geo.position)
              ? 'look around you for it.'
              : `head to ${ride.from?.name ?? 'your pick-up point'}.`}
          </div>
        )}

        {/* Live keke proximity while it is heading to the student — with
            the honest nearby/approaching/unavailable phase (spec §3). */}
        {kekeProximity && (
          <p
            className={'bk-proximity' + (proxState === 'unavailable' ? ' off' : '')}
            role="status"
          >
            {proxState === 'unavailable' ? (
              <>
                <span className="bk-live dim" aria-hidden="true" />
                Keke location unavailable — {freshness.label}
              </>
            ) : (
              <>
                <span className="bk-live" aria-hidden="true" />
                {/* Time-to-arrival, not metres: how long until the keke
                    reaches the student. Both inputs (road ETA or the
                    measured distance) are real; the label says which. */}
                {arrivalEta
                  ? `Keke reaching you in ≈ ${formatDuration(arrivalEta.seconds)}${
                      arrivalEta.source === 'road' ? ' by road' : ' (distance estimate)'
                    }`
                  : `Keke ${formatDistance(kekeProximity.meters)} ${kekeProximity.label}`}
                {proxState !== 'far' && (
                  <>
                    {' · '}
                    <b>{proxState}</b>
                  </>
                )}
              </>
            )}
          </p>
        )}

        {/* Honest freshness of the position above: live GPS vs rider
            heartbeat, and whether it is going stale or has been lost. */}
        {effPos && rideActive && (
          <p className="muted" style={{ fontSize: 13, marginTop: 6 }} role="status">
            {usingLive
              ? 'Live keke GPS'
              : trackSource === 'heartbeat'
                ? 'Rider position (heartbeat)'
                : 'Rider position'}
            {' · '}
            {freshness.label}
            {freshness.state === 'stale' && ' — updating slowly'}
            {freshness.state === 'lost' && ' — location delayed'}
          </p>
        )}

        {/* Arrival notification opt-in. Hidden where the Notification API
            does not exist, and honest about a blocked permission (the
            in-app "Your keke is nearby" banner never depends on it). */}
        {notifPerm !== 'unsupported' && rideActive && (
          <button
            type="button"
            className="link"
            style={{
              width: 'auto',
              minHeight: 44,
              marginTop: 4,
              padding: '0 2px',
              fontSize: 13,
              fontWeight: 500,
              textAlign: 'left',
              opacity: notifPerm === 'denied' ? 0.7 : 1,
            }}
            disabled={notifPerm === 'granted'}
            onClick={askNotifications}
          >
            {notifPerm === 'granted'
              ? '🔔 Arrival notifications on'
              : notifPerm === 'denied'
                ? '🔕 Notifications blocked — allow them in your browser settings'
                : '🔔 Notify me when the rider arrives'}
          </button>
        )}

        {/* No position at all yet — say so instead of drawing a pin at a
            made-up spot (spec §3: never fake GPS). */}
        {!effPos &&
          rideActive &&
          ['accepted', 'paid', 'arrived'].includes(ride.status) && (
            <p className="bk-sub" role="status" style={{ marginTop: 6 }}>
              {online
                ? 'GPS unavailable — waiting for the rider’s first position.'
                : 'Offline — the keke’s position will appear when you reconnect.'}
            </p>
          )}

        {(routePoints.length > 0 || kekeMarkers.length > 0) && (
          <div style={{ margin: '12px 0' }}>
            {rideActive && (
              <button
                type="button"
                className={trackingView ? 'secondary' : undefined}
                onClick={() => {
                  const next = !trackingView
                  setTrackingView(next)
                  if (!next) return
                  // Bring the map into view, then frame pick-up + keke once
                  // the expanded container has resized.
                  mapWrapRef.current?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center',
                  })
                  const frame = () =>
                    mapApiRef.current?.fitPoints(
                      [ride.from, ride.to, effPos].filter(Boolean),
                    )
                  window.requestAnimationFrame(frame)
                  window.setTimeout(frame, 350)
                }}
              >
                {trackingView ? 'Close tracking' : '📍 Track ride'}
              </button>
            )}
            <div ref={mapWrapRef}>
              <CampusMap
                ref={mapApiRef}
                points={routePoints}
                kekes={kekeMarkers}
                route={routeLine}
                userLocation={geo.position}
                userAccuracy={geo.accuracy}
                height={trackingView ? 420 : 220}
                onRouteInfo={setEta}
              />
            </div>
            {arrivalEta && kekeProximity && (
              <p className="muted" style={{ fontSize: 13, marginTop: 4 }} role="status">
                {arrivalEta.seconds <= 0
                  ? 'Keke arriving now'
                  : `Keke reaching you in ≈ ${formatDuration(arrivalEta.seconds)}${
                      arrivalEta.source === 'road' ? ' by road' : ' (distance estimate)'
                    }`}
              </p>
            )}
            {eta?.seconds != null && ride.status === 'on_trip' && (
              <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                Full pick-up → destination route ≈ {formatDuration(eta.seconds)} by road
              </p>
            )}
            {!arrivalEta && ride.status === 'on_trip' && effPos && (
              <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                Road ETA unavailable right now — we keep retrying automatically.
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
            <Link className="btn secondary" to={`/student/ticket/${ride.id}`}>
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
              {['paid', 'arrived'].includes(ride.status)
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
