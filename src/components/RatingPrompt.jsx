import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth.jsx'
import { shouldOfferRating } from '../lib/uiRules.js'

const DISMISSED_KEY = 'danfolio:rating-dismissed'

function readDismissed() {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed : [])
  } catch {
    return new Set()
  }
}

function writeDismissed(ids) {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]))
  } catch {
    // localStorage may be unavailable; in-memory suppression still applies.
  }
}

export default function RatingPrompt() {
  const location = useLocation()
  const { session, role, ready } = useAuth()
  const [candidate, setCandidate] = useState(null)
  const [dismissed, setDismissed] = useState(readDismissed)

  const userId = session?.user?.id
  const isStudent = ready && role === 'student' && Boolean(userId)

  const hide = useCallback((rideId) => {
    setDismissed((prev) => {
      const next = new Set(prev)
      next.add(rideId)
      writeDismissed(next)
      return next
    })
    setCandidate((current) => (current?.id === rideId ? null : current))
  }, [])

  useEffect(() => {
    if (!isStudent) {
      setCandidate(null)
      return undefined
    }

    let active = true

    async function check() {
      const { data: rides, error } = await supabase
        .from('rides')
        .select(`
          id, status, completed_at, created_at,
          from:locations!rides_from_id_fkey(name),
          to:locations!rides_to_id_fkey(name)
        `)
        .eq('student_id', userId)
        .eq('status', 'completed')
        .order('completed_at', { ascending: false, nullsFirst: false })
        .limit(5)

      if (!active || error || !rides) return

      const eligible = rides.filter(
        (r) => shouldOfferRating(r.status, false) && !dismissed.has(r.id)
      )
      if (eligible.length === 0) {
        setCandidate(null)
        return
      }

      const ids = eligible.map((r) => r.id)
      const { data: reviews } = await supabase
        .from('reviews')
        .select('ride_id')
        .in('ride_id', ids)

      if (!active) return
      const reviewed = new Set((reviews ?? []).map((r) => r.ride_id))
      reviewed.forEach((id) => hide(id))

      const next = eligible.find((r) => !reviewed.has(r.id)) ?? null
      setCandidate(next)
    }

    check()
    return () => {
      active = false
    }
  }, [isStudent, userId, dismissed, hide])

  // Don't stack on top of the review form itself.
  if (!candidate) return null
  if (location.pathname === `/student/review/${candidate.id}`) return null

  const route = [candidate.from?.name, candidate.to?.name].filter(Boolean).join(' → ')

  return (
    <div className="rating-prompt-backdrop" role="dialog" aria-modal="true" aria-label="Rate your ride">
      <div className="rating-prompt card pop-in">
        <p className="badge" style={{ margin: 0 }}>Ride completed</p>
        <h2 style={{ marginTop: 10 }}>How was your ride?</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          {route || 'Your recent ride'} is complete. A quick rating helps keep trips safe and reliable.
        </p>
        <div className="rating-prompt-actions">
          <Link
            className="btn"
            to={`/student/review/${candidate.id}`}
            onClick={() => hide(candidate.id)}
          >
            Rate ride
          </Link>
          <button type="button" className="secondary" onClick={() => hide(candidate.id)}>
            Not now
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          Dismissal is saved on this device only.
        </p>
      </div>
    </div>
  )
}
