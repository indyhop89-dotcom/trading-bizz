import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'

const AuthContext = createContext({})

export function AuthProvider({ children }) {
  const [user, setUser]           = useState(null)
  const [profile, setProfile]     = useState(null)
  const [loading, setLoading]     = useState(true)
  const [authError, setAuthError] = useState('')

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) fetchProfile(session.user.id)
      else setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) fetchProfile(session.user.id)
      else { setProfile(null); setLoading(false) }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function fetchProfile(userId) {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()

    if (data && data.is_active === false) {
      await supabase.auth.signOut()
      setProfile(null)
      setUser(null)
      setAuthError('Your account has been deactivated. Contact your administrator.')
      setLoading(false)
      return
    }

    setProfile(data)
    setLoading(false)
  }

  async function signIn(email, password) {
    setAuthError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error }
  }

  async function signInWithGoogle() {
    setAuthError('')
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
    return { error }
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  // CHANGED: re-fetches the caller's own profile row. `profile` is held once
  // in this shared context, so calling this after a self-service edit (e.g.
  // changing full_name) updates every consumer — Sidebar, Settings, etc. —
  // immediately, no page reload needed.
  async function refreshProfile() {
    if (user) await fetchProfile(user.id)
  }

  return (
    <AuthContext.Provider value={{ user, profile, loading, authError, signIn, signInWithGoogle, signOut, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
