import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'
import { supabase } from '../../lib/supabase'

// Admin location management (spec section 4: locations = pickup | station |
// destination, mode drop | along, with coordinates for the map).
// Admins have an ALL policy on locations, so writes go direct (RLS-checked).
const KINDS = ['pickup', 'station', 'destination']
const MODES = ['drop', 'along']

const EMPTY = { name: '', kind: 'pickup', mode: 'drop', lat: '', lng: '', active: true }

export default function AdminLocations() {
  const [rows, setRows] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [editingId, setEditingId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const set = (key) => (e) =>
    setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  async function load() {
    const { data, error: readError } = await supabase
      .from('locations')
      .select('id, name, kind, mode, lat, lng, active')
      .order('mode')
      .order('kind')
      .order('name')

    if (readError) setError(readError.message)
    else setRows(data ?? [])
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

  return (
    <Layout title="Admin · Locations">
      <Link to="/admin">← Dashboard</Link>
      <h2>Stations & points</h2>
      <p className="muted">
        Students can only choose from active points. Latitude/longitude feed
        the campus map (leave empty until known).
      </p>

      <form className="card" onSubmit={save}>
        <h3>{editingId ? 'Edit point' : 'Add a point'}</h3>

        <label>Name</label>
        <input value={form.name} onChange={set('name')} required />

        <label>Kind</label>
        <select value={form.kind} onChange={set('kind')} style={{ width: '100%', height: 48, borderRadius: 14, border: '1px solid #cbd5e1', font: 'inherit', padding: '0 12px' }}>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>

        <label>Mode</label>
        <select value={form.mode} onChange={set('mode')} style={{ width: '100%', height: 48, borderRadius: 14, border: '1px solid #cbd5e1', font: 'inherit', padding: '0 12px' }}>
          {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>

        <label>Latitude (optional)</label>
        <input value={form.lat} onChange={set('lat')} inputMode="decimal" placeholder="8.4799" />

        <label>Longitude (optional)</label>
        <input value={form.lng} onChange={set('lng')} inputMode="decimal" placeholder="4.5226" />

        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={form.active}
            onChange={set('active')}
            style={{ width: 20, height: 20 }}
          />
          Active (students can select it)
        </label>

        {error && <div className="error">{error}</div>}
        {notice && <div className="ok">{notice}</div>}

        <button disabled={busy}>{busy ? 'Saving…' : editingId ? 'Update point' : 'Add point'}</button>
        {editingId && (
          <button type="button" className="secondary" onClick={reset}>Cancel edit</button>
        )}
      </form>

      {rows === null && <p className="muted">Loading…</p>}
      {(rows ?? []).map((row) => (
        <div className="card" key={row.id}>
          <div className="row">
            <b>{row.name}</b>
            <span className="badge">{row.active ? 'active' : 'hidden'}</span>
          </div>
          <p className="muted">
            {row.kind} · {row.mode}
            {row.lat !== null && row.lng !== null && <> · {Number(row.lat).toFixed(4)}, {Number(row.lng).toFixed(4)}</>}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="secondary" style={{ marginTop: 0 }} onClick={() => startEdit(row)}>Edit</button>
            <button type="button" className="secondary" style={{ marginTop: 0 }} onClick={() => toggleActive(row)}>
              {row.active ? 'Deactivate' : 'Activate'}
            </button>
          </div>
        </div>
      ))}
    </Layout>
  )
}
