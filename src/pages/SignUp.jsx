import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function SignUp() {
  const [form, setForm] = useState({ full_name: '', matric_no: '', email: '', phone: '', password: '' })
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
          matric_no: form.matric_no.trim(),
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
        {error && <div className="error">{error}</div>}
        {info && <div className="ok">{info}</div>}
        <button disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
      </form>
      <p className="center">Already have an account? <Link to="/login">Sign in</Link></p>
    </div>
  )
}
