import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// ResetPassword — the target of the emailed recovery link. Once Supabase
// establishes a recovery session on this route, the user sets a new password.
export default function ResetPassword() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // With a valid recovery link, the hash tokens establish a session.
    supabase.auth.getSession().then(({ data }) => {
      setReady(Boolean(data.session))
      if (!data.session) {
        setError('This reset link is invalid or has expired. Please request a new one.')
      }
    })
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    if (password !== confirm) {
      setError('Both passwords must match.')
      return
    }
    setBusy(true)
    setError('')

    const { error: updateError } = await supabase.auth.updateUser({ password })

    setBusy(false)

    if (updateError) {
      setError(updateError.message)
      return
    }

    setDone(true)
  }

  return (
    <div className="page">
      <h1>Choose a new password</h1>

      {done ? (
        <>
          <div className="ok">Your password has been changed. You can sign in now.</div>
          <p className="center"><Link to="/login">Sign in</Link></p>
        </>
      ) : !ready ? (
        <p className="muted">Checking your reset link…</p>
      ) : (
        <form className="card" onSubmit={handleSubmit}>
          <label>New password (at least 6 characters)</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={6}
            required
          />
          <label>Repeat password</label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            minLength={6}
            required
          />
          {error && <div className="error">{error}</div>}
          <button disabled={busy}>{busy ? 'Saving…' : 'Save new password'}</button>
        </form>
      )}

      <p className="center"><Link to="/login">Back to sign in</Link></p>
    </div>
  )
}
