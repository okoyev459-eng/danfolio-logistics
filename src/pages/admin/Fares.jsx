import { useEffect, useState } from 'react'
import AdminLayout from '../../components/AdminLayout.jsx'
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
    <AdminLayout title="Fares">
      <p className="adm-sub">Fixed prices shown to every student, every time.</p>

      <div className="adm-grid2">
        <section className="adm-panel">
          <h2>Configured fares</h2>
          {fares === null && <p className="muted">Loading…</p>}
          {fares && fares.length === 0 && (
            <p className="muted">No fares configured yet.</p>
          )}
          {fares && fares.length > 0 && (
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Route</th>
                    <th>Mode</th>
                    <th>Fare</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(fares ?? []).map((f) => (
                    <tr key={f.id}>
                      <td><b>{f.from?.name} → {f.to?.name}</b></td>
                      <td>{f.mode}</td>
                      <td><span className="pill">₦{Number(f.amount).toLocaleString()}</span></td>
                      <td>
                        <button
                          type="button"
                          className="adm-btn secondary"
                          disabled={busy}
                          onClick={() => removeFare(f.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="adm-panel">
          <h2>Add or update a fare</h2>
          <form onSubmit={save}>
            <label>Mode</label>
            <select
              className="adm-select"
              value={form.mode}
              onChange={(e) => setForm({ ...form, mode: e.target.value, from_id: '', to_id: '' })}
            >
              <option value="drop">drop</option>
              <option value="along">along</option>
            </select>

            <label>From</label>
            <select className="adm-select" value={form.from_id} onChange={set('from_id')}>
              <option value="">Choose…</option>
              {froms.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>

            <label>To (destination)</label>
            <select className="adm-select" value={form.to_id} onChange={set('to_id')}>
              <option value="">Choose…</option>
              {tos.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>

            <label>Fare (₦, whole naira)</label>
            <input value={form.amount} onChange={set('amount')} inputMode="numeric" required />

            {error && <div className="error">{error}</div>}
            {notice && <div className="ok">{notice}</div>}

            <button className="adm-btn" style={{ height: 44, lineHeight: '42px', marginTop: 12 }} disabled={busy}>
              {busy ? 'Saving…' : 'Save fare'}
            </button>
          </form>
        </section>
      </div>
    </AdminLayout>
  )
}
