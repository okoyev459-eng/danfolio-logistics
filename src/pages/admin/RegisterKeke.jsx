import { useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'
import { supabase } from '../../lib/supabase'

export default function RegisterKeke() {
  const [form, setForm] = useState({ full_name: '', phone: '', keke_number: '', password: '' })
  const [error, setError] = useState('')
  const [done, setDone] = useState(null)
  const [busy, setBusy] = useState(false)

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })

  async function handleSubmit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    setDone(null)
    const { data, error } = await supabase.functions.invoke('create-keke', { body: form })
    setBusy(false)
    if (error) {
      let message = error.message
      try {
        const body = await error.context.json()
        message = body.error || message
      } catch (_) {}
      setError(message)
      return
    }
    setDone({ keke_number: data.keke_number, password: form.password })
    setForm({ full_name: '', phone: '', keke_number: '', password: '' })
  }

  return (
    <Layout title="Admin">
      <Link to="/admin">← Back</Link>
      <h2>Register keke</h2>
      <form className="card" onSubmit={handleSubmit}>
        <label>Full name</label>
        <input value={form.full_name} onChange={set('full_name')} required />
        <label>Phone number (contact only)</label>
        <input value={form.phone} onChange={set('phone')} />
        <label>Keke number (cannot be changed later)</label>
        <input value={form.keke_number} onChange={set('keke_number')} required />
        <label>Password for the rider</label>
        <input value={form.password} onChange={set('password')} required minLength={6} />
        {error && <div className="error">{error}</div>}
        {done && (
          <div className="ok">
            Registered. Give the rider these login details:<br />
            Keke number: <b>{done.keke_number}</b><br />
            Password: <b>{done.password}</b>
          </div>
        )}
        <button disabled={busy}>{busy ? 'Registering…' : 'Register keke'}</button>
      </form>
    </Layout>
  )
}
