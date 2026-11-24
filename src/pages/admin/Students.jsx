import { useEffect, useState } from 'react'
import AdminLayout from '../../components/AdminLayout.jsx'
import { supabase } from '../../lib/supabase'

// Admin student management — view registered students (spec: student and
// rider management). Profiles are readable by admins (profiles read policy).
// Deleting an account goes through the admin-delete-user function: it
// removes the login, the profile and every ride/ticket/payment attached,
// in FK-safe order (RLS alone cannot — no DELETE policies, and auth.users
// needs the service-role admin API).
export default function AdminStudents() {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyId, setBusyId] = useState(null)

  async function load() {
    const { data, error: readError } = await supabase
      .from('profiles')
      .select('id, full_name, matric_no, phone, avatar_url, created_at')
      .eq('role', 'student')
      .order('created_at', { ascending: false })

    if (readError) setError(readError.message)
    else setRows(data ?? [])
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function remove(row) {
    const name = row.full_name || 'this student'
    const confirmed = window.confirm(
      `Delete ${name}? This permanently removes their account together with every ride, ticket and payment attached to it. This cannot be undone.`,
    )
    if (!confirmed) return

    setBusyId(row.id)
    setError('')
    setNotice('')

    const { data, error: fnError } = await supabase.functions.invoke('admin-delete-user', {
      body: { user_id: row.id },
    })

    setBusyId(null)

    if (fnError) {
      let detail = fnError.message
      try {
        const payload = await fnError.context?.json?.()
        detail = payload?.error || detail
      } catch {}
      setError(`Delete failed: ${detail}`)
      return
    }
    if (data?.error) {
      setError(`Delete failed: ${data.error}`)
      return
    }

    const rides = data?.deleted?.rides ?? 0
    setNotice(`Deleted ${name}${rides ? ` and ${rides} ride(s)` : ''}.`)
    load()
  }

  return (
    <AdminLayout title="Students">
      <p className="adm-sub">Registered student accounts.</p>

      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="ok" role="status">{notice}</div>}
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
                  <th>Actions</th>
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
                      <td>
                        <button
                          type="button"
                          className="adm-btn secondary"
                          disabled={busyId === row.id}
                          onClick={() => remove(row)}
                        >
                          {busyId === row.id ? 'Deleting…' : 'Delete'}
                        </button>
                      </td>
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
