import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'
import { supabase } from '../../lib/supabase'

// Admin keke management — status + station assignment + availability
// controls (spec: station assignment and availability controls).
// RLS: admins may update any kekes row (kekes update policy).
const STATUS_OPTIONS = [
  { value: 'online', label: 'Online' },
  { value: 'offline', label: 'Offline' },
  { value: 'unavailable', label: 'Unavailable' },
]

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
    <Layout title="Admin · Keke riders">
      <Link to="/admin">← Dashboard</Link>
      <h2>Keke riders</h2>
      <p className="muted">
        Setting a rider online makes them eligible for dispatch right away
        (their last_seen is refreshed). A rider on a trip is never changed.
      </p>

      {error && <div className="error">{error}</div>}
      {rows === null && <p className="muted">Loading…</p>}

      {(rows ?? []).map((row) => {
        const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles
        return (
          <div className="card" key={row.id}>
            <div className="row">
              <span>
                <span className="plate">{row.keke_number}</span>
                <br />
                <b>{profile?.full_name ?? '—'}</b>
                {profile?.phone && <span className="muted"> · {profile.phone}</span>}
              </span>
              <span className="badge">{row.status}</span>
            </div>

            <p className="muted" style={{ fontSize: 13 }}>
              Rating {Number(row.rating).toFixed(1)} · last seen{' '}
              {row.last_seen ? new Date(row.last_seen).toLocaleString() : 'never'}
            </p>

            <label>Station (Along queue)</label>
            <select
              value={row.station_id ?? ''}
              onChange={(e) => setStation(row.id, e.target.value)}
              disabled={busyId === row.id || row.status === 'on_trip'}
              style={{ width: '100%', height: 44, borderRadius: 12, border: '1px solid #cbd5e1', font: 'inherit', padding: '0 10px' }}
            >
              <option value="">No station</option>
              {stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              {STATUS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className="secondary"
                  style={{ marginTop: 0, width: 'auto', padding: '0 14px', height: 40, lineHeight: '40px', fontSize: 14, opacity: row.status === opt.value ? 0.5 : 1 }}
                  disabled={busyId === row.id || row.status === 'on_trip' || row.status === opt.value}
                  onClick={() => setStatus(row.id, opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {row.status === 'on_trip' && (
              <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                This rider is on a trip; status changes are locked until the
                trip finishes.
              </p>
            )}
          </div>
        )
      })}
    </Layout>
  )
}
