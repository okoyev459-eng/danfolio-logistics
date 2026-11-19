import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import AdminLayout from '../../components/AdminLayout.jsx'
import CampusMap from '../../components/CampusMap.jsx'
import { supabase } from '../../lib/supabase'
import { validCoord } from '../../lib/geo'
import {
  resetCampusCameraCache,
  validateCampusSettings,
} from '../../lib/campusSettings'

// Manage Campus Locations (spec section 4) — the admin's no-code map editor:
//
//   * the campus map at the top; clicking a point drops its exact
//     coordinates into the form (no coordinate guessing, no invented data);
//   * every location needs a name, a category, and lat/lng — saved to
//     Supabase `locations`, never hardcoded;
//   * search + filters (status / category) over the saved rows;
//   * edit, activate/deactivate, and delete (delete is refused politely when
//     fares or rides still reference the row — hide it instead);
//   * a campus-settings panel for the university name + map centre, which
//     every CampusMap in the app picks up after a save.
//
// The fares table from mockup A3 stays exactly where it was — this page
// only gained the map editing around it. Admins have the write policy on
// both tables (verified: `fares`, `locations` write = is_admin()), so all
// writes go direct through RLS.
//
// Everything feature-detects: the campus_settings migration
// (20261103100000) may not be applied yet, in which case its panel explains
// what is missing instead of erroring.

const KINDS = ['pickup', 'station', 'destination']
const MODES = ['drop', 'along']

// Sensible default categories (shown as suggestions alongside whatever the
// admin has already used).
const CATEGORIES = [
  'Main gate',
  'Faculty',
  'Lecture hall',
  'Hostel',
  'Library',
  'Laboratory',
  'Restaurant',
  'Shop',
  'Health centre',
  'Keke stop',
  'Other',
]

const EMPTY = { name: '', kind: 'pickup', mode: 'drop', category: '', lat: '', lng: '', active: true }
const EMPTY_SETTINGS = { campus_name: '', center_lat: '', center_lng: '', zoom: '' }

function isMissingTable(error) {
  if (!error) return false
  return (
    error.code === 'PGRST205' ||
    error.code === '42P01' ||
    /could not find the table|relation .* does not exist|schema cache/i.test(
      String(error.message ?? ''),
    )
  )
}

export default function AdminLocations() {
  const [rows, setRows] = useState(null)
  const [fares, setFares] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [editingId, setEditingId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all') // all | active | hidden
  const [categoryFilter, setCategoryFilter] = useState('') // '' = all

  // Campus settings (campus_settings row id = 1) — feature-detected.
  const [settingsAvailable, setSettingsAvailable] = useState(true)
  const [settingsForm, setSettingsForm] = useState(EMPTY_SETTINGS)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [settingsNotice, setSettingsNotice] = useState('')

  const set = (key) => (e) =>
    setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  async function load() {
    const [{ data, error: readError }, { data: fareRows }] = await Promise.all([
      supabase
        .from('locations')
        .select('id, name, kind, mode, category, lat, lng, active')
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

  async function loadSettings() {
    const { data, error: readError } = await supabase
      .from('campus_settings')
      .select('campus_name, center_lat, center_lng, zoom')
      .eq('id', 1)
      .maybeSingle()

    if (readError) {
      if (isMissingTable(readError)) {
        setSettingsAvailable(false)
        return
      }
      setSettingsError(readError.message)
      return
    }

    setSettingsForm({
      campus_name: data?.campus_name ?? '',
      center_lat: data?.center_lat ?? '',
      center_lng: data?.center_lng ?? '',
      zoom: data?.zoom ?? '',
    })
  }

  useEffect(() => {
    load()
    loadSettings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function startEdit(row) {
    if (row?.id === '__picked') return // the unsaved map pin is not a row
    setEditingId(row.id)
    setForm({
      name: row.name,
      kind: row.kind,
      mode: row.mode,
      category: row.category ?? '',
      lat: row.lat ?? '',
      lng: row.lng ?? '',
      active: row.active,
    })
    setNotice('')
    setError('')
    // Bring the form into view on phones — the map sits above it.
    document
      .getElementById('location-form')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function reset() {
    setEditingId(null)
    setForm(EMPTY)
  }

  // Click-to-pick: exact map coordinates into the form. Real OSM geometry
  // only — the pin shows immediately so the admin sees what they picked.
  function handleMapClick({ lat, lng }) {
    setForm((current) => ({ ...current, lat: String(lat), lng: String(lng) }))
    setNotice('Coordinates picked from the map — save the location to keep them.')
    setError('')
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
      category: form.category.trim(),
      lat: form.lat === '' ? null : Number(form.lat),
      lng: form.lng === '' ? null : Number(form.lng),
      active: Boolean(form.active),
    }

    if (!payload.name) {
      setBusy(false)
      setError('Name is required.')
      return
    }
    if (!payload.category) {
      setBusy(false)
      setError('Category is required (pick one of the suggestions or type your own).')
      return
    }
    if (
      (payload.lat === null) !== (payload.lng === null) ||
      payload.lat === null ||
      !Number.isFinite(payload.lat) ||
      !Number.isFinite(payload.lng) ||
      payload.lat < -90 ||
      payload.lat > 90 ||
      payload.lng < -180 ||
      payload.lng > 180
    ) {
      setBusy(false)
      setError(
        'Every location needs a latitude and longitude — click the map to pick the exact point, or type both numbers.',
      )
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

    setNotice(editingId ? 'Location updated.' : 'Location added to the campus map.')
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

  async function remove(row) {
    if (!window.confirm(`Delete “${row.name}”? This cannot be undone.`)) return

    const { error: delError } = await supabase.from('locations').delete().eq('id', row.id)
    if (delError) {
      if (delError.code === '23503') {
        // FK: fares / rides still reference this point.
        setError(
          `“${row.name}” is referenced by existing fares or rides, so it cannot be deleted. ` +
            'Hide it instead so students can no longer select it.',
        )
      } else {
        setError(delError.message)
      }
      return
    }

    setNotice('Location deleted.')
    if (editingId === row.id) reset()
    load()
  }

  async function removeFare(id) {
    const { error: delError } = await supabase.from('fares').delete().eq('id', id)
    if (delError) setError(delError.message)
    else load()
  }

  // ------------------------------------------------------------------
  // Map data: saved points (with coordinates) + the unsaved picked pin
  // ------------------------------------------------------------------
  const mapPoints = useMemo(() => {
    const saved = (rows ?? []).filter((r) => validCoord(r))

    const lat = form.lat === '' ? NaN : Number(form.lat)
    const lng = form.lng === '' ? NaN : Number(form.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return saved

    const editing = (rows ?? []).find((r) => r.id === editingId)
    if (editing && Number(editing.lat) === lat && Number(editing.lng) === lng) return saved

    return [
      ...saved,
      {
        id: '__picked',
        name: form.name.trim() ? `${form.name.trim()} (not saved yet)` : 'Selected point',
        lat,
        lng,
        kind: 'pickup',
      },
    ]
  }, [rows, form.lat, form.lng, form.name, editingId])

  // Search + filters over the saved rows.
  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (rows ?? []).filter((row) => {
      if (statusFilter === 'active' && !row.active) return false
      if (statusFilter === 'hidden' && row.active) return false
      if (categoryFilter && (row.category ?? 'Other') !== categoryFilter) return false
      if (!needle) return true
      return (
        String(row.name).toLowerCase().includes(needle) ||
        String(row.category ?? '').toLowerCase().includes(needle) ||
        String(row.kind).toLowerCase().includes(needle)
      )
    })
  }, [rows, query, statusFilter, categoryFilter])

  const categorySuggestions = useMemo(() => {
    const used = (rows ?? []).map((r) => r.category).filter(Boolean)
    return [...new Set([...CATEGORIES, ...used])].sort((a, b) => a.localeCompare(b))
  }, [rows])

  // ------------------------------------------------------------------
  // Campus settings actions
  // ------------------------------------------------------------------
  function setSetting(key) {
    return (e) => setSettingsForm({ ...settingsForm, [key]: e.target.value })
  }

  async function saveSettings(e) {
    e.preventDefault()
    const check = validateCampusSettings(settingsForm)
    if (!check.ok) {
      setSettingsError(Object.values(check.errors)[0])
      return
    }

    setSettingsBusy(true)
    setSettingsError('')
    setSettingsNotice('')

    const { error: writeError } = await supabase
      .from('campus_settings')
      .upsert(check.value, { onConflict: 'id' })

    setSettingsBusy(false)

    if (writeError) {
      if (isMissingTable(writeError)) {
        setSettingsAvailable(false)
        return
      }
      setSettingsError(writeError.message)
      return
    }

    setSettingsNotice('Campus settings saved — every map now opens at this centre.')
    resetCampusCameraCache()
    loadSettings()
  }

  return (
    <AdminLayout title="Manage campus locations">
      <p className="adm-sub">
        Click the map to pick a point’s exact coordinates, name it, choose a
        category and save. Students can only choose active points. Fares are
        the fixed prices every student sees.
      </p>

      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="ok" role="status">{notice}</div>}

      {/* ---- The campus map: click to pick coordinates ------------------ */}
      <section className="adm-panel">
        <h2>Campus map</h2>
        <p className="muted" style={{ marginTop: -6, fontSize: 13 }}>
          Click any point on the map to fill the latitude/longitude below.
          Saved locations appear as pins — tap a pin to edit it. Coordinates
          stay empty until you enter them; nothing is invented.
        </p>
        <div className="adm-map">
          <CampusMap
            points={mapPoints}
            height={380}
            selectedId={editingId ?? (form.lat !== '' && form.lng !== '' ? '__picked' : null)}
            onSelect={startEdit}
            onMapClick={handleMapClick}
          />
        </div>
      </section>

      <div className="adm-grid-even">
        {/* ---- Add / edit form ---------------------------------------- */}
        <section className="adm-panel" id="location-form">
          <h2>{editingId ? 'Edit location' : 'Add a location'}</h2>
          <p className="muted" style={{ marginTop: -6, fontSize: 13 }}>
            The category groups this point under a heading in the student's
            booking list. Name, category and coordinates are required.
          </p>
          <form onSubmit={save}>
            <div className="adm-form-grid">
              <div>
                <label>Name</label>
                <input
                  value={form.name}
                  onChange={set('name')}
                  required
                  placeholder="e.g. Main gate"
                />
              </div>
              <div>
                <label>Category</label>
                <input
                  list="location-categories"
                  value={form.category}
                  onChange={set('category')}
                  placeholder="e.g. Main gate"
                  required
                />
                <datalist id="location-categories">
                  {categorySuggestions.map((c) => <option key={c} value={c} />)}
                </datalist>
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
                <label>Latitude</label>
                <input
                  value={form.lat}
                  onChange={set('lat')}
                  inputMode="decimal"
                  placeholder="Click the map"
                  required
                />
              </div>
              <div>
                <label>Longitude</label>
                <input
                  value={form.lng}
                  onChange={set('lng')}
                  inputMode="decimal"
                  placeholder="Click the map"
                  required
                />
              </div>
            </div>

            <button
              type="submit"
              className="adm-btn"
              style={{ height: 44, lineHeight: '42px', marginTop: 12 }}
              disabled={busy}
            >
              {busy ? 'Saving…' : editingId ? 'Update location' : 'Add location'}
            </button>
            {editingId && (
              <button
                type="button"
                className="adm-btn secondary"
                style={{ height: 44, lineHeight: '42px', marginTop: 12 }}
                onClick={reset}
              >
                Cancel edit
              </button>
            )}
          </form>
        </section>

        {/* ---- Saved locations + search / filters ---------------------- */}
        <section className="adm-panel">
          <h2>Saved locations</h2>

          <input
            className="bk-search"
            type="search"
            placeholder="Search by name, category or kind…"
            aria-label="Search locations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ marginBottom: 10 }}
          />

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <select
              className="adm-select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              aria-label="Filter by status"
            >
              <option value="all">All statuses</option>
              <option value="active">Active only</option>
              <option value="hidden">Hidden only</option>
            </select>
            <select
              className="adm-select"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              aria-label="Filter by category"
            >
              <option value="">All categories</option>
              {categorySuggestions.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          {rows === null && <p className="muted">Loading…</p>}
          {rows !== null && filteredRows.length === 0 && (
            <p className="muted">
              {rows.length === 0
                ? 'No locations saved yet — click the map to add the first one.'
                : 'No locations match this search.'}
            </p>
          )}
          {filteredRows.length > 0 && (
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Kind</th>
                    <th>Mode</th>
                    <th>Category</th>
                    <th>Coordinates</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => (
                    <tr key={row.id}>
                      <td><b>{row.name}</b></td>
                      <td>{row.kind}</td>
                      <td>{row.mode}</td>
                      <td>{row.category || 'Other'}</td>
                      <td className="muted">
                        {row.lat !== null && row.lng !== null
                          ? `${Number(row.lat).toFixed(5)}, ${Number(row.lng).toFixed(5)}`
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
                        <button type="button" className="adm-btn secondary" onClick={() => remove(row)}>
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
      </div>

      {/* ---- Fares (unchanged from mockup A3) -------------------------- */}
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

      {/* ---- Campus name + map centre ---------------------------------- */}
      <section className="adm-panel">
        <h2>Campus settings</h2>

        {!settingsAvailable ? (
          <p className="muted">
            The campus settings table has not been added to the database yet
            (migration <code>20261103100000_campus_map_live_tracking</code>).
            Until it is applied, the map centre comes from the environment
            defaults — nothing else changes.
          </p>
        ) : (
          <>
            <p className="muted" style={{ marginTop: -6, fontSize: 13 }}>
              Sets the university campus name and where every map opens. Leave
              the coordinates empty until they are known — the app keeps its
              current default centre until you save them here.
            </p>
            {settingsError && <div className="error" role="alert">{settingsError}</div>}
            {settingsNotice && <div className="ok" role="status">{settingsNotice}</div>}
            <form onSubmit={saveSettings}>
              <div className="adm-form-grid">
                <div>
                  <label>Campus name</label>
                  <input
                    value={settingsForm.campus_name}
                    onChange={setSetting('campus_name')}
                    placeholder="e.g. University name"
                    maxLength={80}
                  />
                </div>
                <div>
                  <label>Map zoom (1–20)</label>
                  <input
                    value={settingsForm.zoom}
                    onChange={setSetting('zoom')}
                    inputMode="numeric"
                    placeholder="14"
                  />
                </div>
                <div>
                  <label>Centre latitude</label>
                  <input
                    value={settingsForm.center_lat}
                    onChange={setSetting('center_lat')}
                    inputMode="decimal"
                    placeholder="Leave empty until known"
                  />
                </div>
                <div>
                  <label>Centre longitude</label>
                  <input
                    value={settingsForm.center_lng}
                    onChange={setSetting('center_lng')}
                    inputMode="decimal"
                    placeholder="Leave empty until known"
                  />
                </div>
              </div>
              <button
                type="submit"
                className="adm-btn"
                style={{ height: 44, lineHeight: '42px', marginTop: 12 }}
                disabled={settingsBusy}
              >
                {settingsBusy ? 'Saving…' : 'Save campus settings'}
              </button>
            </form>
          </>
        )}
      </section>
    </AdminLayout>
  )
}
