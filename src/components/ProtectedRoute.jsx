import { Navigate } from 'react-router-dom'
import { useAuth } from '../lib/auth.jsx'

export default function ProtectedRoute({ roles, children }) {
  const { session, role, ready } = useAuth()
  if (!ready) return <p className="center">Loading…</p>
  if (!session) return <Navigate to="/login" replace />
  if (!roles.includes(role)) return <Navigate to="/" replace />
  return children
}
