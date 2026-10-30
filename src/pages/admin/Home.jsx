import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'
import { supabase } from '../../lib/supabase'

// Admin home — dashboard overview + links to every management screen.
// Stats come from the admin's own RLS reads (is_admin() policies).
const nav = [
  { to: '/admin/rides', label: 'Rides & bookings', desc: 'Live bookings, cancel, refund' },
  { to: '/admin/kekes', label: 'Keke riders', desc: 'Status, station, availability' },
  { to: '/admin/locations', label: 'Stations & points', desc: 'Pickups, stations, destinations' },
  { to: '/admin/fares', label: 'Fares', desc: 'Fixed prices per route' },
  { to: '/admin/reports', label: 'Reports', desc: 'Student reports to resolve' },
  { to: '/admin/register-keke', label: 'Register a keke', desc: 'Create a rider login' },
]

export default function AdminHome() {
  const [stats, setStats] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true

    async function load() {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const start = today.toISOString()

      const [ridesRes, kekesRes, paymentsRes, reportsRes, studentsRes] =
        await Promise.all([
          supabase.from('rides').select('id, status, fare, created_at'),
          supabase.from('kekes').select('id, status'),
          supabase.from('payments').select('id, status, amount'),
          supabase.from('reports').select('id, status'),
          supabase.from('profiles').select('id, role').eq('role', 'student'),
        ])

      if (!active) return

      const firstError =
        ridesRes.error || kekesRes.error || paymentsRes.error ||
        reportsRes.error || studentsRes.error

      if (firstError) {
        setError(`Could not load dashboard: ${firstError.message}`)
        return
      }

      const rides = ridesRes.data ?? []
      const kekes = kekesRes.data ?? []
      const payments = paymentsRes.data ?? []
      const reports = reportsRes.data ?? []
      const todayRides = rides.filter((r) => r.created_at >= start)

      setStats({
        ridesToday: todayRides.length,
        activeRides: rides.filter((r) =>
          ['searching', 'accepted', 'paid', 'arrived', 'on_trip'].includes(r.status)
        ).length,
        completedToday: todayRides.filter((r) => r.status === 'completed').length,
        revenueToday: payments
          .filter((p) => p.status === 'success')
          .reduce((sum, p) => sum + Number(p.amount || 0), 0),
        refundedTotal: payments
          .filter((p) => p.status === 'refunded')
          .reduce((sum, p) => sum + Number(p.amount || 0), 0),
        ridersOnline: kekes.filter((k) => k.status === 'online').length,
        ridersOnTrip: kekes.filter((k) => k.status === 'on_trip').length,
        ridersOffline: kekes.filter((k) => k.status === 'offline').length,
        ridersUnavailable: kekes.filter((k) => k.status === 'unavailable').length,
        openReports: reports.filter((r) => r.status === 'open').length,
        students: (studentsRes.data ?? []).length,
      })
    }

    load()
    const timer = window.setInterval(load, 15000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  const card = (label, value) => (
    <div className="card row" key={label} style={{ marginBottom: 8 }}>
      <span className="muted">{label}</span>
      <b>{value}</b>
    </div>
  )

  return (
    <Layout title="Admin">
      <h2>Dashboard</h2>
      {error && <div className="error">{error}</div>}
      {!stats && !error && <p className="muted">Loading…</p>}

      {stats && (
        <>
          <div className="fare">
            <span>Revenue recorded today</span>
            <b>₦{stats.revenueToday.toLocaleString()}</b>
            <span className="badge">{stats.completedToday} trips completed today</span>
          </div>

          <h2 style={{ marginTop: 20 }}>Today</h2>
          {card('Rides created', stats.ridesToday)}
          {card('Active rides (all states)', stats.activeRides)}

          <h2 style={{ marginTop: 20 }}>Keke riders</h2>
          {card('Online', stats.ridersOnline)}
          {card('On a trip', stats.ridersOnTrip)}
          {card('Unavailable', stats.ridersUnavailable)}
          {card('Offline', stats.ridersOffline)}

          <h2 style={{ marginTop: 20 }}>Overview</h2>
          {card('Registered students', stats.students)}
          {card('Open reports', stats.openReports)}
          {card('Lifetime refunded (₦)', stats.refundedTotal.toLocaleString())}
        </>
      )}

      <h2 style={{ marginTop: 24 }}>Manage</h2>
      {nav.map((item) => (
        <Link className="plain" to={item.to} key={item.to}>
          <div className="card">
            <b>{item.label}</b>
            <div className="muted">{item.desc}</div>
          </div>
        </Link>
      ))}
    </Layout>
  )
}
