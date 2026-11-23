import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const RESEND_COOLDOWN_SECONDS = 60

export default function SignUp() {
  const [form, setForm] = useState({ full_name: '', matric_no: '', email: '', phone: '', password: '' })
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)
  const [needsConfirmation, setNeedsConfirmation] = useState(false)
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [now, setNow] = useState(Date.now())
  const navigate = useNavigate()

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })

  useEffect(() => {
    if (!cooldownUntil) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [cooldownUntil])

  const secondsLeft = Math.max(0, Math.ceil((cooldownUntil - now) / 1000))

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
          matric_no: form.matric_no.trim(),
          phone: form.phone.trim(),
        },
      },
    })
    setBusy(false)
    if (error) return setError(error.message)
    if (data.session) {
      navigate('/')
      return
    }
    setNeedsConfirmation(true)
    setCooldownUntil(Date.now() + RESEND_COOLDOWN_SECONDS * 1000)
    setInfo('Account created. If email confirmation is enabled, check your email to confirm, then sign in.')
  }

  async function resendConfirmation() {
    if (busy || secondsLeft > 0) return
    setBusy(true)
    setError('')
    setInfo('')
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: form.email.trim(),
    })
    setBusy(false)
    if (error) {
      if (/rate|limit|too many/i.test(error.message || '')) {
        setError('Too many requests. Please wait before trying again.')
      } else {
        setError('Could not resend confirmation email right now. Please try again.')
      }
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_SECONDS * 1000)
      return
    }
    setCooldownUntil(Date.now() + RESEND_COOLDOWN_SECONDS * 1000)
    setInfo('If email confirmation is enabled for your account, a new confirmation email has been sent.')
  }

  return (
    <div className="page">
      <h1>Create account</h1>
      <p>Ride the campus, hassle-free.</p>
      <form className="card" onSubmit={handleSubmit}>
        <label>Full name</label>
        <input value={form.full_name} onChange={set('full_name')} required />
        <label>Matriculation number</label>
        <input value={form.matric_no} onChange={set('matric_no')} required />
        <label>Email</label>
        <input type="email" value={form.email} onChange={set('email')} required />
        <label>Phone number</label>
        <input value={form.phone} onChange={set('phone')} placeholder="+234" required />
        <label>Password (at least 6 characters)</label>
        <input type="password" value={form.password} onChange={set('password')} minLength={6} required />
        {error && <div className="error" role="alert">{error}</div>}
        {info && <div className="ok" role="status">{info}</div>}
        <button disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
        {needsConfirmation && (
          <button
            type="button"
            className="secondary"
            onClick={resendConfirmation}
            disabled={busy || secondsLeft > 0 || !form.email.trim()}
          >
            {busy ? 'Sending…' : secondsLeft > 0 ? `Resend in ${secondsLeft}s` : 'Resend confirmation email'}
          </button>
        )}
      </form>
      <p className="center">Already have an account? <Link to="/login">Sign in</Link></p>
    </div>
  )
}
