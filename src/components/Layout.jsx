import { useAuth } from '../lib/auth.jsx'

export default function Layout({ title, children }) {
  const { signOut } = useAuth()
  return (
    <>
      <div className="topbar">
        <b>Danfolio Logistics · {title}</b>
        <button onClick={signOut}>Sign out</button>
      </div>
      <div className="page">{children}</div>
    </>
  )
}
