import { useEffect, useMemo, useState } from 'react'
import AdminLayout from '../../components/AdminLayout.jsx'
import { supabase } from '../../lib/supabase'
import { buildPlacePool, placePoint } from '../../lib/placePool.js'

// Admin fare management (spec section 4: fares are fixed per
// mode + from + to, whole naira). Admins have an ALL policy on fares.
export default function AdminFares() {
  const [fares, setFares] = useState(null)
  const [locations, setLocations] = useState([])
  const [form, setForm] = useState({ mode: 'drop', from_key: '', to_key: '', amount: '' })
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

  // ONE list of places for both ends. Rows are grouped by name, so a place
  // the admin entered as a pick-up and again as a destination shows once.
  const pool = useMemo(() => buildPlacePool(locations, form.mode), [locations, form.mode])
  const toPlaces = pool.filter((place) => place.key !== form.from_key)

  // Changing the start drops a destination that would be the same place.
  const chooseFrom = (e) => {
    const fromKey = e.target.value
    setForm((current) => ({
      ...current,
      from_key: fromKey,
      to_key: current.to_key === fromKey ? '' : current.to_key,
    }))
  }

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')

    const amount = Number(form.amount)

    const fromPlace = pool.find((place) => place.key === form.from_key)
    const toPlace = pool.find((place) => place.key === form.to_key)

    if (!fromPlace || !toPlace) {
      setBusy(false)
      setError('Choose both a starting point and a destination.')
      return
    }
    if (fromPlace.key === toPlace.key) {
      setBusy(false)
      setError('A fare needs two different places.')
      return
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      setBusy(false)
      setError('Fare must be a whole number of naira greater than zero.')
      return
    }

    // The row that fits each role: a place may have a pick-up row and a
    // destination row, and booking looks the fare up by those ids.
    const fromPoint = placePoint(fromPlace, 'from')
    const toPoint = placePoint(toPlace, 'to')

    const { error: writeError } = await supabase
      .from('fares')
      .upsert(
        { mode: form.mode, from_id: fromPoint.id, to_id: toPoint.id, amount },
        { onConflict: 'mode,from_id,to_id' }
      )

    setBusy(false)

    if (writeError) {
      setError(writeError.message)
      return
    }

    setNotice('Fare saved.')
    setForm({ mode: form.mode, from_key: '', to_key: '', amount: '' })
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
          <p className="muted" style={{ marginTop: -6, fontSize: 13 }}>
            One list of campus places — pick the starting point, then any other
            place. The destination list leaves out the place you chose as the
            start, so a trip can’t begin and end at the same place.
          </p>
          <form onSubmit={save}>
            <label>Mode</label>
            <select
              className="adm-select"
              value={form.mode}
              onChange={(e) => setForm({ ...form, mode: e.target.value, from_key: '', to_key: '' })}
            >
              <option value="drop">drop</option>
              <option value="along">along</option>
            </select>

            <label>From</label>
            <select className="adm-select" value={form.from_key} onChange={chooseFrom}>
              <option value="">Choose…</option>
              {pool.map((place) => (
                <option key={place.key} value={place.key}>{place.name}</option>
              ))}
            </select>

            <label>To (destination)</label>
            <select className="adm-select" value={form.to_key} onChange={set('to_key')}>
              <option value="">Choose…</option>
              {toPlaces.map((place) => (
                <option key={place.key} value={place.key}>{place.name}</option>
              ))}
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
