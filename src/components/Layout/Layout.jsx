import Sidebar from './Sidebar'
import NotificationBell from '../NotificationBell'
import { C } from '../UI/index'

export default function Layout({ children }) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f5f0e8' }}>
      <Sidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Top bar */}
        <div style={{
          height: '48px', background: C.surface,
          borderBottom: `1px solid ${C.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          padding: '0 24px', flexShrink: 0,
        }}>
          <NotificationBell />
        </div>
        {/* Content */}
        <main style={{
          flex: 1, overflowY: 'auto', overflowX: 'hidden',
          padding: '28px 32px',
          fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
        }}>
          {children}
        </main>
      </div>
    </div>
  )
}
