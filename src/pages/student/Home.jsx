import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'
import { useAuth } from '../../lib/auth.jsx'
import { supabase } from '../../lib/supabase'

// Student home — greeting + book, active-ride banner, ride history tab and
// profile tab (photo upload per spec G5; rides/reports list per G6).

const ACTIVE_STATUSES = ['searching', 'accepted', 'paid', 'arrived', 'on_trip']

export default function StudentHome() {
  const { session, signOut } = useAuth()
  const [tab, setTab] = useState('Home')
  const [profile, setProfile] = useState(null)
  const [rides, setRides] = useState(null)
  const [reports, setReports] = useState([])
  const [activeRide, setActiveRide] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const fileRef = useRef(null)

  useEffect(() => {
    let active = true

    supabase
      .from('profiles')
      .select('full_name, matric_no, avatar_url')
      .eq('id', session.user.id)
      .single()
      .then(({ data }) => { if (active && data) setProfile(data) })

    supabase
      .from('rides')
      .select('id, fare, status, created_at, from:locations!rides_from_id_fkey(name), to:locations!rides_to_id_fkey(name), ticket:tickets(ticket_no, status)')
      .order('created_at', { ascending: false })
      .limit(20)
      .then(({ data }) => {
        if (!active) return
        const rows = data ?? []
        setRides(rows)
        setActiveRide(rows.find((r) => ACTIVE_STATUSES.includes(r.status)) ?? null)
      })

    supabase
      .from('reports')
      .select('id, reason, status, created_at')
      .order('created_at', { ascending: false })
      .limit(10)
      .then(({ data }) => { if (active && data) setReports(data) })

    return () => { active = false }
  }, [session])

  async function uploadAvatar(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || uploading) return

    if (!file.type.startsWith('image/')) {
      setUploadError('Please choose an image file.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadError('Please choose an image smaller than 5 MB.')
      return
    }

    setUploading(true)
    setUploadError('')

    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
    const path = `${session.user.id}/avatar.${ext}`

    const { error: uploadErr } = await supabase.storage
      .from('avatars')
      .upload(path, file, { upsert: true, cacheControl: '3600' })

    if (uploadErr) {
      setUploading(false)
      setUploadError(
        uploadErr.message?.includes('bucket')
          ? 'Photo upload is not enabled on the server yet.'
          : `Could not upload the photo: ${uploadErr.message}`
      )
      return
    }

    const { data: pub } = supabase.storage.from('avatars').getPublicUrl(path)
    const url = `${pub.publicUrl}?v=${Date.now()}`

    const { error: saveErr } = await supabase
      .from('profiles')
      .update({ avatar_url: url })
      .eq('id', session.user.id)

    setUploading(false)

    if (saveErr) {
      setUploadError(`Could not save the photo: ${saveErr.message}`)
      return
    }

    setProfile((p) => ({ ...(p ?? {}), avatar_url: url }))
  }

  const name = (profile?.full_name ?? '').split(' ')[0]
  const initials = (profile?.full_name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()

  const pastRides = (rides ?? []).filter((r) => !ACTIVE_STATUSES.includes(r.status))

  return (
    <Layout title="Student">
      <nav style={{ display: 'flex', gap: 8, marginBottom: 16 }} aria-label="Student navigation">
        {['Home', 'Rides', 'Profile'].map((item) => (
          <button
            key={item}
            type="button"
            className={tab === item ? '' : 'secondary'}
            style={{ height: 40, marginTop: 0, lineHeight: '40px', fontSize: 14 }}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </nav>

      {tab === 'Home' && (
        <>
          <h2>Hey {name}, where to?</h2>

          {activeRide && (
            <Link className="plain" to={`/student/ride/${activeRide.id}`}>
              <div className="fare" role="status">
                <span className="badge">Active ride</span>
                <h2 style={{ marginTop: 8 }}>
                  {activeRide.from?.name} → {activeRide.to?.name}
                </h2>
                <p>
                  Status: <b>{String(activeRide.status).replaceAll('_', ' ')}</b>
                  {' '}· ₦{Number(activeRide.fare).toLocaleString()}
                </p>
                <p>Tap to open your live ride screen →</p>
              </div>
            </Link>
          )}

          {!activeRide && (
            <Link className="btn" to="/student/book">Book a ride</Link>
          )}

          {activeRide && (
            <Link className="btn secondary" to="/student/book">Book another ride</Link>
          )}

          <h2 style={{ marginTop: 28 }}>Recent rides</h2>
          {rides === null && <p className="muted">Loading…</p>}
          {rides && rides.length === 0 && (
            <div className="card muted">No rides yet. Book your first one.</div>
          )}
          {(rides ?? []).slice(0, 5).map((r) => (
            <Link className="plain" to={`/student/ride/${r.id}`} key={r.id}>
              <div className="card row">
                <span>
                  {r.from?.name} to {r.to?.name}
                  <br />
                  <span className="muted">
                    {new Date(r.created_at).toLocaleDateString()} · {String(r.status).replaceAll('_', ' ')}
                  </span>
                </span>
                <span className="badge">₦{r.fare}</span>
              </div>
            </Link>
          ))}
        </>
      )}

      {tab === 'Rides' && (
        <>
          <h2>My rides</h2>
          {rides === null && <p className="muted">Loading…</p>}
          {rides && pastRides.length === 0 && (
            <div className="card muted">No finished rides yet.</div>
          )}
          {pastRides.map((r) => {
            const ticket = Array.isArray(r.ticket) ? r.ticket[0] : r.ticket
            return (
              <div className="card" key={r.id}>
                <div className="row">
                  <b>{r.from?.name} → {r.to?.name}</b>
                  <span className="badge">₦{r.fare}</span>
                </div>
                <p className="muted">
                  {new Date(r.created_at).toLocaleString()} · {String(r.status).replaceAll('_', ' ')}
                  {ticket && <> · ticket {ticket.ticket_no}</>}
                </p>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <Link to={`/student/ride/${r.id}`}>Details</Link>
                  {ticket && <Link to={`/student/ticket/${r.id}`}>Ticket</Link>}
                  {r.status === 'completed' && <Link to={`/student/review/${r.id}`}>Rate</Link>}
                  {r.status === 'completed' && <Link to={`/student/report/${r.id}`}>Report</Link>}
                </div>
              </div>
            )
          })}

          <h2 style={{ marginTop: 24 }}>My reports</h2>
          {reports.length === 0 && <div className="card muted">You have not filed any reports.</div>}
          {reports.map((rep) => (
            <div className="card row" key={rep.id}>
              <span>
                <b>{rep.reason}</b>
                <br />
                <span className="muted">{new Date(rep.created_at).toLocaleDateString()}</span>
              </span>
              <span className="badge">{rep.status}</span>
            </div>
          ))}
        </>
      )}

      {tab === 'Profile' && (
        <>
          <h2>Profile</h2>
          <div className="card" style={{ textAlign: 'center' }}>
            {profile?.avatar_url
              ? <img className="avatar" src={profile.avatar_url} alt="Your profile" />
              : <div className="avatar" role="img" aria-label="Your profile photo">{initials}</div>}

            <h2>{profile?.full_name ?? '—'}</h2>
            {profile?.matric_no && <p className="muted">{profile.matric_no}</p>}
            <p className="muted">{session.user.email}</p>

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={uploadAvatar}
            />
            <button
              type="button"
              className="secondary"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? 'Uploading…' : 'Change profile photo'}
            </button>
            {uploadError && <div className="error">{uploadError}</div>}
          </div>

          <button type="button" className="secondary" onClick={signOut}>
            Sign out
          </button>
        </>
      )}
    </Layout>
  )
}
