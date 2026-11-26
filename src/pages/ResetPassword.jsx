import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { resetPasswordErrorMessage } from '../lib/emailErrors.js'

// ResetPassword — the target of the emailed recovery link. Once Supabase
// establishes a recovery session on this route, the user sets a new password.
//
// Expired / already-used links arrive with an error in the URL hash (or with
// no session at all), so the screen says so plainly and offers a fresh link
// instead of leaving the user on a form that can never work.

const INVALID_LINK_MESSAGE =
  'This reset link is invalid or has expired. Request a new link and try again.'

function linkErrorFromHash(hash) {
  const raw = String(hash ?? '').replace(/^#/, '')
  if (!raw) return ''
  const params = new URLSearchParams(raw)
  if (params.get('error') || params.get('error_code')) {
    return params.get('error_description')?.replaceAll('+', ' ') || 'expired'
  }
  return ''
}

export default function ResetPassword() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  // 'checking' → 'ready' (recovery session present) | 'invalid' (bad link)
  const [linkState, setLinkState] = useState('checking')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true

    if (linkErrorFromHash(window.location.hash)) {
      setLinkState('invalid')
      return undefined
    }

    // The Supabase client processes the recovery tokens asynchronously, so
    // the auth event is the authoritative signal; the delayed getSession()
    // is only a fallback for a link that carries no usable session.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return
      if (event === 'PASSWORD_RECOVERY' || (session && event === 'SIGNED_IN')) {
        setLinkState('ready')
      }
    })

    const timer = window.setTimeout(() => {
      supabase.auth.getSession().then(({ data }) => {
        if (!active) return
        setLinkState((current) => (current === 'ready' ? current : data.session ? 'ready' : 'invalid'))
      })
    }, 900)

    return () => {
      active = false
      window.clearTimeout(timer)
      sub.subscription.unsubscribe()
    }
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
      setError(resetPasswordErrorMessage(updateError))
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
      ) : linkState === 'checking' ? (
        <p className="muted">Checking your reset link…</p>
      ) : linkState === 'invalid' ? (
        <>
          <div className="error" role="alert">{INVALID_LINK_MESSAGE}</div>
          <Link className="btn" to="/forgot-password">Request a new link</Link>
          <p className="muted" style={{ marginTop: 8 }}>
            Reset links can only be used once, and they expire after an hour.
          </p>
        </>
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
          {error && <div className="error" role="alert">{error}</div>}
          <button disabled={busy}>{busy ? 'Saving…' : 'Save new password'}</button>
        </form>
      )}

      <p className="center"><Link to="/login">Back to sign in</Link></p>
    </div>
  )
}
