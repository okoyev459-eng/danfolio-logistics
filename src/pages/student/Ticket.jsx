import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'
import { supabase } from '../../lib/supabase'

// Ticket slip: proof of payment the student can show if anything goes wrong.
export default function Ticket() {
  const { rideId } = useParams()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      const { data: ride, error } = await supabase
        .from('rides')
        .select('id, fare, mode, status, created_at, keke_id, from:locations!rides_from_id_fkey(name), to:locations!rides_to_id_fkey(name), ticket:tickets(ticket_no, status)')
        .eq('id', rideId)
        .single()
      if (error) return setError('Could not load this ticket.')

      let keke = null
      if (ride.keke_id) {
        const [{ data: p }, { data: k }] = await Promise.all([
          supabase.from('profiles').select('full_name').eq('id', ride.keke_id).single(),
          supabase.from('kekes').select('keke_number').eq('id', ride.keke_id).single(),
        ])
        keke = { name: p?.full_name, number: k?.keke_number }
      }
      const ticket = Array.isArray(ride.ticket) ? ride.ticket[0] : ride.ticket
      setData({ ride, keke, ticket })
    }
    load()
  }, [rideId])

  if (error) return <Layout title="Student"><div className="error">{error}</div></Layout>
  if (!data) return <Layout title="Student"><p className="muted">Loading…</p></Layout>

  const { ride, keke, ticket } = data

  return (
    <Layout title="Student">
      <Link to="/student">← Back</Link>
      <div style={{ textAlign: 'center', margin: '16px 0' }}>
        <h2>{ticket ? 'Payment received' : 'No ticket yet'}</h2>
        <div className="muted">Show this slip to your keke rider</div>
      </div>

      {ticket && (
        <div className="slip">
          <div className="rowline">
            <b>Danfolio ticket</b>
            <span className="muted">{ticket.ticket_no}</span>
          </div>
          <div className="dash" />
          <div className="rowline"><span className="muted">Route</span><b>{ride.from?.name} to {ride.to?.name}</b></div>
          <div className="rowline"><span className="muted">Type</span><b>{ride.mode === 'drop' ? 'Drop' : 'Along'}</b></div>
          {keke && (
            <>
              <div className="rowline"><span className="muted">Rider</span><b>{keke.name}</b></div>
              <div className="rowline"><span className="muted">Keke</span><span className="plate">{keke.number}</span></div>
            </>
          )}
          <div className="rowline"><span className="muted">Paid</span><span className="badge">₦{ride.fare}</span></div>
          <div className="rowline"><span className="muted">Date</span><span>{new Date(ride.created_at).toLocaleString()}</span></div>
          <div className="rowline"><span className="muted">Status</span><b>{ticket.status === 'used' ? 'Used' : 'Unused'}</b></div>
          <div className="dash" />
          <div className="muted" style={{ textAlign: 'center' }}>
            Keep this slip. It is your proof of payment if there is any dispute.
          </div>
        </div>
      )}

      {ticket && ticket.status === 'unused' && (
        <Link className="btn" to={`/student/verify/${ride.id}`}>Show keke I booked</Link>
      )}
    </Layout>
  )
}
