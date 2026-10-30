import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'
import { useAuth } from '../../lib/auth.jsx'
import { supabase } from '../../lib/supabase'

// Review — student rates a completed ride (spec: reviews, rating 1-5).
// Only completed rides can be reviewed, and only once (reviews.ride_id is
// UNIQUE in the schema).
export default function Review() {
  const { rideId } = useParams()
  const navigate = useNavigate()
  const { session } = useAuth()

  const [ride, setRide] = useState(null)
  const [existing, setExisting] = useState(null)
  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    async function load() {
      const { data } = await supabase
        .from('rides')
        .select('id, status, fare, from:locations!rides_from_id_fkey(name), to:locations!rides_to_id_fkey(name)')
        .eq('id', rideId)
        .maybeSingle()

      if (!active) return
      setRide(data ?? null)

      const { data: review } = await supabase
        .from('reviews')
        .select('id, rating, comment')
        .eq('ride_id', rideId)
        .maybeSingle()

      if (active && review) {
        setExisting(review)
        setRating(review.rating)
        setComment(review.comment ?? '')
      }
      setLoading(false)
    }

    load()
    return () => { active = false }
  }, [rideId])

  async function submit(e) {
    e.preventDefault()
    if (busy) return

    if (rating < 1 || rating > 5) {
      setError('Choose a rating from 1 to 5.')
      return
    }

    setBusy(true)
    setError('')

    // RLS requires student_id = auth.uid() on insert.
    const { error: insertError } = await supabase
      .from('reviews')
      .insert({
        ride_id: rideId,
        student_id: session.user.id,
        rating,
        comment: comment.trim() || null,
      })

    setBusy(false)

    if (insertError) {
      if (insertError.code === '23505') {
        setError('You have already reviewed this ride.')
      } else {
        setError(insertError.message)
      }
      return
    }

    navigate('/student')
  }

  if (loading) {
    return <Layout title="Rate ride"><p className="muted">Loading…</p></Layout>
  }

  if (!ride || ride.status !== 'completed') {
    return (
      <Layout title="Rate ride">
        <div className="error">Only completed rides can be reviewed.</div>
        <Link className="btn" to="/student">Back to home</Link>
      </Layout>
    )
  }

  return (
    <Layout title="Rate ride">
      <Link to={`/student/ride/${rideId}`}>← Back to ride</Link>
      <h2 style={{ marginTop: 16 }}>Rate your ride</h2>
      <p className="muted">
        {ride.from?.name} → {ride.to?.name}
      </p>

      {existing && (
        <div className="ok">
          You already rated this ride {existing.rating}/5. You can update it below.
        </div>
      )}

      <form className="card" onSubmit={submit}>
        <label>Rating</label>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }} role="radiogroup" aria-label="Star rating">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              type="button"
              aria-label={`${star} star${star > 1 ? 's' : ''}`}
              aria-pressed={rating === star}
              onClick={() => setRating(star)}
              style={{
                width: 52, height: 52, margin: 0, marginTop: 0, borderRadius: 14,
                background: star <= rating ? 'var(--blue)' : '#e2e8f0',
                color: star <= rating ? '#fff' : 'var(--navy)',
                fontSize: 22, lineHeight: '52px', padding: 0,
              }}
            >
              ★
            </button>
          ))}
        </div>

        <label style={{ marginTop: 16 }}>Comment (optional)</label>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          maxLength={500}
          placeholder="How was the ride?"
          style={{ width: '100%', borderRadius: 14, border: '1px solid #cbd5e1', padding: 12, font: 'inherit' }}
        />

        {error && <div className="error">{error}</div>}

        <button disabled={busy || rating < 1}>
          {busy ? 'Saving…' : existing ? 'Update review' : 'Submit review'}
        </button>
      </form>
    </Layout>
  )
}
