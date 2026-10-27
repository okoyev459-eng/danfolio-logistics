import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../lib/auth.jsx'
import { supabase } from '../../lib/supabase'
import './request.css'

export default function KekeRequest() {
  const { session } = useAuth()
  const [params] = useSearchParams()
  const rideId = params.get('rideId')
  const [ride, setRide] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    let active = true

    async function loadRide() {
      if (!rideId) {
        setError('No ride was selected. Return home and select a request.')
        setLoading(false)
        return
      }

      const { data, error: fetchError } = await supabase
        .from('rides')
        .select('id, fare, mode, status, keke_id, created_at, from:locations!rides_from_id_fkey(name), to:locations!rides_to_id_fkey(name)')
        .eq('id', rideId)
        .maybeSingle()

      if (!active) return

      if (fetchError) setError(fetchError.message)
      else if (!data) setError('Ride not found, or your account cannot view it.')
      else setRide(data)

      setLoading(false)
    }

    loadRide()
    return () => { active = false }
  }, [rideId])

  async function acceptRide() {
    if (!session?.user?.id || !ride) {
      setError('Your session is unavailable. Please sign in again.')
      return
    }

    setBusy(true)
    setError('')
    setMessage('')

    const { data, error: updateError } = await supabase
      .from('rides')
      .update({ keke_id: session.user.id, status: 'accepted' })
      .eq('id', ride.id)
      .eq('status', 'searching')
      .is('keke_id', null)
      .select('id, status, keke_id')
      .maybeSingle()

    setBusy(false)

    if (updateError) {
      setError(`Could not accept the ride: ${updateError.message}`)
      return
    }

    if (!data) {
      setError('This ride may already have been taken, or database permissions blocked the update.')
      return
    }

    setRide(current => ({ ...current, ...data }))
    setMessage('Ride accepted.')
  }

  return (
    <main className="kr-page">
      <header className="kr-header">
        <Link className="kr-back" to="/keke">← Back to Home</Link>
        <p className="kr-brand">DANFOLIO LOGISTICS</p>
        <h1>Ride request</h1>
        <p className="kr-subtitle">Review the student's booking details.</p>
      </header>

      {loading && <section className="kr-card"><p>Loading ride…</p></section>}

      {!loading && error && !ride && (
        <section className="kr-card">
          <p role="alert">{error}</p>
          <Link className="kr-home-link" to="/keke">Return to Home</Link>
        </section>
      )}

      {!loading && ride && (
        <section className="kr-card">
          <div className="kr-badge">
            {ride.status === 'searching' ? 'NEW REQUEST' : `STATUS · ${ride.status.toUpperCase()}`}
          </div>

          <h2>{ride.mode === 'along' ? 'Along ride' : 'Drop ride'}</h2>

          <div className="kr-route">
            <div className="kr-route-line">
              <span className="kr-dot pickup" />
              <div><small>PICKUP / STATION</small><strong>{ride.from?.name ?? 'Unavailable'}</strong></div>
            </div>
            <div className="kr-route-line">
              <span className="kr-dot destination" />
              <div><small>DESTINATION</small><strong>{ride.to?.name ?? 'Unavailable'}</strong></div>
            </div>
          </div>

          <div className="kr-details">
            <div><small>Fare</small><strong>₦{Number(ride.fare).toLocaleString()}</strong></div>
            <div><small>Ride type</small><strong>{ride.mode}</strong></div>
            <div><small>Status</small><strong>{ride.status.replaceAll('_', ' ')}</strong></div>
          </div>

          {error && <p role="alert">{error}</p>}
          {message && <p role="status">{message}</p>}

          {ride.status === 'searching' && !ride.keke_id && (
            <div className="kr-actions">
              <Link className="kr-decline" to="/keke">Back</Link>
              <button className="kr-accept" onClick={acceptRide} disabled={busy}>
                {busy ? 'Accepting…' : 'Accept request'}
              </button>
            </div>
          )}

          {ride.status !== 'searching' && (
            <p className="kr-note">This ride is no longer waiting for a rider.</p>
          )}
        </section>
      )}
    </main>
  )
}
