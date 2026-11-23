import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// ForgotPassword — sends a password-reset email (spec end-of-project list).
// Supabase delivers the link to the account's email; the link opens the
// app's recovery route where a new password is set.
const RESEND_COOLDOWN_SECONDS = 60

export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!cooldownUntil) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [cooldownUntil])

  const secondsLeft = Math.max(0, Math.ceil((cooldownUntil - now) / 1000))

  async function sendReset(e) {
    e?.preventDefault?.()
    if (busy || secondsLeft > 0) return
    setBusy(true)
    setError('')

    const { error: fnError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
    })

    setBusy(false)

    if (fnError) {
      // Keep generic for account-existence/privacy where possible, but show a
      // clear message for throttling/network failures so users know what to do.
      const msg = fnError.message || 'Could not send reset email.'
      if (/rate|limit|too many/i.test(msg)) {
        setError('Too many requests. Please wait before trying again.')
        setCooldownUntil(Date.now() + RESEND_COOLDOWN_SECONDS * 1000)
      } else {
        setError('Could not send a reset email right now. Please try again.')
      }
      return
    }

    setSent(true)
    setCooldownUntil(Date.now() + RESEND_COOLDOWN_SECONDS * 1000)
  }

  return (
    <div className="page">
      <h1>Reset password</h1>
      <p>Enter your email and we will send you a reset link.</p>

      {sent ? (
        <div className="card">
          <div className="ok" role="status">
            If that email has an account, a reset link is on its way. Check your
            inbox (and spam folder).
          </div>
          {error && <div className="error" role="alert">{error}</div>}
          <button type="button" onClick={sendReset} disabled={busy || secondsLeft > 0}>
            {busy ? 'Sending…' : secondsLeft > 0 ? `Resend in ${secondsLeft}s` : 'Resend reset link'}
          </button>
        </div>
      ) : (
        <form className="card" onSubmit={sendReset}>
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          {error && <div className="error" role="alert">{error}</div>}
          <button disabled={busy || secondsLeft > 0}>
            {busy ? 'Sending…' : secondsLeft > 0 ? `Resend in ${secondsLeft}s` : 'Send reset link'}
          </button>
        </form>
      )}

      <p className="center"><Link to="/login">Back to sign in</Link></p>
    </div>
  )
}
