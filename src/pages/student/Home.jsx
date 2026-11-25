import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import CampusMap from '../../components/CampusMap.jsx'
import BottomSheet from '../../components/BottomSheet.jsx'
import { useAuth } from '../../lib/auth.jsx'
import { supabase } from '../../lib/supabase'
import { useGeolocation } from '../../lib/useGeolocation'
import { validCoord } from '../../lib/geo'
import { useArrivalNotice } from '../../lib/notify'
import './home.css'

// Student home — mockup artboard "2 Home": the campus map IS the screen.
//
// Layered on top of it: a glass brand bar, a scrollable dock (greeting, real
// quick-destination chips, active-ride banner, recent rides, Book a ride) and
// the Home / Rides / Profile bottom nav. Rides and Profile open as a sheet
// over the same map so the nav keeps its anchor.
//
// Every value on screen comes from Supabase: the chips are the first active
// destinations in `locations`, recent rides are this student's `rides` rows,
// and the map shows all campus points plus every keke with a fresh heartbeat
// (online or already carrying passengers) — no invented markers.

const ACTIVE_STATUSES = ['searching', 'accepted', 'paid', 'arrived', 'on_trip']

// Riders heartbeat every 20s; anything unseen for 90s is not shown as live.
const KEKE_FRESH_MS = 90000

const TABS = ['Home', 'Rides', 'Profile']

// Booking sheet snap points, in visible pixels/fractions of the space above
// the bottom nav: collapsed peek (greeting + destinations + Book a ride; the
// map keeps the majority of the screen), mid (recent rides), expanded.
const HOME_SNAPS = [270, 0.66, 0.9]

export default function StudentHome() {
  const { session, signOut } = useAuth()
  const navigate = useNavigate()
  // Real device GPS for the blue dot (spec §3). Permission states are
  // honest: denied / unavailable show a hint instead of a fake position.
  const geo = useGeolocation()

  const [tab, setTab] = useState('Home')
  const [sheetIndex, setSheetIndex] = useState(0)
  const [profile, setProfile] = useState(null)
  const [rides, setRides] = useState(null)
  const [reports, setReports] = useState([])
  const [activeRide, setActiveRide] = useState(null)
  // Mirror of `rides` for the realtime handler below (callbacks may not use
  // state updaters for side effects like recomputing activeRide).
  const ridesRef = useRef([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [points, setPoints] = useState([])
  const [kekes, setKekes] = useState([])
  const [mapFailed, setMapFailed] = useState(false)
  const [mapAttempt, setMapAttempt] = useState(0)
  const fileRef = useRef(null)

  // ------------------------------------------------------------------
  // Profile + ride history + reports
  // ------------------------------------------------------------------
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
        ridesRef.current = rows
        setRides(rows)
        setActiveRide(rows.find((r) => ACTIVE_STATUSES.includes(r.status)) ?? null)
      })

    supabase
      .from('reports')
      .select('id, reason, status, created_at')
      .order('created_at', { ascending: false })
      .limit(10)
      .then(({ data }) => { if (active && data) setReports(data ?? []) })

    return () => { active = false }
  }, [session])

  // Live status of THIS student's rides (realtime). The load above runs once
  // per session, so without this the active-ride pill AND the arrival notice
  // would be frozen at whatever the status was when Home mounted. RLS
  // delivers only this student's own ride rows (student_id filter is also
  // enforced server-side by Realtime's RLS check).
  useEffect(() => {
    if (!session) return

    const channel = supabase
      .channel(`home-my-rides-${session.user.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rides', filter: `student_id=eq.${session.user.id}` },
        (payload) => {
          const row = payload.new
          if (!row?.id) return
          const current = ridesRef.current
          if (!current.some((r) => r.id === row.id)) return // not in our page of 20
          const merged = current.map((r) => (r.id === row.id ? { ...r, ...row } : r))
          ridesRef.current = merged
          setRides(merged)
          setActiveRide(merged.find((r) => ACTIVE_STATUSES.includes(r.status)) ?? null)
        },
      )
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [session])

  // ------------------------------------------------------------------
  // Map data: campus points + every live keke (initial + Realtime + poll)
  // ------------------------------------------------------------------
  useEffect(() => {
    let active = true

    async function loadPoints() {
      const { data } = await supabase
        .from('locations')
        .select('id, name, kind, category, lat, lng')
        .eq('active', true)
        .order('name')
      if (active && data) setPoints(data)
    }

    async function loadKekes() {
      const { data } = await supabase
        .from('kekes')
        .select('id, keke_number, status, lat, lng, last_seen, rating, rating_count')
      if (active && data) setKekes(data)
    }

    loadPoints()
    loadKekes()
    const timer = window.setInterval(loadKekes, 15000)

    const channel = supabase
      .channel('home-keke-positions')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'kekes' },
        (payload) => {
          if (!active) return
          if (payload.eventType === 'DELETE') {
            setKekes((rows) => rows.filter((k) => k.id !== payload.old?.id))
          } else if (payload.new?.id) {
            setKekes((rows) => {
              const rest = rows.filter((k) => k.id !== payload.new.id)
              return [...rest, payload.new]
            })
          }
        },
      )
      .subscribe()

    return () => {
      active = false
      window.clearInterval(timer)
      supabase.removeChannel(channel)
    }
  }, [])

  // ------------------------------------------------------------------
  // Avatar upload (spec G5)
  // ------------------------------------------------------------------
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

  // ------------------------------------------------------------------
  // Derived
  // ------------------------------------------------------------------
  const name = (profile?.full_name ?? '').split(' ')[0]
  const initials = (profile?.full_name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()

  const pastRides = useMemo(
    () => (rides ?? []).filter((r) => !ACTIVE_STATUSES.includes(r.status)),
    [rides],
  )

  // Quick chips: the first active destinations the admin has configured.
  const chips = useMemo(() => {
    const seen = new Set()
    const out = []
    for (const p of points) {
      if (p.kind !== 'destination') continue
      if (seen.has(p.name)) continue
      seen.add(p.name)
      out.push(p)
      if (out.length === 3) break
    }
    return out
  }, [points])

  // All kekes with real coordinates and a fresh heartbeat — online riders and
  // riders already carrying passengers both show, so the map never lies about
  // how many kekes are actually around.
  const liveKekes = useMemo(() => {
    const now = Date.now()
    return kekes.filter(
      (k) =>
        validCoord(k) &&
        k.last_seen &&
        now - new Date(k.last_seen).getTime() < KEKE_FRESH_MS,
    )
  }, [kekes])

  // Every keke WITH coordinates goes on the map; CampusMap colours each
  // badge by its real heartbeat (live / updating slowly / offline), so a
  // stale fix is never shown as live and nothing is invented.
  const mapKekes = useMemo(() => kekes.filter((k) => validCoord(k)), [kekes])

  const mapPoints = useMemo(
    () => points.filter((p) => validCoord(p)),
    [points],
  )

  function bookTo(destination) {
    navigate('/student/book', { state: destination ? { presetTo: destination } : undefined })
  }

  // If the rider arrives while the student is on the home screen (not the
  // ride page), tell them here — one notice per ride, never twice: the ride
  // page's own hook keys on the same ride id, and only one page is mounted.
  useArrivalNotice(activeRide)

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  return (
    <div className="sh">
      <div className="sh-map">
        {mapFailed ? (
          <div className="bk-loading" role="alert" style={{ position: 'absolute', inset: 0 }}>
            <p>The campus map could not load. Check your connection.</p>
            <button
              type="button"
              className="secondary"
              style={{ maxWidth: 220 }}
              onClick={() => {
                setMapFailed(false)
                setMapAttempt((n) => n + 1)
              }}
            >
              Try again
            </button>
          </div>
        ) : (
          <CampusMap
            key={mapAttempt}
            points={mapPoints}
            kekes={mapKekes}
            height="100%"
            animate
            userLocation={geo.position}
            userAccuracy={geo.accuracy}
            onSelect={(point) => {
              if (point.kind === 'destination') bookTo(point.name)
            }}
            onFail={() => setMapFailed(true)}
          />
        )}

        {/* Honest GPS state — never a fabricated dot when permission is
            denied, the fix is unavailable, or the page is not a secure
            context (plain http:// — browsers refuse location outright). */}
        {(geo.state === 'denied' ||
          geo.state === 'insecure' ||
          geo.state === 'unavailable' ||
          geo.state === 'timeout') && (
          <div className="sh-gps" role="status">
            {geo.state === 'insecure'
              ? 'Location is blocked because this page is open over plain http:// — open the app over HTTPS to see your position on the map.'
              : geo.state === 'denied'
                ? 'Location access is off — turn it on to see your position on the map.'
                : 'Your location is unavailable right now — you can still browse the campus map.'}
          </div>
        )}
      </div>

      <div className="sh-top">
        <div className="sh-brand">Danfolio Logistics</div>
      </div>

      {tab === 'Home' && (
        <div className="sh-sheetwrap">
          <BottomSheet
            snaps={HOME_SNAPS}
            index={sheetIndex}
            onIndexChange={setSheetIndex}
            ariaLabel="Plan your ride"
            header={
              <>
          {activeRide && (
            <Link className="sh-active" to={`/student/ride/${activeRide.id}`}>
              <span>
                {String(activeRide.status).replaceAll('_', ' ')} ·{' '}
                ₦{Number(activeRide.fare).toLocaleString()}
              </span>
              <b>{activeRide.from?.name} → {activeRide.to?.name}</b>
              <span>Tap to track your ride live →</span>
            </Link>
          )}

          <div className="sh-greet">
            <h1>Hey {name || 'there'}, where to?</h1>
            <p>
              {liveKekes.length > 0
                ? `${liveKekes.length} keke${liveKekes.length === 1 ? '' : 's'} live on campus right now.`
                : 'Pick a destination below to get started.'}
            </p>

            {chips.length > 0 && (
              <div className="sh-chips">
                {chips.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="sh-chip"
                    onClick={() => bookTo(c.name)}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            )}
          </div>

                <button type="button" className="sh-book" onClick={() => bookTo(null)}>
                  Book a ride
                </button>
              </>
            }
          >
            <div className="sh-panel">
            <h2>Recent rides</h2>
            {rides === null && (
              <div className="sh-skel" role="status">
                <span className="sr-only">Loading your recent rides…</span>
                <div className="skeleton skeleton-row" />
                <div className="skeleton skeleton-row" />
                <div className="skeleton skeleton-row" />
              </div>
            )}
            {rides && rides.length === 0 && (
              <p className="sh-empty">No rides yet. Book your first one.</p>
            )}
            {(rides ?? []).slice(0, 4).map((r) => (
              <Link className="sh-recent-row" to={`/student/ride/${r.id}`} key={r.id}>
                <span>
                  <b>{r.from?.name} → {r.to?.name}</b>
                  <small>
                    {new Date(r.created_at).toLocaleDateString()} ·{' '}
                    {String(r.status).replaceAll('_', ' ')}
                  </small>
                </span>
                <span className="badge">₦{r.fare}</span>
              </Link>
            ))}
          </div>
          </BottomSheet>
        </div>
      )}

      {tab !== 'Home' && (
        <div className="sh-page" key={tab}>
          <div className="page">
            {tab === 'Rides' && (
              <>
                <h2>My rides</h2>
                {rides === null && (
                  <div className="sh-skel" role="status">
                    <span className="sr-only">Loading your rides…</span>
                    <div className="skeleton skeleton-block" />
                    <div className="skeleton skeleton-block" />
                    <div className="skeleton skeleton-block" />
                  </div>
                )}
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
                        {ticket && <Link className="sh-mini-btn" to={`/student/ticket/${r.id}`}>Ticket</Link>}
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
          </div>
        </div>
      )}

      <nav className="sh-nav" aria-label="Student navigation">
        {TABS.map((item) => (
          <button
            key={item}
            type="button"
            className={tab === item ? 'active' : ''}
            aria-current={tab === item ? 'page' : undefined}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </nav>
    </div>
  )
}
