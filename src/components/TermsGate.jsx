import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../lib/auth.jsx'
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

// Blocking consent gate: a signed-in student who has never accepted the Terms
// of Service + Privacy Policy gets this sheet before they can use the app.
//
// Acceptance is stored per account and per terms version in localStorage, so
// this stays a client-only change (no profiles migration). A server-side
// consent record would need its own column/table.
export default function TermsGate() {
  const { session, role, ready, signOut } = useAuth()
  const userId = session?.user?.id ?? null
  const gateUser = ready && role === 'student' && userId ? userId : null

  // Read the stored answer for this account during render (no flash of the app
  // behind the sheet). Re-reading when the account changes means one student's
  // answer is never inherited by the next account on a shared device.
  const [consent, setConsent] = useState({ userId: null, accepted: true })
  if (gateUser && consent.userId !== gateUser) {
    setConsent({ userId: gateUser, accepted: readAccepted(gateUser) })
  }

  const open = Boolean(gateUser) && consent.userId === gateUser && !consent.accepted
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const cardRef = useRef(null)

  useEffect(() => {
    if (!open) return
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
    try {
      localStorage.setItem(
        storageKey(gateUser),
        JSON.stringify({ version: TERMS_VERSION, acceptedAt: new Date().toISOString() }),
      )
    } catch {
      // Storage unavailable (private mode) — let this session through only.
    }
    setConsent({ userId: gateUser, accepted: true })
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
