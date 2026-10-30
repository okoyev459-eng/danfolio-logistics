import { Link } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'

export default function ChooseType() {
  return (
    <Layout title="Student">
      <Link to="/student">← Back</Link>
      <h2 style={{ marginTop: 12 }}>How do you want to ride?</h2>
      <p className="muted">Pick the ride type that fits your trip.</p>

      <Link to="/student/book/drop" className="plain">
        <div className="opt" style={{ marginTop: 14, alignItems: 'flex-start' }}>
          <span>
            <span style={{ display: 'block', fontSize: 18, fontWeight: 700 }}>Drop</span>
            <span className="muted" style={{ display: 'block', fontWeight: 400 }}>
              Door-to-door pickup
            </span>
          </span>
          <span aria-hidden="true" style={{ fontWeight: 700 }}>›</span>
        </div>
      </Link>

      <Link to="/student/book/along" className="plain">
        <div className="opt" style={{ marginTop: 12, alignItems: 'flex-start' }}>
          <span>
            <span style={{ display: 'block', fontSize: 18, fontWeight: 700 }}>Along</span>
            <span className="muted" style={{ display: 'block', fontWeight: 400 }}>
              Join at a ride station
            </span>
          </span>
          <span aria-hidden="true" style={{ fontWeight: 700 }}>›</span>
        </div>
      </Link>
    </Layout>
  )
}
