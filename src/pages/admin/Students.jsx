import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'
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
    <Layout title="Admin · Students">
      <Link to="/admin">← Dashboard</Link>
      <h2>Students</h2>
      <p className="muted">Registered student accounts.</p>

      {error && <div className="error">{error}</div>}
      {rows === null && !error && <p className="muted">Loading…</p>}
      {rows && rows.length === 0 && <div className="card muted">No students registered yet.</div>}

      {(rows ?? []).map((row) => {
        const initials = (row.full_name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
        return (
          <div className="card row" key={row.id}>
            <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              {row.avatar_url
                ? <img src={row.avatar_url} alt="" style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover' }} />
                : <span aria-hidden="true" style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--sky)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>{initials}</span>}
              <span>
                <b>{row.full_name ?? '—'}</b>
                <br />
                <span className="muted">
                  {row.matric_no ?? 'no matric'}{row.phone ? ` · ${row.phone}` : ''}
                </span>
              </span>
            </span>
            <span className="muted" style={{ fontSize: 13 }}>
              {new Date(row.created_at).toLocaleDateString()}
            </span>
          </div>
        )
      })}
    </Layout>
  )
}
