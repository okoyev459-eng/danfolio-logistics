import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import ResendLink from '../components/ResendLink.jsx'
import { emailErrorMessage } from '../lib/emailErrors.js'

// ForgotPassword — sends a password-reset email (spec end-of-project list).
// Supabase delivers the link to the account's email; the link opens the
// app's recovery route where a new password is set.
// Remember that a reset email was just sent FOR THIS TAB, so a refresh keeps
// the "check your inbox" panel (and its 60 s resend countdown) instead of
// showing the empty form again — which would let a refresh bypass the wait.
const SENT_KEY = 'danfolio.reset.sent'

function readSent() {
  try {
    const raw = window.sessionStorage.getItem(SENT_KEY)
    const data = raw ? JSON.parse(raw) : null
    return data && typeof data.email === 'string' ? data : null
  } catch {
    return null
  }
}

function writeSent(email) {
  try {
    window.sessionStorage.setItem(SENT_KEY, JSON.stringify({ email, at: Date.now() }))
  } catch {
    // Private mode: the panel still works for this page view.
  }
}

export default function ForgotPassword() {
  const [restored] = useState(readSent)
  const [email, setEmail] = useState(restored?.email ?? '')
  const [error, setError] = useState('')
  const [sent, setSent] = useState(Boolean(restored?.email))
  const [busy, setBusy] = useState(false)

  // One place for the reset call: the first send and the "Resend link"
  // button must hit the same endpoint with the same redirect target.
  function sendReset() {
    return supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
    })
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')

    const { error: fnError } = await sendReset()

    setBusy(false)

    if (fnError) {
      setError(emailErrorMessage(fnError))
      return
    }

    writeSent(email.trim())
    setSent(true)
  }

  return (
    <div className="page">
      <h1>Reset password</h1>
      <p>Enter your email and we will send you a reset link.</p>

      {sent ? (
        <>
          <div className="ok">
            If that email has an account, a reset link is on its way. Check your
            inbox (and spam folder).
          </div>
          <ResendLink
            onSend={sendReset}
            scope="forgot"
            label="Resend email"
            sentNotice="If that email has an account, a new reset link is on its way. Check your inbox and spam."
          />
        </>
      ) : (
        <form className="card" onSubmit={handleSubmit}>
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          {error && <div className="error">{error}</div>}
          <button disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
        </form>
      )}

      <p className="center"><Link to="/login">Back to sign in</Link></p>
    </div>
  )
}
