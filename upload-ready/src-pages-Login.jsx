import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

export default function Login() {
  const { signIn, signInWithGoogle, authError } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail]                 = useState('')
  const [password, setPassword]           = useState('')
  const [error, setError]                 = useState('')
  const [loading, setLoading]             = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [showPassword, setShowPassword]   = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { error } = await signIn(email, password)
    setLoading(false)
    if (error) setError(error.message)
    else navigate('/')
  }

  async function handleGoogle() {
    setError('')
    setGoogleLoading(true)
    const { error } = await signInWithGoogle()
    if (error) {
      setError(error.message)
      setGoogleLoading(false)
    }
  }

  const shownError = error || authError

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

        <button
          type='button'
          onClick={handleGoogle}
          disabled={googleLoading}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
            background: '#fff', color: '#1a1208', border: '1.5px solid #e8dfc8',
            padding: '10px', borderRadius: '6px', fontSize: '14px', fontWeight: 600,
            cursor: googleLoading ? 'not-allowed' : 'pointer', opacity: googleLoading ? 0.6 : 1,
            fontFamily: 'inherit', marginBottom: '20px',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.9 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l6-6C34.5 5.6 29.5 3.5 24 3.5 12.7 3.5 3.5 12.7 3.5 24S12.7 44.5 24 44.5 44.5 35.3 44.5 24c0-1.2-.1-2.4-.3-3.5z"/>
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.9 19 13 24 13c3.1 0 5.8 1.1 8 3l6-6C34.5 6.6 29.5 4.5 24 4.5 16 4.5 9 9 6.3 14.7z"/>
            <path fill="#4CAF50" d="M24 44.5c5.4 0 10.3-2 14-5.3l-6.5-5.4C29.5 35.6 26.9 36.5 24 36.5c-5.3 0-9.7-3.1-11.3-7.5l-6.6 5.1C9 39.6 16 44.5 24 44.5z"/>
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-1 2.7-2.8 5-5.2 6.5l6.5 5.4C40 36.9 44.5 31.1 44.5 24c0-1.2-.1-2.4-.9-3.5z"/>
          </svg>
          {googleLoading ? 'Redirecting…' : 'Continue with Google'}
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
          <div style={{ flex: 1, height: '1px', background: '#e8dfc8' }} />
          <span style={{ fontSize: '11px', color: '#9a8a6a', textTransform: 'uppercase', letterSpacing: '0.05em' }}>or</span>
          <div style={{ flex: 1, height: '1px', background: '#e8dfc8' }} />
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
            <div style={{ position: 'relative' }}>
              <input
                type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                required placeholder='••••••••'
                style={{
                  width: '100%', padding: '9px 40px 9px 12px', boxSizing: 'border-box',
                  border: '1.5px solid #e8dfc8', borderRadius: '6px',
                  background: '#fffdf6', fontSize: '14px', color: '#1a1208',
                  outline: 'none', fontFamily: 'inherit',
                }}
              />
              <button
                type='button' onClick={() => setShowPassword(s => !s)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                title={showPassword ? 'Hide password' : 'Show password'}
                style={{
                  position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', cursor: 'pointer', padding: '4px',
                  color: '#9a8a6a', fontSize: '13px', lineHeight: 1,
                }}
              >
                {showPassword ? '🙈' : '👁️'}
              </button>
            </div>
          </div>

          {shownError && (
            <div style={{ background: '#f0e8e8', color: '#8a2020', padding: '10px 12px', borderRadius: '6px', fontSize: '13px' }}>
              {shownError}
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
