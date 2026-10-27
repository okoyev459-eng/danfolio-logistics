import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'
import { useAuth } from '../../lib/auth.jsx'
import { supabase } from '../../lib/supabase'

export default function StudentHome() {
  const { session } = useAuth()
  const [name, setName] = useState('')
  const [rides, setRides] = useState(null)

  useEffect(() => {
    supabase
      .from('profiles')
      .select('full_name')
      .eq('id', session.user.id)
      .single()
      .then(({ data }) => setName(data?.full_name?.split(' ')[0] ?? ''))

    supabase
      .from('rides')
      .select('id, fare, status, created_at, from:locations!rides_from_id_fkey(name), to:locations!rides_to_id_fkey(name)')
      .order('created_at', { ascending: false })
      .limit(5)
      .then(({ data }) => setRides(data ?? []))
  }, [session])

  return (
    <Layout title="Student">
      <h2>Hey {name}, where to?</h2>
      <Link className="btn" to="/student/book">Book a ride</Link>

      <h2 style={{ marginTop: 28 }}>Recent rides</h2>
      {rides === null && <p className="muted">Loading…</p>}
      {rides && rides.length === 0 && <div className="card muted">No rides yet. Book your first one.</div>}
      {rides && rides.map((r) => (
        <Link className="plain" to={`/student/ticket/${r.id}`} key={r.id}>
          <div className="card row">
            <span>
              {r.from?.name} to {r.to?.name}
              <br />
              <span className="muted">{new Date(r.created_at).toLocaleDateString()} · {r.status}</span>
            </span>
            <span className="badge">₦{r.fare}</span>
          </div>
        </Link>
      ))}
    </Layout>
  )
}
