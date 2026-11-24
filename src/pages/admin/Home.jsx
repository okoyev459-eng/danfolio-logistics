import { useEffect, useMemo, useState } from 'react'
import AdminLayout from '../../components/AdminLayout.jsx'
import CampusMap from '../../components/CampusMap.jsx'
import { supabase } from '../../lib/supabase'
import { validCoord } from '../../lib/geo'

// Admin overview (mockup A1 "live overview"): stat-card row, the live campus
// map (real keke GPS rows + stations), and the list of active rides.
// Stats come from the admin's own RLS reads (is_admin() policies).
const ACTIVE = ['searching', 'accepted', 'paid', 'arrived', 'on_trip']

export default function AdminHome() {
  const [stats, setStats] = useState(null)
  const [rides, setRides] = useState([])
  const [kekes, setKekes] = useState([])
  const [stations, setStations] = useState([])
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true

    async function load() {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const start = today.toISOString()

      const [ridesRes, kekesRes, paymentsRes, reportsRes, studentsRes, locationsRes] =
        await Promise.all([
          supabase
            .from('rides')
            .select(`
              id, status, fare, created_at,
              from:locations!rides_from_id_fkey(name),
              to:locations!rides_to_id_fkey(name),
              student:profiles!rides_student_id_fkey(full_name),
              keke:kekes!rides_keke_id_fkey(keke_number)
            `)
            .order('created_at', { ascending: false })
            .limit(200),
          supabase.from('kekes').select('id, status, lat, lng, last_seen'),
          supabase.from('payments').select('id, status, amount'),
          supabase.from('reports').select('id, status'),
          supabase.from('profiles').select('id, role').eq('role', 'student'),
          supabase
            .from('locations')
            .select('id, name, lat, lng, kind')
            .eq('kind', 'station')
            .eq('active', true),
        ])

      if (!active) return

      const firstError =
        ridesRes.error || kekesRes.error || paymentsRes.error ||
        reportsRes.error || studentsRes.error || locationsRes.error

      if (firstError) {
        setError(`Could not load dashboard: ${firstError.message}`)
        return
      }

      const rideRows = ridesRes.data ?? []
      const kekeRows = kekesRes.data ?? []
      const payments = paymentsRes.data ?? []
      const reports = reportsRes.data ?? []
      const todayRides = rideRows.filter((r) => r.created_at >= start)

      setRides(rideRows.filter((r) => ACTIVE.includes(r.status)))
      setKekes(kekeRows)
      setStations(locationsRes.data ?? [])

      setStats({
        ridesToday: todayRides.length,
        activeRides: rideRows.filter((r) => ACTIVE.includes(r.status)).length,
        completedToday: todayRides.filter((r) => r.status === 'completed').length,
        revenueToday: payments
          .filter((p) => p.status === 'success')
          .reduce((sum, p) => sum + Number(p.amount || 0), 0),
        refundedTotal: payments
          .filter((p) => p.status === 'refunded')
          .reduce((sum, p) => sum + Number(p.amount || 0), 0),
        ridersOnline: kekeRows.filter((k) => k.status === 'online').length,
        ridersOnTrip: kekeRows.filter((k) => k.status === 'on_trip').length,
        ridersOffline: kekeRows.filter((k) => k.status === 'offline').length,
        ridersUnavailable: kekeRows.filter((k) => k.status === 'unavailable').length,
        openReports: reports.filter((r) => r.status === 'open').length,
        students: (studentsRes.data ?? []).length,
      })
    }

    load()
    const timer = window.setInterval(load, 15000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  // Only kekes with a real GPS fix render on the map (rows with NULL coords
  // are honestly hidden).
  const kekeMarkers = useMemo(
    () =>
      kekes
        .filter((k) => validCoord(k))
        .map((k) => ({ id: k.id, lat: Number(k.lat), lng: Number(k.lng) })),
    [kekes]
  )

  const stationPoints = useMemo(
    () =>
      stations
        .filter((s) => validCoord(s))
        .map((s) => ({ id: s.id, name: s.name, lat: Number(s.lat), lng: Number(s.lng), kind: 'station' })),
    [stations]
  )

  const gpsCount = kekeMarkers.length

  return (
    <AdminLayout title="Overview">
      {error && <div className="error" role="alert">{error}</div>}
      {!stats && !error && (
        <div aria-hidden="true">
          <div className="skeleton skeleton-card" />
          <div className="skeleton skeleton-card" />
          <div className="skeleton skeleton-card" />
        </div>
      )}

      {stats && (
        <div className="app-fade">
          <div className="adm-stats pop-in">
            <div className="adm-stat">
              <span>Today’s rides</span>
              <strong>{stats.ridesToday}</strong>
            </div>
            <div className="adm-stat">
              <span>Active rides</span>
              <strong>{stats.activeRides}</strong>
            </div>
            <div className="adm-stat">
              <span>Kekes online</span>
              <strong>{stats.ridersOnline}</strong>
            </div>
            <div className="adm-stat">
              <span>On a trip</span>
              <strong>{stats.ridersOnTrip}</strong>
            </div>
            <div className="adm-stat">
              <span>Revenue today</span>
              <strong>₦{stats.revenueToday.toLocaleString()}</strong>
            </div>
            <div className="adm-stat">
              <span>Open reports</span>
              <strong>{stats.openReports}</strong>
            </div>
          </div>

          <div className="adm-grid2">
            <section>
              <div className="adm-map">
                <CampusMap
                  kekes={kekeMarkers}
                  points={stationPoints}
                  height="100%"
                />
              </div>
              <p className="adm-legend">
                Navy squares are kekes with a live GPS signal ({gpsCount} of{' '}
                {kekes.length} riders). Blue pins are ride stations. Riders
                without a location fix are hidden until they send one.
              </p>
            </section>

            <section className="adm-panel">
              <h2>Active rides</h2>
              {rides.length === 0 && (
                <p className="muted">No active rides right now.</p>
              )}
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th>Route</th>
                      <th>Status</th>
                      <th>Fare</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rides.slice(0, 12).map((ride) => {
                      const student = Array.isArray(ride.student) ? ride.student[0] : ride.student
                      const keke = Array.isArray(ride.keke) ? ride.keke[0] : ride.keke
                      return (
                        <tr key={ride.id}>
                          <td>
                            <b>{ride.from?.name} → {ride.to?.name}</b>
                            <div className="muted">
                              {student?.full_name ?? 'student'}
                              {keke && ` · keke ${keke.keke_number}`}
                            </div>
                          </td>
                          <td>
                            <span className="pill trip">
                              {String(ride.status).replaceAll('_', ' ')}
                            </span>
                          </td>
                          <td>₦{Number(ride.fare).toLocaleString()}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div className="adm-legend" style={{ marginTop: 10 }}>
                Riders online: {stats.ridersOnline} · offline: {stats.ridersOffline}{' '}
                · unavailable: {stats.ridersUnavailable} · students:{' '}
                {stats.students} · lifetime refunded: ₦
                {stats.refundedTotal.toLocaleString()}
              </div>
            </section>
          </div>
        </div>
      )}
    </AdminLayout>
  )
}
