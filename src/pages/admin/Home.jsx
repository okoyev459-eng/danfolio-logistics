import { Link } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'

export default function AdminHome() {
  return (
    <Layout title="Admin">
      <h2>Admin</h2>
      <div className="card">
        <Link className="btn" to="/admin/register-keke">Register a keke</Link>
      </div>
    </Layout>
  )
}
