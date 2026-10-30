import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import AdminLayout from '../../components/AdminLayout.jsx'
import { supabase } from '../../lib/supabase'

// Admin location + fare management (mockup A3 "locations and fares"): the
// locations table with an add/edit form, and the fares table side by side.
// Spec section 4: locations = pickup | station | destination, mode drop |
// along, with coordinates for the map. Admins have an ALL policy on both
// tables, so writes go direct (RLS-checked).
const KINDS = ['pickup', 'station', 'destination']
const MODES = ['drop', 'along']

const EMPTY = { name: '', kind: 'pickup', mode: 'drop', lat: '', lng: '', active: true }

export default function AdminLocations() {
  const [rows, setRows] = useState(null)
  const [fares, setFares] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [editingId, setEditingId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const set = (key) => (e) =>
    setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  async function load() {
    const [{ data, error: readError }, { data: fareRows }] = await Promise.all([
      supabase
        .from('locations')
        .select('id, name, kind, mode, lat, lng, active')
        .order('mode')
        .order('kind')
        .order('name'),
      supabase
        .from('fares')
        .select('id, mode, amount, from:locations!fares_from_id_fkey(name), to:locations!fares_to_id_fkey(name)')
        .order('mode'),
    ])

    if (readError) setError(readError.message)
    else setRows(data ?? [])
    setFares(fareRows ?? [])
  }

  useEffect(() => {
    load()
  }, [])

  function startEdit(row) {
    setEditingId(row.id)
    setForm({
      name: row.name,
      kind: row.kind,
      mode: row.mode,
      lat: row.lat ?? '',
      lng: row.lng ?? '',
      active: row.active,
    })
    setNotice('')
    setError('')
  }

  function reset() {
    setEditingId(null)
    setForm(EMPTY)
  }

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')

    const payload = {
      name: form.name.trim(),
      kind: form.kind,
      mode: form.mode,
      lat: form.lat === '' ? null : Number(form.lat),
      lng: form.lng === '' ? null : Number(form.lng),
      active: Boolean(form.active),
    }

    if (!payload.name) {
      setBusy(false)
      setError('Name is required.')
      return
    }
    if (
      (payload.lat === null) !== (payload.lng === null) ||
      (payload.lat !== null && (!Number.isFinite(payload.lat) || !Number.isFinite(payload.lng)))
    ) {
      setBusy(false)
      setError('Enter both latitude and longitude, or leave both empty.')
      return
    }

    const { error: writeError } = editingId
      ? await supabase.from('locations').update(payload).eq('id', editingId)
      : await supabase.from('locations').insert(payload)

    setBusy(false)

    if (writeError) {
      setError(writeError.message)
      return
    }

    setNotice(editingId ? 'Location updated.' : 'Location added.')
    reset()
    load()
  }

  async function toggleActive(row) {
    const { error: writeError } = await supabase
      .from('locations')
      .update({ active: !row.active })
      .eq('id', row.id)

    if (writeError) setError(writeError.message)
    else load()
  }

  async function removeFare(id) {
    const { error: delError } = await supabase.from('fares').delete().eq('id', id)
    if (delError) setError(delError.message)
    else load()
  }

  return (
    <AdminLayout title="Locations and fares">
      <p className="adm-sub">
        Students can only choose from active points. Latitude/longitude feed
        the campus map (leave empty until known). Fares are the fixed prices
        every student sees.
      </p>

      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="ok" role="status">{notice}</div>}

      <div className="adm-grid-even">
        <section className="adm-panel">
          <h2>Locations</h2>
          {rows === null && <p className="muted">Loading…</p>}
          {rows && (
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Kind</th>
                    <th>Mode</th>
                    <th>Coordinates</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(rows ?? []).map((row) => (
                    <tr key={row.id}>
                      <td><b>{row.name}</b></td>
                      <td>{row.kind}</td>
                      <td>{row.mode}</td>
                      <td className="muted">
                        {row.lat !== null && row.lng !== null
                          ? `${Number(row.lat).toFixed(4)}, ${Number(row.lng).toFixed(4)}`
                          : '—'}
                      </td>
                      <td>
                        <span className={`pill ${row.active ? 'online' : 'muted-pill'}`}>
                          {row.active ? 'active' : 'hidden'}
                        </span>
                      </td>
                      <td>
                        <button type="button" className="adm-btn secondary" onClick={() => startEdit(row)}>
                          Edit
                        </button>
                        <button type="button" className="adm-btn secondary" onClick={() => toggleActive(row)}>
                          {row.active ? 'Hide' : 'Show'}
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
          <h2>Fares</h2>
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
                        <button type="button" className="adm-btn secondary" onClick={() => removeFare(f.id)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Link className="adm-btn" to="/admin/fares" style={{ marginTop: 10 }}>
            Add or edit a fare
          </Link>
        </section>
      </div>

      <section className="adm-panel">
        <h2>{editingId ? 'Edit point' : 'Add a point'}</h2>
        <form onSubmit={save}>
          <div className="adm-form-grid">
            <div>
              <label>Name</label>
              <input value={form.name} onChange={set('name')} required />
            </div>
            <div>
              <label>Kind</label>
              <select className="adm-select" value={form.kind} onChange={set('kind')}>
                {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            <div>
              <label>Mode</label>
              <select className="adm-select" value={form.mode} onChange={set('mode')}>
                {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label>Status</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, height: 52, margin: 0 }}>
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={set('active')}
                  style={{ width: 20, height: 20 }}
                />
                Active (students can select it)
              </label>
            </div>
            <div>
              <label>Latitude (optional)</label>
              <input value={form.lat} onChange={set('lat')} inputMode="decimal" placeholder="8.4799" />
            </div>
            <div>
              <label>Longitude (optional)</label>
              <input value={form.lng} onChange={set('lng')} inputMode="decimal" placeholder="4.5226" />
            </div>
          </div>

          <button type="submit" className="adm-btn" style={{ height: 44, lineHeight: '42px', marginTop: 12 }} disabled={busy}>
            {busy ? 'Saving…' : editingId ? 'Update point' : 'Add point'}
          </button>
          {editingId && (
            <button type="button" className="adm-btn secondary" style={{ height: 44, lineHeight: '42px', marginTop: 12 }} onClick={reset}>
              Cancel edit
            </button>
          )}
        </form>
      </section>
    </AdminLayout>
  )
}
