import { Sidebar } from './Sidebar'

export function Layout({ user, onSignOut, children }) {
  return (
    <div className="app-shell">
      <Sidebar user={user} onSignOut={onSignOut} />
      <main className="main-content">
        {children}
      </main>
    </div>
  )
}
