import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Brand, Icon } from './Landing.jsx'
import './landing.css'
import './auth.css'

// Sign-up on the redesigned auth shell (.auth).
// The matriculation-number field was removed on request. No migration is
// needed: profiles.matric_no is nullable and the handle_new_user() trigger
// reads it from metadata with ->>'matric_no' (NULL when absent), and every
// display site already null-guards ('no matric' / '—' / conditional render).
export default function SignUp() {
  const [form, setForm] = useState({ full_name: '', email: '', phone: '', password: '' })
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })

  async function handleSubmit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    setInfo('')
    const { data, error } = await supabase.auth.signUp({
      email: form.email.trim(),
      password: form.password,
      options: {
        data: {
          full_name: form.full_name.trim(),
          phone: form.phone.trim(),
        },
      },
    })
    setBusy(false)
    if (error) return setError(error.message)
    if (data.session) navigate('/')
    else setInfo('Account created. Check your email to confirm, then sign in.')
  }

  return (
    <div className="auth">
      <aside className="auth-brand">
        <Brand />
        <div>
          <p className="auth-tagline">
            Ride the campus,
            <span>hassle-free.</span>
          </p>
          <ul className="auth-brand-points">
            <li><Icon name="check" size={17} /> Know the price before you board</li>
            <li><Icon name="pay" size={17} /> Pay in the app — no cash at the gate</li>
            <li><Icon name="receipt" size={17} /> Proof of payment for every trip</li>
          </ul>
        </div>
        <p className="auth-brand-foot"><i /> Campus Hub active · Zone 01</p>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-card-brand"><Brand compact /></div>
          <h1>Create your account</h1>
          <p className="auth-sub">
            Sign up with your <b>email</b> and <b>phone number</b> — it takes
            under a minute.
          </p>

          <form onSubmit={handleSubmit}>
            <label htmlFor="su-name">Full name</label>
            <input
              id="su-name"
              value={form.full_name}
              onChange={set('full_name')}
              placeholder="Your full name"
              autoComplete="name"
              required
            />

            <label htmlFor="su-email">Email</label>
            <input
              id="su-email"
              type="email"
              value={form.email}
              onChange={set('email')}
              placeholder="you@school.edu"
              autoComplete="email"
              required
            />

            <label htmlFor="su-phone">Phone number</label>
            <input
              id="su-phone"
              type="tel"
              value={form.phone}
              onChange={set('phone')}
              placeholder="+234"
              autoComplete="tel"
              required
            />

            <label htmlFor="su-password">Password (at least 6 characters)</label>
            <input
              id="su-password"
              type="password"
              value={form.password}
              onChange={set('password')}
              placeholder="Create a password"
              autoComplete="new-password"
              minLength={6}
              required
            />

            {error && <div className="error" role="alert">{error}</div>}
            {info && <div className="ok" role="status">{info}</div>}

            <button className="auth-btn" disabled={busy}>
              {busy ? 'Creating…' : 'Create account'}
            </button>

            <p className="auth-consent">
              By creating an account you agree to our{' '}
              <a href="/terms.html" target="_blank" rel="noopener noreferrer">Terms of Service</a>
              {' '}and{' '}
              <a href="/privacy.html" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.
            </p>
          </form>

          <div className="auth-note">
            <Icon name="shield" size={16} />
            <span><b>Keke rider?</b> Accounts are created by the operations team after verification.</span>
          </div>

          <div className="auth-links">
            <div className="auth-links-row">
              <span>Already have an account? <Link to="/login">Sign in</Link></span>
            </div>
            <Link to="/">← Back to home</Link>
          </div>
          <p className="auth-foot">Campus micro-transit · © 2026 Danfolio Logistics</p>
        </div>
      </main>
    </div>
  )
}
