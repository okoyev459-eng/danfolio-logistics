import { useEffect, useState } from 'react'
import Layout from '../components/Layout.jsx'
import CampusMap from '../components/CampusMap.jsx'
import { supabase } from '../lib/supabase'

// StationMap — campus map of stations/pickups/destinations and live kekes.
// Replaces the earlier Google Maps prototype with the free stack
// (MapLibre GL JS + OpenFreeMap tiles + OpenStreetMap data).
//
// Reads real rows from `locations` and live positions from `kekes` (realtime
// is enabled for kekes). Locations without coordinates still render in the
// list below the map — the map degrades gracefully until the admin enters
// lat/lng for each point.
export default function StationMap() {
  const [locations, setLocations] = useState(null)
  const [kekes, setKekes] = useState([])
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true

    async function load() {
      const { data, error: locError } = await supabase
        .from('locations')
        .select('id, name, kind, mode, lat, lng, active')
        .eq('active', true)
        .order('name')

      if (!active) return
      if (locError) setError('Could not load map points.')
      else setLocations(data ?? [])

      const { data: kekeRows } = await supabase
        .from('kekes')
        .select('id, keke_number, status, lat, lng')
        .eq('status', 'online')

      if (active && kekeRows) setKekes(kekeRows.filter((k) => k.lat && k.lng))
    }

    load()

    const channel = supabase
      .channel('station-map-kekes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'kekes' },
        (payload) => {
          if (!active) return
          setKekes((current) => {
            const row = payload.new
            if (!row?.lat || !row?.lng || row.status !== 'online') {
              return current.filter((k) => k.id !== row?.id)
            }
            const next = current.filter((k) => k.id !== row.id)
            next.push({ id: row.id, keke_number: row.keke_number, lat: row.lat, lng: row.lng })
            return next
          })
        }
      )
      .subscribe()

    return () => {
      active = false
      supabase.removeChannel(channel)
    }
  }, [])

  const points = (locations ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    kind: l.kind,
    lat: l.lat,
    lng: l.lng,
  }))

  const missingCoords = (locations ?? []).filter((l) => !l.lat || !l.lng).length

  return (
    <Layout title="Campus map">
      <h2>Campus map</h2>
      <p className="muted">
        Stations, pick-up points and destinations, plus online kekes.
      </p>

      {error && <div className="error">{error}</div>}

      <CampusMap points={points} kekes={kekes} height={320} />

      {missingCoords > 0 && (
        <p className="muted" style={{ fontSize: 13 }}>
          {missingCoords} location{missingCoords === 1 ? '' : 's'} still need
          coordinates from the admin before they appear on the map.
        </p>
      )}

      <h2 style={{ marginTop: 20 }}>Points</h2>
      {(locations ?? []).map((l) => (
        <div className="card row" key={l.id}>
          <span>
            <b>{l.name}</b>
            <br />
            <span className="muted">{l.kind} · {l.mode}</span>
          </span>
          <span className="badge">
            {l.lat && l.lng ? 'mapped' : 'no coordinates'}
          </span>
        </div>
      ))}
      {locations !== null && locations.length === 0 && (
        <div className="card muted">No active locations yet.</div>
      )}
      {locations === null && !error && <p className="muted">Loading…</p>}
    </Layout>
  )
}
