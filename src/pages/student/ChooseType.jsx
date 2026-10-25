import { Link } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'

export default function ChooseType() {
  return (
    <Layout title="Student">
      <Link to="/student">← Back</Link>
      <h2 style={{ marginTop: 12 }}>How do you want to ride?</h2>
      <Link to="/student/book/drop" style={{ textDecoration: 'none', color: 'inherit' }}>
        <div className="card">
          <b style={{ fontSize: 20 }}>Drop</b>
          <div className="muted">Door-to-door pickup</div>
        </div>
      </Link>
      <Link to="/student/book/along" style={{ textDecoration: 'none', color: 'inherit' }}>
        <div className="card">
          <b style={{ fontSize: 20 }}>Along</b>
          <div className="muted">Join at a ride station</div>
        </div>
      </Link>
    </Layout>
  )
}
