import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'
import { supabase } from '../../lib/supabase'

// Admin ride & booking management — see every ride with payment/ticket,
// cancel stuck bookings (cancel-ride) and refund paid rides (admin-refund).
// Rides themselves have no UPDATE policy: every action goes through the
// backend functions, exactly like the apps do (spec section 4).
const FILTERS = {
  Active: ['searching', 'accepted', 'paid', 'arrived', 'on_trip'],
  Today: null, // handled by date compare
  All: null,
}

const ACTIVE = FILTERS.Active

export default function AdminRides() {
  const [rides, setRides] = useState(null)
  const [filter, setFilter] = useState('Active')
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function load() {
    const { data, error: readError } = await supabase
      .from('rides')
      .select(`
        id, status, fare, mode, booking_code, created_at, completed_at,
        from:locations!rides_from_id_fkey(name),
        to:locations!rides_to_id_fkey(name),
        student:profiles!rides_student_id_fkey(full_name, matric_no),
        keke:kekes!rides_keke_id_fkey(keke_number),
        payments(status, amount),
        tickets(ticket_no, status)
      `)
      .order('created_at', { ascending: false })
      .limit(100)

    if (readError) setError(readError.message)
    else setRides(data ?? [])
  }

  useEffect(() => {
    load()
    const timer = window.setInterval(load, 20000)
    return () => window.clearInterval(timer)
  }, [])

  async function invoke(name, rideId, label) {
    setBusyId(rideId)
    setError('')
    setNotice('')

    const { data, error: fnError } = await supabase.functions.invoke(name, {
      body: { ride_id: rideId },
    })

    setBusyId(null)

    if (fnError) {
      let detail = fnError.message
      try {
        const payload = await fnError.context?.json?.()
        detail = payload?.error || detail
      } catch {}
      setError(`${label} failed: ${detail}`)
      return
    }
    if (data?.error) {
      setError(`${label} failed: ${data.error}`)
      return
    }

    setNotice(`${label} succeeded for ride ${rideId.slice(0, 8)}.`)
    load()
  }

  const today = new Date().toISOString().slice(0, 10)
  const visible = (rides ?? []).filter((r) => {
    if (filter === 'Active') return ACTIVE.includes(r.status)
    if (filter === 'Today') return r.created_at.slice(0, 10) === today
    return true
  })

  return (
    <Layout title="Admin · Rides">
      <Link to="/admin">← Dashboard</Link>
      <h2>Rides & bookings</h2>

      <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        {Object.keys(FILTERS).map((name) => (
          <button
            key={name}
            type="button"
            className={filter === name ? '' : 'secondary'}
            style={{ height: 40, marginTop: 0, lineHeight: '40px', fontSize: 14 }}
            onClick={() => setFilter(name)}
          >
            {name}
          </button>
        ))}
      </div>

      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="ok" role="status">{notice}</div>}
      {rides === null && !error && <p className="muted">Loading…</p>}
      {rides !== null && visible.length === 0 && (
        <div className="card muted">No rides in this view.</div>
      )}

      {visible.map((ride) => {
        const payment = Array.isArray(ride.payments) ? ride.payments[0] : ride.payments
        const ticket = Array.isArray(ride.tickets) ? ride.tickets[0] : ride.tickets
        const student = Array.isArray(ride.student) ? ride.student[0] : ride.student
        const keke = Array.isArray(ride.keke) ? ride.keke[0] : ride.keke

        return (
          <div className="card" key={ride.id}>
            <div className="row">
              <b>{ride.from?.name} → {ride.to?.name}</b>
              <span className="badge">{String(ride.status).replaceAll('_', ' ')}</span>
            </div>
            <p className="muted" style={{ fontSize: 14 }}>
              {ride.mode} · ₦{Number(ride.fare).toLocaleString()} · code {ride.booking_code}
              <br />
              {student ? `${student.full_name ?? 'student'} (${student.matric_no ?? '—'})` : 'student —'}
              {keke && <> · keke {keke.keke_number}</>}
              <br />
              {new Date(ride.created_at).toLocaleString()}
              {payment && <> · payment {payment.status}</>}
              {ticket && <> · ticket {ticket.ticket_no} ({ticket.status})</>}
            </p>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {['searching', 'accepted'].includes(ride.status) && (
                <button
                  type="button"
                  className="secondary"
                  style={{ marginTop: 0, width: 'auto', padding: '0 14px', height: 40, lineHeight: '40px', fontSize: 14 }}
                  disabled={busyId === ride.id}
                  onClick={() => invoke('cancel-ride', ride.id, 'Cancel')}
                >
                  {busyId === ride.id ? 'Working…' : 'Cancel booking'}
                </button>
              )}

              {['paid', 'arrived'].includes(ride.status) && (
                <button
                  type="button"
                  className="secondary"
                  style={{ marginTop: 0, width: 'auto', padding: '0 14px', height: 40, lineHeight: '40px', fontSize: 14 }}
                  disabled={busyId === ride.id}
                  onClick={() => invoke('admin-refund', ride.id, 'Refund')}
                >
                  {busyId === ride.id ? 'Working…' : 'Refund via Paystack'}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </Layout>
  )
}
