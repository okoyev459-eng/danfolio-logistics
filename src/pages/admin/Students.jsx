import { useEffect, useState } from 'react'
import AdminLayout from '../../components/AdminLayout.jsx'
import { supabase } from '../../lib/supabase'

// Admin student management — view registered students (spec: student and
// rider management). Profiles are readable by admins (profiles read policy).
export default function AdminStudents() {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true

    supabase
      .from('profiles')
      .select('id, full_name, matric_no, phone, avatar_url, created_at')
      .eq('role', 'student')
      .order('created_at', { ascending: false })
      .then(({ data, error: readError }) => {
        if (!active) return
        if (readError) setError(readError.message)
        else setRows(data ?? [])
      })

    return () => { active = false }
  }, [])

  return (
    <AdminLayout title="Students">
      <p className="adm-sub">Registered student accounts.</p>

      {error && <div className="error" role="alert">{error}</div>}
      {rows === null && !error && <p className="muted">Loading…</p>}

      <div className="adm-panel">
        {rows && rows.length === 0 && <p className="muted">No students registered yet.</p>}
        {rows && rows.length > 0 && (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Matric</th>
                  <th>Phone</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((row) => {
                  const initials = (row.full_name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
                  return (
                    <tr key={row.id}>
                      <td>
                        <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                          {row.avatar_url
                            ? <img src={row.avatar_url} alt="" style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover' }} />
                            : <span aria-hidden="true" style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--sky)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>{initials}</span>}
                          <b>{row.full_name ?? '—'}</b>
                        </span>
                      </td>
                      <td>{row.matric_no ?? 'no matric'}</td>
                      <td>{row.phone ?? '—'}</td>
                      <td className="muted">{new Date(row.created_at).toLocaleDateString()}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminLayout>
  )
}
