import { useEffect, useState } from 'react'
import AdminLayout from '../../components/AdminLayout.jsx'
import { supabase } from '../../lib/supabase'

// Admin keke management (mockup A2 "kekes"): a table with status pills,
// station assignment and availability controls (spec: station assignment
// and availability controls).
// RLS: admins may update any kekes row (kekes update policy).
const STATUS_OPTIONS = [
  { value: 'online', label: 'Online' },
  { value: 'offline', label: 'Offline' },
  { value: 'unavailable', label: 'Unavailable' },
]

const STATUS_PILL = {
  online: 'online',
  on_trip: 'trip',
  offline: 'muted-pill',
  unavailable: 'pending',
}

export default function AdminKekes() {
  const [rows, setRows] = useState(null)
  const [stations, setStations] = useState([])
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState('')

  async function load() {
    const [{ data, error: readError }, { data: locs }] = await Promise.all([
      supabase
        .from('kekes')
        .select('id, keke_number, status, station_id, last_seen, rating, queue_joined_at, profiles:profiles!kekes_id_fkey(full_name, phone)')
        .order('keke_number'),
      supabase.from('locations').select('id, name').eq('kind', 'station').eq('mode', 'along').order('name'),
    ])

    if (readError) setError(readError.message)
    else setRows(data ?? [])
    setStations(locs ?? [])
  }

  useEffect(() => {
    load()
  }, [])

  async function setStatus(id, status) {
    setBusyId(id)
    setError('')

    const payload = { status, last_seen: new Date().toISOString() }
    if (status !== 'online') payload.queue_joined_at = null

    const { error: writeError } = await supabase
      .from('kekes')
      .update(payload)
      .eq('id', id)
      // Never clobber a rider who is physically on a trip.
      .neq('status', 'on_trip')

    setBusyId(null)
    if (writeError) setError(writeError.message)
    else load()
  }

  async function setStation(id, stationId) {
    setBusyId(id)
    setError('')

    const { error: writeError } = await supabase
      .from('kekes')
      .update({
        station_id: stationId || null,
        queue_joined_at: stationId ? new Date().toISOString() : null,
      })
      .eq('id', id)

    setBusyId(null)
    if (writeError) setError(writeError.message)
    else load()
  }

  return (
    <AdminLayout title="Kekes">
      <p className="adm-sub">
        Setting a rider online makes them eligible for dispatch right away
        (their last_seen is refreshed). A rider on a trip is never changed.
      </p>

      {error && <div className="error" role="alert">{error}</div>}
      {rows === null && !error && <p className="muted">Loading…</p>}
      {rows && rows.length === 0 && (
        <div className="adm-panel muted">No keke riders registered yet.</div>
      )}

      {rows && rows.length > 0 && (
        <div className="adm-panel">
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Keke</th>
                  <th>Rider</th>
                  <th>Status</th>
                  <th>Rating</th>
                  <th>Last seen</th>
                  <th>Station (Along queue)</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((row) => {
                  const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles
                  return (
                    <tr key={row.id}>
                      <td><span className="plate">{row.keke_number}</span></td>
                      <td>
                        <b>{profile?.full_name ?? '—'}</b>
                        {profile?.phone && (
                          <div className="muted">{profile.phone}</div>
                        )}
                      </td>
                      <td>
                        <span className={`pill ${STATUS_PILL[row.status] ?? ''}`}>
                          {String(row.status).replaceAll('_', ' ')}
                        </span>
                      </td>
                      <td>{Number(row.rating).toFixed(1)}</td>
                      <td className="muted">
                        {row.last_seen ? new Date(row.last_seen).toLocaleString() : 'never'}
                      </td>
                      <td>
                        <select
                          className="adm-select"
                          style={{ height: 40, minWidth: 140 }}
                          value={row.station_id ?? ''}
                          onChange={(e) => setStation(row.id, e.target.value)}
                          disabled={busyId === row.id || row.status === 'on_trip'}
                          aria-label={`Station for keke ${row.keke_number}`}
                        >
                          <option value="">No station</option>
                          {stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </td>
                      <td>
                        {STATUS_OPTIONS.map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            className="adm-btn secondary"
                            disabled={
                              busyId === row.id ||
                              row.status === 'on_trip' ||
                              row.status === opt.value
                            }
                            onClick={() => setStatus(row.id, opt.value)}
                          >
                            {opt.label}
                          </button>
                        ))}
                        {row.status === 'on_trip' && (
                          <div className="muted" style={{ marginTop: 4 }}>
                            Locked while on a trip.
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </AdminLayout>
  )
}
