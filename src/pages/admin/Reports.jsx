import { useEffect, useState } from 'react'
import AdminLayout from '../../components/AdminLayout.jsx'
import { supabase } from '../../lib/supabase'

// Admin reports management (mockup A4 "reports and tickets"): a table of
// student reports with a detail panel. The only actions are the real ones —
// mark resolved / reopen (reports admin update policy).
export default function AdminReports() {
  const [rows, setRows] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
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

  const selected = (rows ?? []).find((r) => r.id === selectedId) ?? null

  function related(row) {
    const student = Array.isArray(row.student) ? row.student[0] : row.student
    const keke = Array.isArray(row.keke) ? row.keke[0] : row.keke
    const ride = Array.isArray(row.ride) ? row.ride[0] : row.ride
    return { student, keke, ride }
  }

  return (
    <AdminLayout title="Reports and tickets">
      {error && <div className="error" role="alert">{error}</div>}
      {rows === null && !error && <p className="muted">Loading…</p>}
      {rows && rows.length === 0 && (
        <div className="adm-panel muted">No reports filed.</div>
      )}

      {rows && rows.length > 0 && (
        <div className="adm-grid2">
          <section className="adm-panel">
            <h2>Student reports</h2>
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Reason</th>
                    <th>Student</th>
                    <th>Keke</th>
                    <th>Booking</th>
                    <th>Filed</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(rows ?? []).map((row) => {
                    const { student, keke, ride } = related(row)
                    return (
                      <tr
                        key={row.id}
                        className={'adm-row-btn' + (row.id === selectedId ? ' sel' : '')}
                        onClick={() => setSelectedId(row.id)}
                      >
                        <td><b>{row.reason}</b></td>
                        <td>
                          {student ? student.full_name ?? 'student' : 'student'}
                          <div className="muted">{student?.matric_no ?? ''}</div>
                        </td>
                        <td>{keke ? keke.keke_number : '—'}</td>
                        <td className="muted">{ride ? ride.booking_code : '—'}</td>
                        <td className="muted">{new Date(row.created_at).toLocaleDateString()}</td>
                        <td>
                          <span className={`pill ${row.status === 'open' ? 'open' : 'online'}`}>
                            {row.status}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="adm-report-detail">
            {!selected && (
              <p className="muted">Select a report to see its details.</p>
            )}
            {selected && (() => {
              const { student, keke, ride } = related(selected)
              return (
                <>
                  <h2>{selected.reason}</h2>
                  <span className={`pill ${selected.status === 'open' ? 'open' : 'online'}`}>
                    {selected.status}
                  </span>
                  <p>{selected.details || 'No extra details were provided.'}</p>
                  <p className="muted" style={{ fontSize: 13 }}>
                    {new Date(selected.created_at).toLocaleString()} ·{' '}
                    {student ? `${student.full_name ?? 'student'} (${student.matric_no ?? '—'})` : 'student —'}
                    {keke && <> · keke {keke.keke_number}</>}
                    {ride && <> · booking {ride.booking_code} ({String(ride.status).replaceAll('_', ' ')})</>}
                  </p>
                  <button
                    type="button"
                    className="adm-btn"
                    style={{ height: 44, lineHeight: '42px', marginTop: 8 }}
                    disabled={busyId === selected.id}
                    onClick={() => toggleStatus(selected)}
                  >
                    {busyId === selected.id
                      ? 'Saving…'
                      : selected.status === 'open' ? 'Mark resolved' : 'Reopen'}
                  </button>
                </>
              )
            })()}
          </section>
        </div>
      )}
    </AdminLayout>
  )
}
