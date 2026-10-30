import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'
import { supabase } from '../../lib/supabase'

// Admin fare management (spec section 4: fares are fixed per
// mode + from + to, whole naira). Admins have an ALL policy on fares.
export default function AdminFares() {
  const [fares, setFares] = useState(null)
  const [locations, setLocations] = useState([])
  const [form, setForm] = useState({ mode: 'drop', from_id: '', to_id: '', amount: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })

  async function load() {
    const [{ data: fareRows, error: fareError }, { data: locRows }] = await Promise.all([
      supabase
        .from('fares')
        .select('id, mode, amount, from_id, to_id, from:locations!fares_from_id_fkey(name), to:locations!fares_to_id_fkey(name)')
        .order('mode'),
      supabase.from('locations').select('id, name, kind, mode').order('name'),
    ])

    if (fareError) setError(fareError.message)
    else setFares(fareRows ?? [])
    setLocations(locRows ?? [])
  }

  useEffect(() => {
    load()
  }, [])

  const froms = locations.filter((l) => l.mode === form.mode && l.kind !== 'destination')
  const tos = locations.filter((l) => l.mode === form.mode && l.kind === 'destination')

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')

    const amount = Number(form.amount)

    if (!form.from_id || !form.to_id) {
      setBusy(false)
      setError('Choose both a starting point and a destination.')
      return
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      setBusy(false)
      setError('Fare must be a whole number of naira greater than zero.')
      return
    }

    const { error: writeError } = await supabase
      .from('fares')
      .upsert(
        { mode: form.mode, from_id: form.from_id, to_id: form.to_id, amount },
        { onConflict: 'mode,from_id,to_id' }
      )

    setBusy(false)

    if (writeError) {
      setError(writeError.message)
      return
    }

    setNotice('Fare saved.')
    setForm({ mode: form.mode, from_id: '', to_id: '', amount: '' })
    load()
  }

  async function removeFare(id) {
    const { error: delError } = await supabase.from('fares').delete().eq('id', id)
    if (delError) setError(delError.message)
    else load()
  }

  return (
    <Layout title="Admin · Fares">
      <Link to="/admin">← Dashboard</Link>
      <h2>Fares</h2>
      <p className="muted">Fixed prices shown to every student, every time.</p>

      <form className="card" onSubmit={save}>
        <label>Mode</label>
        <select
          value={form.mode}
          onChange={(e) => setForm({ ...form, mode: e.target.value, from_id: '', to_id: '' })}
          style={{ width: '100%', height: 48, borderRadius: 14, border: '1px solid #cbd5e1', font: 'inherit', padding: '0 12px' }}
        >
          <option value="drop">drop</option>
          <option value="along">along</option>
        </select>

        <label>From</label>
        <select value={form.from_id} onChange={set('from_id')} style={{ width: '100%', height: 48, borderRadius: 14, border: '1px solid #cbd5e1', font: 'inherit', padding: '0 12px' }}>
          <option value="">Choose…</option>
          {froms.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>

        <label>To (destination)</label>
        <select value={form.to_id} onChange={set('to_id')} style={{ width: '100%', height: 48, borderRadius: 14, border: '1px solid #cbd5e1', font: 'inherit', padding: '0 12px' }}>
          <option value="">Choose…</option>
          {tos.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>

        <label>Fare (₦, whole naira)</label>
        <input value={form.amount} onChange={set('amount')} inputMode="numeric" required />

        {error && <div className="error">{error}</div>}
        {notice && <div className="ok">{notice}</div>}

        <button disabled={busy}>{busy ? 'Saving…' : 'Save fare'}</button>
      </form>

      {fares === null && <p className="muted">Loading…</p>}
      {(fares ?? []).map((f) => (
        <div className="card row" key={f.id}>
          <span>
            <b>{f.from?.name} → {f.to?.name}</b>
            <br />
            <span className="muted">{f.mode}</span>
          </span>
          <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span className="badge">₦{f.amount}</span>
            <button
              type="button"
              className="secondary"
              style={{ marginTop: 0, width: 'auto', padding: '0 12px', height: 36, lineHeight: '36px', fontSize: 13 }}
              onClick={() => removeFare(f.id)}
            >
              Delete
            </button>
          </span>
        </div>
      ))}
      {fares !== null && fares.length === 0 && (
        <div className="card muted">No fares configured yet.</div>
      )}
    </Layout>
  )
}
