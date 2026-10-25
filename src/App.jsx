import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './lib/auth.jsx'
import ProtectedRoute from './components/ProtectedRoute.jsx'
import Login from './pages/Login.jsx'
import StudentHome from './pages/student/Home.jsx'
import KekeHome from './pages/keke/Home.jsx'
import AdminHome from './pages/admin/Home.jsx'
import RegisterKeke from './pages/admin/RegisterKeke.jsx'

function RoleHome() {
  const { session, role, ready } = useAuth()
  if (!ready) return <p className="center">Loading…</p>
  if (!session) return <Navigate to="/login" replace />
  const to = { student: '/student', keke: '/keke', admin: '/admin' }[role]
  return to ? <Navigate to={to} replace /> : <p className="center">This account has no role yet.</p>
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RoleHome />} />
      <Route path="/login" element={<Login />} />
      <Route path="/student" element={<ProtectedRoute roles={['student']}><StudentHome /></ProtectedRoute>} />
      <Route path="/keke" element={<ProtectedRoute roles={['keke']}><KekeHome /></ProtectedRoute>} />
      <Route path="/admin" element={<ProtectedRoute roles={['admin']}><AdminHome /></ProtectedRoute>} />
      <Route path="/admin/register-keke" element={<ProtectedRoute roles={['admin']}><RegisterKeke /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
