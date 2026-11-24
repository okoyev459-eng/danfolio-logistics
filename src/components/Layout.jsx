import { useAuth } from '../lib/auth.jsx'
import InstallAppButton from './InstallAppButton.jsx'

export default function Layout({ title, children }) {
  const { signOut } = useAuth()
  return (
    <>
      <div className="topbar">
        <b>Danfolio Logistics · {title}</b>
        <div className="topbar-actions">
          <InstallAppButton className="topbar-install" />
          <button onClick={signOut}>Sign out</button>
        </div>
      </div>
      <div className="page app-fade">{children}</div>
    </>
  )
}
