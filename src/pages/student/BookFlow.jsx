import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'
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

  const isDrop = mode === 'drop'
  const fromKind = isDrop ? 'pickup' : 'station'

  useEffect(() => {
    supabase
      .from('locations')
      .select('id, name, kind')
      .eq('mode', mode)
      .eq('active', true)
      .order('name')
      .then(({ data }) => setLocations(data ?? []))
  }, [mode])

  const froms = locations.filter((l) => l.kind === fromKind)
  const tos = locations.filter((l) => l.kind === 'destination' && l.name !== from?.name)

  async function pickDestination(l) {
    setTo(l)
    setFare(null)
    const { data } = await supabase
      .from('fares')
      .select('amount')
      .eq('mode', mode)
      .eq('from_id', from.id)
      .eq('to_id', l.id)
      .maybeSingle()
    setFare(data?.amount ?? null)
  }

  return (
    <Layout title={isDrop ? 'Drop' : 'Along'}>
      <Link to="/student/book">← Back</Link>

      {step === 1 && (
        <>
          <h2 style={{ marginTop: 12 }}>{isDrop ? 'Choose your pick-up' : 'Choose your station'}</h2>
          <p className="muted">
            {isDrop ? 'Select one of the campus pick-up points.' : 'You must be at the station to be picked up.'}
          </p>
          {froms.map((l) => (
            <button key={l.id} className={'opt' + (from?.id === l.id ? ' sel' : '')} onClick={() => setFrom(l)}>
              {l.name}
            </button>
          ))}
          <button disabled={!from} onClick={() => { setStep(2); setTo(null); setFare(null) }}>
            Continue
          </button>
        </>
      )}

      {step === 2 && (
        <>
          <p className="muted" style={{ marginTop: 12 }}>From <b>{from.name}</b> · <a href="#" onClick={(e) => { e.preventDefault(); setStep(1) }}>change</a></p>
          <h2>Where are you going?</h2>
          {tos.map((l) => (
            <button key={l.id} className={'opt' + (to?.id === l.id ? ' sel' : '')} onClick={() => pickDestination(l)}>
              {l.name}
            </button>
          ))}

          {to && fare !== null && (
            <div className="fare">
              <b>₦{fare}</b>
              <span className="badge">Fixed fare</span>
              <div style={{ marginTop: 8 }}>Same price for everyone, every time.</div>
            </div>
          )}
          {to && fare === null && <div className="error">No fare is set for this route yet.</div>}

          <button disabled={!to || fare === null} onClick={() => setMessage('Finding a keke comes next. We build it with Theo.')}>
            {isDrop ? 'Find available rides' : 'Find me a ride'}
          </button>
          {message && <div className="ok">{message}</div>}
        </>
      )}
    </Layout>
  )
}
