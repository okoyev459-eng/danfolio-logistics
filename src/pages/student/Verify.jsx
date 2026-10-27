import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../../lib/auth.jsx'
import { supabase } from '../../lib/supabase'

// "Show keke I booked": a screen the student holds up so the keke rider
// can be sure he is picking the right person. Big face, big name.
export default function Verify() {
  const { rideId } = useParams()
  const { session } = useAuth()
  const [me, setMe] = useState(null)
  const [ride, setRide] = useState(null)
  const [keke, setKeke] = useState(null)
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    async function load() {
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, matric_no, avatar_url')
        .eq('id', session.user.id)
        .single()
      setMe(profile)

      const { data: r } = await supabase
        .from('rides')
        .select('id, mode, booking_code, keke_id, from:locations!rides_from_id_fkey(name), to:locations!rides_to_id_fkey(name)')
        .eq('id', rideId)
        .single()
      setRide(r)

      if (r?.keke_id) {
        const [{ data: p }, { data: k }] = await Promise.all([
          supabase.from('profiles').select('full_name').eq('id', r.keke_id).single(),
          supabase.from('kekes').select('keke_number').eq('id', r.keke_id).single(),
        ])
        setKeke({ name: p?.full_name, number: k?.keke_number })
      }
    }
    load()
  }, [rideId, session])

  if (!me || !ride) return <div className="verify"><p>Loading…</p></div>

  const initials = (me.full_name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()

  return (
    <div className="verify">
      <b style={{ fontFamily: 'Poppins, system-ui' }}>Danfolio Logistics</b>
      {' '}<span className="badge">{ride.mode === 'drop' ? 'Drop' : 'Along'}</span>

      {me.avatar_url
        ? <img className="avatar" src={me.avatar_url} alt="Passenger" />
        : <div className="avatar" role="img" aria-label="Passenger photo">{initials}</div>}

      <div style={{ font: '700 34px/1.1 Poppins, system-ui' }}>{me.full_name}</div>
      <div style={{ margin: '6px 0 16px' }}>{me.matric_no}</div>

      <div className="card">
        <div className="rowline"><span className="muted">Booking code</span><span className="code">{ride.booking_code}</span></div>
        <div className="dash" />
        <div className="rowline"><span className="muted">Route</span><b>{ride.from?.name} to {ride.to?.name}</b></div>
      </div>

      {keke && (
        <div className="card">
          <div className="rowline">
            <span><span className="muted">Keke rider</span><br /><b>{keke.name}</b></span>
            <span className="plate">{keke.number}</span>
          </div>
        </div>
      )}

      <p style={{ fontWeight: 600 }}>Rider: match the face, name and code · {now.toLocaleTimeString()}</p>
      <Link className="btn white" to={`/student/ticket/${ride.id}`}>Done</Link>
    </div>
  )
}
