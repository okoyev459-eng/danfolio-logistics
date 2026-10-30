import { Routes, Route, Navigate, useParams, useNavigate } from 'react-router-dom'
import { useAuth } from './lib/auth.jsx'
import ProtectedRoute from './components/ProtectedRoute.jsx'
import Login from './pages/Login.jsx'
import SignUp from './pages/SignUp.jsx'
import ForgotPassword from './pages/ForgotPassword.jsx'
import ResetPassword from './pages/ResetPassword.jsx'
import StudentHome from './pages/student/Home.jsx'
import ChooseType from './pages/student/ChooseType.jsx'
import BookFlow from './pages/student/BookFlow.jsx'
import Ticket from './pages/student/Ticket.jsx'
import Verify from './pages/student/Verify.jsx'
import PayRide from './pages/student/PayRide.jsx'
import Ride from './pages/student/Ride.jsx'
import Review from './pages/student/Review.jsx'
import Report from './pages/student/Report.jsx'
import StationMap from './components/StationMap.jsx'
import KekeHome from './pages/keke/Home.jsx'
import AdminHome from './pages/admin/Home.jsx'
import RegisterKeke from './pages/admin/RegisterKeke.jsx'
import AdminLocations from './pages/admin/Locations.jsx'
import AdminFares from './pages/admin/Fares.jsx'
import AdminKekes from './pages/admin/Kekes.jsx'
import AdminRides from './pages/admin/Rides.jsx'
import AdminReports from './pages/admin/Reports.jsx'

function RoleHome() {
  const { session, role, ready } = useAuth()
  if (!ready) return <p className="center">Loading…</p>
  if (!session) return <Navigate to="/login" replace />
  const to = { student: '/student', keke: '/keke', admin: '/admin' }[role]
  return to ? <Navigate to={to} replace /> : <p className="center">This account has no role yet.</p>
}

function StudentPayRideRoute() {
  const { rideId } = useParams()
  const navigate = useNavigate()

  return (
    <PayRide
      rideId={rideId}
      onBack={() => navigate(-1)}
    />
  )
}

const student = (el) => <ProtectedRoute roles={['student']}>{el}</ProtectedRoute>
const keke = (el) => <ProtectedRoute roles={['keke']}>{el}</ProtectedRoute>
const admin = (el) => <ProtectedRoute roles={['admin']}>{el}</ProtectedRoute>

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RoleHome />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/student" element={student(<StudentHome />)} />
      <Route path="/student/book" element={student(<ChooseType />)} />
      <Route path="/student/book/drop" element={student(<BookFlow mode="drop" />)} />
      <Route path="/student/book/along" element={student(<BookFlow mode="along" />)} />
      <Route path="/student/ride/:rideId" element={student(<Ride />)} />
      <Route path="/student/pay/:rideId" element={student(<StudentPayRideRoute />)} />
      <Route path="/student/ticket/:rideId" element={student(<Ticket />)} />
      <Route path="/student/verify/:rideId" element={student(<Verify />)} />
      <Route path="/student/review/:rideId" element={student(<Review />)} />
      <Route path="/student/report/:rideId" element={student(<Report />)} />
      <Route path="/keke" element={keke(<KekeHome />)} />
      <Route path="/admin" element={admin(<AdminHome />)} />
      <Route path="/admin/register-keke" element={admin(<RegisterKeke />)} />
      <Route path="/admin/locations" element={admin(<AdminLocations />)} />
      <Route path="/admin/fares" element={admin(<AdminFares />)} />
      <Route path="/admin/kekes" element={admin(<AdminKekes />)} />
      <Route path="/admin/rides" element={admin(<AdminRides />)} />
      <Route path="/admin/reports" element={admin(<AdminReports />)} />
      <Route path="/map" element={<ProtectedRoute roles={['student', 'keke', 'admin']}><StationMap /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
