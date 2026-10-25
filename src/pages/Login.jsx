import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { toLoginEmail } from '../lib/kekeLogin'

export default function Login() {
  const [id, setId] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  async function handleSubmit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({
      email: toLoginEmail(id),
      password,
    })
    setBusy(false)
    if (error) setError(error.message)
    else navigate('/')
  }

  return (
    <div className="page">
      <h1>Danfolio Logistics</h1>
      <p>Sign in. Keke riders use their keke number.</p>
      <form className="card" onSubmit={handleSubmit}>
        <label>Email or keke number</label>
        <input value={id} onChange={(e) => setId(e.target.value)} required />
        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <div className="error">{error}</div>}
        <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="center">New student? <Link to="/signup">Create an account</Link></p>
    </div>
  )
}
