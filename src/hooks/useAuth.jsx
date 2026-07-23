import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'

const AuthContext = createContext({})

export function AuthProvider({ children }) {
  const [user, setUser]           = useState(null)
  const [profile, setProfile]     = useState(null)
  const [loading, setLoading]     = useState(true)
  const [authError, setAuthError] = useState('')

  // CHANGED: a separate supabase.auth.getSession() call used to run
  // alongside this listener, but onAuthStateChange already fires once
  // synchronously on subscribe with an 'INITIAL_SESSION' event carrying the
  // exact same session getSession() would resolve with — running both
  // fetched the caller's profile row TWICE on every load (two independent
  // network round trips landing at different times, each calling
  // setProfile() with its own freshly-fetched object). Since `profile` is a
  // dependency of data-loading effects all over the app (Stock Position,
  // PI, PO, Invoices, notifications), each of those two arrivals re-ran
  // every one of those effects from scratch — most visibly Stock Position,
  // whose "Planned" calculation pages through the entire proforma_invoice_
  // lines table, so the whole slow load fired twice per page open for no
  // reason. onAuthStateChange alone (below) covers both the initial load
  // and every subsequent sign-in/out/refresh.
  useEffect(() => {
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
