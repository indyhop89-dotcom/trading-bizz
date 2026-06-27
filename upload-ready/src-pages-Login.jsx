import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

export default function Login() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { error } = await signIn(email, password)
    setLoading(false)
    if (error) setError(error.message)
    else navigate('/')
  }

  return (
    <div style={{
      minHeight: '100vh', background: '#f5f0e8',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Inter', 'Segoe UI', sans-serif",
      padding: '24px',
    }}>
      <div style={{
        background: '#fffdf6', border: '1px solid #e8dfc8',
        borderRadius: '14px', padding: '40px',
        width: '100%', maxWidth: '400px',
        boxShadow: '0 8px 40px rgba(26,18,8,0.1)',
      }}>
        <div style={{ marginBottom: '32px' }}>
          <div style={{ fontSize: '22px', fontWeight: 800, color: '#1a1208', marginBottom: '4px' }}>
            Trading Bizz
          </div>
          <div style={{ fontSize: '13px', color: '#9a8a6a' }}>Vananam Group — Sign in to continue</div>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label style={{ fontSize: '11px', fontWeight: 700, color: '#7a6a4a', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '4px' }}>
              Email
            </label>
            <input
              type='email' value={email} onChange={e => setEmail(e.target.value)}
              required placeholder='you@vananam.in'
              style={{
                width: '100%', padding: '9px 12px', boxSizing: 'border-box',
                border: '1.5px solid #e8dfc8', borderRadius: '6px',
                background: '#fffdf6', fontSize: '14px', color: '#1a1208',
                outline: 'none', fontFamily: 'inherit',
              }}
            />
          </div>
          <div>
            <label style={{ fontSize: '11px', fontWeight: 700, color: '#7a6a4a', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '4px' }}>
              Password
            </label>
            <input
              type='password' value={password} onChange={e => setPassword(e.target.value)}
              required placeholder='••••••••'
              style={{
                width: '100%', padding: '9px 12px', boxSizing: 'border-box',
                border: '1.5px solid #e8dfc8', borderRadius: '6px',
                background: '#fffdf6', fontSize: '14px', color: '#1a1208',
                outline: 'none', fontFamily: 'inherit',
              }}
            />
          </div>

          {error && (
            <div style={{ background: '#f0e8e8', color: '#8a2020', padding: '10px 12px', borderRadius: '6px', fontSize: '13px' }}>
              {error}
            </div>
          )}

          <button
            type='submit' disabled={loading}
            style={{
              background: '#1a1208', color: '#f5f0e8',
              border: 'none', padding: '10px', borderRadius: '6px',
              fontSize: '14px', fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.6 : 1, fontFamily: 'inherit', marginTop: '4px',
            }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
