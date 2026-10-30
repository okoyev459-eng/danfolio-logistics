import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'
import { supabase } from '../../lib/supabase'

// Admin reports management — read student reports, mark resolved
// (reports admin update policy).
export default function AdminReports() {
  const [rows, setRows] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState('')

  async function load() {
    const { data, error: readError } = await supabase
      .from('reports')
      .select(`
        id, reason, details, status, created_at,
        student:profiles!reports_student_id_fkey(full_name, matric_no),
        keke:kekes!reports_keke_id_fkey(keke_number),
        ride:rides!reports_ride_id_fkey(booking_code, status)
      `)
      .order('created_at', { ascending: false })
      .limit(100)

    if (readError) setError(readError.message)
    else setRows(data ?? [])
  }

  useEffect(() => {
    load()
  }, [])

  async function toggleStatus(row) {
    setBusyId(row.id)
    setError('')

    const { error: writeError } = await supabase
      .from('reports')
      .update({ status: row.status === 'open' ? 'resolved' : 'open' })
      .eq('id', row.id)

    setBusyId(null)
    if (writeError) setError(writeError.message)
    else load()
  }

  return (
    <Layout title="Admin · Reports">
      <Link to="/admin">← Dashboard</Link>
      <h2>Student reports</h2>

      {error && <div className="error">{error}</div>}
      {rows === null && !error && <p className="muted">Loading…</p>}
      {rows && rows.length === 0 && <div className="card muted">No reports filed.</div>}

      {(rows ?? []).map((row) => {
        const student = Array.isArray(row.student) ? row.student[0] : row.student
        const keke = Array.isArray(row.keke) ? row.keke[0] : row.keke
        const ride = Array.isArray(row.ride) ? row.ride[0] : row.ride

        return (
          <div className="card" key={row.id}>
            <div className="row">
              <b>{row.reason}</b>
              <span className="badge">{row.status}</span>
            </div>
            <p style={{ margin: '6px 0' }}>{row.details}</p>
            <p className="muted" style={{ fontSize: 13 }}>
              {new Date(row.created_at).toLocaleString()} ·{' '}
              {student ? `${student.full_name ?? 'student'} (${student.matric_no ?? '—'})` : 'student —'}
              {keke && <> · keke {keke.keke_number}</>}
              {ride && <> · booking {ride.booking_code} ({ride.status})</>}
            </p>
            <button
              type="button"
              className="secondary"
              style={{ marginTop: 0 }}
              disabled={busyId === row.id}
              onClick={() => toggleStatus(row)}
            >
              {busyId === row.id
                ? 'Saving…'
                : row.status === 'open' ? 'Mark resolved' : 'Reopen'}
            </button>
          </div>
        )
      })}
    </Layout>
  )
}
