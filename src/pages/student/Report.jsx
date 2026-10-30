import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'
import { useAuth } from '../../lib/auth.jsx'
import { supabase } from '../../lib/supabase'

// Report — student reports a problem with a keke (spec: reports, ticket
// attached). The report row stores ride_id; the ride's ticket is reachable
// from it, which is what "the ticket is attached" means in the schema.
const REASONS = [
  'Rider behaviour',
  'Wrong destination',
  'Overcharging / fare dispute',
  'Safety concern',
  'Vehicle condition',
  'Something else',
]

export default function Report() {
  const { rideId } = useParams()
  const { session } = useAuth()

  const [ride, setRide] = useState(null)
  const [ticketNo, setTicketNo] = useState(null)
  const [reason, setReason] = useState(REASONS[0])
  const [details, setDetails] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    async function load() {
      const { data } = await supabase
        .from('rides')
        .select('id, status, keke_id, from:locations!rides_from_id_fkey(name), to:locations!rides_to_id_fkey(name), ticket:tickets(ticket_no)')
        .eq('id', rideId)
        .maybeSingle()

      if (!active) return
      setRide(data ?? null)

      const ticket = Array.isArray(data?.ticket) ? data.ticket[0] : data?.ticket
      setTicketNo(ticket?.ticket_no ?? null)
      setLoading(false)
    }

    load()
    return () => { active = false }
  }, [rideId])

  async function submit(e) {
    e.preventDefault()
    if (busy) return

    if (!details.trim()) {
      setError('Please describe what happened.')
      return
    }

    setBusy(true)
    setError('')

    // RLS requires student_id = auth.uid() on insert; status defaults to open.
    const { error: insertError } = await supabase.from('reports').insert({
      ride_id: rideId,
      student_id: session.user.id,
      keke_id: ride?.keke_id ?? null,
      reason,
      details: details.trim().slice(0, 1000),
    })

    setBusy(false)

    if (insertError) {
      setError(insertError.message)
      return
    }

    setDone(true)
  }

  if (loading) {
    return <Layout title="Report"><p className="muted">Loading…</p></Layout>
  }

  if (!ride) {
    return (
      <Layout title="Report">
        <div className="error">We could not find this booking.</div>
        <Link className="btn" to="/student">Back to home</Link>
      </Layout>
    )
  }

  if (done) {
    return (
      <Layout title="Report">
        <div className="ok" role="status">
          Your report has been sent to Danfolio support.
          {ticketNo && <> Ticket {ticketNo} is attached to the report.</>}
        </div>
        <Link className="btn" to="/student">Back to home</Link>
      </Layout>
    )
  }

  return (
    <Layout title="Report">
      <Link to={`/student/ride/${rideId}`}>← Back to ride</Link>
      <h2 style={{ marginTop: 16 }}>Report this keke</h2>
      <p className="muted">
        {ride.from?.name} → {ride.to?.name}
        {ticketNo && <> · ticket {ticketNo} attached</>}
      </p>

      <form className="card" onSubmit={submit}>
        <label>Reason</label>
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          style={{ width: '100%', height: 48, borderRadius: 14, border: '1px solid #cbd5e1', font: 'inherit', padding: '0 12px' }}
        >
          {REASONS.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>

        <label>What happened?</label>
        <textarea
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          rows={4}
          maxLength={1000}
          required
          placeholder="Describe the issue"
          style={{ width: '100%', borderRadius: 14, border: '1px solid #cbd5e1', padding: 12, font: 'inherit' }}
        />

        {error && <div className="error">{error}</div>}

        <button disabled={busy}>{busy ? 'Sending…' : 'Send report'}</button>
      </form>
    </Layout>
  )
}
