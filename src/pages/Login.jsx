import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { toLoginEmail } from '../lib/kekeLogin'
import { Brand, Icon } from './Landing.jsx'
import './landing.css'
import './auth.css'

// Sign-in on the redesigned auth shell (.auth). The auth logic is unchanged:
// keke riders type their keke number and toLoginEmail() maps it to the
// internal rider email before signInWithPassword().
export default function Login() {
  const [id, setId] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  async function handleSubmit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({
      email: toLoginEmail(id),
      password,
    })
    setBusy(false)
    if (error) setError(error.message)
    else navigate('/')
  }

  return (
    <div className="auth">
      <aside className="auth-brand">
        <Brand />
        <div>
          <p className="auth-tagline">
            Fixed fares. Verified riders.
            <span>Safe rides on campus.</span>
          </p>
          <ul className="auth-brand-points">
            <li><Icon name="check" size={17} /> Fixed campus fares, zero bargaining</li>
            <li><Icon name="nav" size={17} /> Live GPS tracking on every trip</li>
            <li><Icon name="receipt" size={17} /> Ticket slip as proof of payment</li>
          </ul>
        </div>
        <p className="auth-brand-foot"><i /> Campus Hub active · Zone 01</p>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-card-brand"><Brand compact /></div>
          <h1>Welcome back</h1>
          <p className="auth-sub">Sign in to book, track and pay for your campus rides.</p>

          <form onSubmit={handleSubmit}>
            <label htmlFor="login-id">Student email or keke number</label>
            <input
              id="login-id"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="you@school.edu or KEKE 214 UNI"
              autoComplete="username"
              required
            />
            <div className="auth-note">
              <Icon name="keke" size={16} />
              <span><b>Riders:</b> enter your keke number instead of an email.</span>
            </div>

            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your password"
              autoComplete="current-password"
              required
            />

            {error && <div className="error" role="alert">{error}</div>}

            <button className="auth-btn" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div className="auth-links">
            <Link to="/forgot-password">Forgot password?</Link>
            <div className="auth-links-row">
              <span>New student? <Link to="/signup">Create an account</Link></span>
            </div>
          </div>
          <p className="auth-foot">Campus micro-transit · © 2026 Danfolio Logistics</p>
        </div>
      </main>
    </div>
  )
}
