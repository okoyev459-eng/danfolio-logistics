import { NavLink } from 'react-router-dom'
import { useAuth } from '../lib/auth.jsx'
import '../pages/admin/admin.css'

// AdminLayout — the mockup's desktop shell: fixed 220px navy sidebar with
// the section nav, content area on the right. Collapses to a horizontal
// scrollable top bar on narrow screens so the admin site still works on a
// phone.
const nav = [
  { to: '/admin', label: 'Overview', end: true },
  { to: '/admin/kekes', label: 'Kekes' },
  { to: '/admin/locations', label: 'Locations and fares' },
  { to: '/admin/reports', label: 'Reports and tickets' },
  { to: '/admin/rides', label: 'Rides' },
  { to: '/admin/students', label: 'Students' },
  { to: '/admin/fares', label: 'Fares' },
  { to: '/admin/register-keke', label: 'Register a keke' },
]

export default function AdminLayout({ title, children }) {
  const { signOut } = useAuth()

  return (
    <div className="adm">
      <aside className="adm-side">
        <div className="adm-brand">Danfolio Logistics</div>
        <nav className="adm-nav" aria-label="Admin navigation">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? 'active' : '')}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="adm-foot">
          <span>Admin</span>
          <button type="button" onClick={signOut}>Sign out</button>
        </div>
      </aside>

      <main className="adm-main">
        {title && <h1 className="adm-title">{title}</h1>}
        {children}
      </main>
    </div>
  )
}
