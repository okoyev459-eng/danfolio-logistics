import { useState } from 'react'
import AdminLayout from '../../components/AdminLayout.jsx'
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
    <AdminLayout title="Register keke">
      <div className="adm-grid2">
        <section className="adm-panel">
          <h2>Rider details</h2>
          <form onSubmit={handleSubmit}>
            <div className="adm-form-grid">
              <div>
                <label>Full name</label>
                <input value={form.full_name} onChange={set('full_name')} required />
              </div>
              <div>
                <label>Phone number (contact only)</label>
                <input value={form.phone} onChange={set('phone')} />
              </div>
              <div>
                <label>Keke number (cannot be changed later)</label>
                <input value={form.keke_number} onChange={set('keke_number')} required />
              </div>
              <div>
                <label>Password for the rider</label>
                <input
                  type="password"
                  value={form.password}
                  onChange={set('password')}
                  required
                  minLength={6}
                  autoComplete="new-password"
                />
              </div>
            </div>

            {error && <div className="error" role="alert">{error}</div>}

            <button
              className="adm-btn"
              style={{ height: 48, lineHeight: '46px', marginTop: 14, fontSize: 15 }}
              disabled={busy}
            >
              {busy ? 'Registering…' : 'Register keke'}
            </button>
          </form>
        </section>

        <section className="adm-details" aria-live="polite">
          <h3>Login details to give the rider</h3>
          {!done && (
            <p style={{ margin: 0, opacity: 0.8, fontSize: 14 }}>
              Register a keke and the rider’s login details appear here so you
              can hand them over.
            </p>
          )}
          {done && (
            <dl>
              <dt>Keke number</dt>
              <dd>{done.keke_number}</dd>
              <dt>Password</dt>
              <dd>{done.password}</dd>
            </dl>
          )}
        </section>
      </div>
    </AdminLayout>
  )
}
