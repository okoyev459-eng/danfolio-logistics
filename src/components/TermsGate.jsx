import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../lib/auth.jsx'
import { supabase } from '../lib/supabase'
import './TermsGate.css'

// Bump this whenever the Terms/Privacy text changes so everyone is asked again.
export const TERMS_VERSION = '2026-11-25'

const storageKey = (userId) => `danfolio.terms.${TERMS_VERSION}.${userId}`

function readAccepted(userId) {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(userId)) || 'null')
    return parsed?.version === TERMS_VERSION
  } catch {
    return false
  }
}

// Local mirror of the answer, so the app stays usable if the network is down
// or the request that records consent fails.
function writeAccepted(userId) {
  try {
    localStorage.setItem(
      storageKey(userId),
      JSON.stringify({ version: TERMS_VERSION, acceptedAt: new Date().toISOString() }),
    )
  } catch {
    // Storage unavailable (private mode) — this session only.
  }
}

// Blocking consent gate: a signed-in student who has never accepted the Terms
// of Service + Privacy Policy gets this sheet before they can use the app.
//
// The answer lives on the account (profiles.terms_version, written by the
// accept_terms RPC) so it follows the student to another device, with
// localStorage as a fast local mirror.
export default function TermsGate() {
  const { session, role, ready, signOut } = useAuth()
  const userId = session?.user?.id ?? null
  const gateUser = ready && role === 'student' && userId ? userId : null

  // Read the stored answer for this account during render (no flash of the app
  // behind the sheet). Re-reading when the account changes means one student's
  // answer is never inherited by the next account on a shared device.
  const [consent, setConsent] = useState({ userId: null, accepted: true, checked: true })
  if (gateUser && consent.userId !== gateUser) {
    setConsent({ userId: gateUser, accepted: readAccepted(gateUser), checked: false })
  }

  // Confirm against the account record before showing the sheet, so a student
  // who accepted on another device is not asked again.
  useEffect(() => {
    if (!gateUser || consent.userId !== gateUser || consent.checked) return undefined
    let active = true
    supabase
      .from('profiles')
      .select('terms_version')
      .eq('id', gateUser)
      .maybeSingle()
      .then(({ data }) => {
        if (!active) return
        const serverAccepted = data?.terms_version === TERMS_VERSION
        if (serverAccepted) writeAccepted(gateUser)
        setConsent((prev) =>
          prev.userId === gateUser
            ? { ...prev, accepted: prev.accepted || serverAccepted, checked: true }
            : prev,
        )
      })
    return () => {
      active = false
    }
  }, [gateUser, consent.userId, consent.checked])

  const open =
    Boolean(gateUser) && consent.userId === gateUser && consent.checked && !consent.accepted
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const cardRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    setChecked(false)
    setBusy(false)
    cardRef.current?.focus()
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  function accept() {
    if (!gateUser || !checked) return
    writeAccepted(gateUser)
    setConsent({ userId: gateUser, accepted: true, checked: true })
    // Keep the durable record on the account too. A failure here (offline, or
    // the migration not applied yet) must not trap the student, so the local
    // answer above already lets them through and the RPC is retried next visit.
    supabase.rpc('accept_terms', { p_version: TERMS_VERSION }).then(({ error }) => {
      if (error) console.warn('Terms acceptance was not recorded:', error.message)
    })
  }

  async function decline() {
    setBusy(true)
    await signOut()
    setBusy(false)
  }

  if (!open) return null

  return (
    <div className="tg" role="dialog" aria-modal="true" aria-labelledby="tg-title" aria-describedby="tg-sub">
      <div className="tg-card" ref={cardRef} tabIndex={-1}>
        <span className="tg-badge">Before you ride</span>
        <h2 id="tg-title">Terms of Service and Privacy Policy</h2>
        <p id="tg-sub" className="tg-sub">
          You haven&apos;t accepted our Terms of Service and Privacy Policy yet.
          Please read and accept them to keep using Danfolio Rides.
        </p>

        <ul className="tg-points">
          <li>Fixed campus fares and in-app payment</li>
          <li>Cancellations, refunds and no-show rules</li>
          <li>Location sharing while a trip is active</li>
          <li>Your account and how we handle your data</li>
        </ul>

        <p className="tg-links">
          Read the full{' '}
          <a href="/terms.html" target="_blank" rel="noopener noreferrer">Terms of Service</a>
          {' '}and{' '}
          <a href="/privacy.html" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.
        </p>

        <label className="tg-check">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <span>I have read and agree to the Terms of Service and Privacy Policy.</span>
        </label>

        <button type="button" className="tg-accept" onClick={accept} disabled={!checked}>
          Accept and continue
        </button>
        <button type="button" className="tg-decline" onClick={decline} disabled={busy}>
          {busy ? 'Signing out…' : 'Decline and sign out'}
        </button>
      </div>
    </div>
  )
}
