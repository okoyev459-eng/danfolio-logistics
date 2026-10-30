import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// ForgotPassword — sends a password-reset email (spec end-of-project list).
// Supabase delivers the link to the account's email; the link opens the
// app's recovery route where a new password is set.
export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')

    const { error: fnError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
    })

    setBusy(false)

    if (fnError) {
      setError(fnError.message)
      return
    }

    setSent(true)
  }

  return (
    <div className="page">
      <h1>Reset password</h1>
      <p>Enter your email and we will send you a reset link.</p>

      {sent ? (
        <div className="ok">
          If that email has an account, a reset link is on its way. Check your
          inbox (and spam folder).
        </div>
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
