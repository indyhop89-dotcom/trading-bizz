import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { C } from '../UI/index'

const NAV = [
  { path: '/',                   label: 'Dashboard',          icon: '⊞' },
  { divider: 'Operations' },
  { path: '/orders',             label: 'Orders',             icon: '↗' },
  { path: '/stock',              label: 'Stock',              icon: '📦' },
  { path: '/pi',                 label: 'Proforma Invoices',  icon: '📄' },
  { path: '/po',                 label: 'Purchase Orders',    icon: '📋' },
  { path: '/invoices',           label: 'Invoices',           icon: '🧾' },
  { path: '/credit-debit-notes', label: 'Credit/Debit Notes', icon: '📝' },
  { divider: 'Finance' },
  { path: '/payments',           label: 'Payments',           icon: '💳' },
  { path: '/expenses',           label: 'Expenses',           icon: '📊' },
  { path: '/bill-discounting',   label: 'Bill Discounting',   icon: '🏦' },
  { divider: 'Reports' },
  { path: '/reports',            label: 'Reports',            icon: '📈' },
  { path: '/reconciliation',     label: 'Reconciliation',     icon: '🔄' },
  { divider: 'Master Data' },
  { path: '/entities',           label: 'Entities',           icon: '🏢' },
  { path: '/settings',           label: 'Settings',           icon: '⚙️' },
]

export default function Sidebar() {
  const { profile, signOut } = useAuth()
  const navigate = useNavigate()

  async function handleSignOut() {
    await signOut()
    navigate('/login')
  }

  return (
    <div style={{
      width: '220px', minWidth: '220px',
      background: C.text,
      display: 'flex', flexDirection: 'column',
      height: '100vh', position: 'sticky', top: 0,
      overflowY: 'auto',
    }}>
      {/* logo */}
      <div style={{ padding: '20px 16px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ fontSize: '16px', fontWeight: 800, color: '#f5f0e8', letterSpacing: '-0.02em' }}>Trading Bizz</div>
        <div style={{ fontSize: '11px', color: 'rgba(245,240,232,0.4)', marginTop: '2px' }}>Vananam Group</div>
      </div>

      {/* nav */}
      <nav style={{ flex: 1, padding: '8px 0' }}>
        {NAV.map((item, i) => {
          if (item.divider) return (
            <div key={i} style={{ fontSize: '10px', fontWeight: 700, color: 'rgba(245,240,232,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '12px 16px 4px' }}>
              {item.divider}
            </div>
          )
          return (
            <NavLink key={item.path} to={item.path} end={item.path === '/'}
              style={({ isActive }) => ({
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '8px 16px', fontSize: '13px', fontWeight: 500,
                color: isActive ? '#f5f0e8' : 'rgba(245,240,232,0.55)',
                background: isActive ? 'rgba(245,240,232,0.1)' : 'transparent',
                textDecoration: 'none', borderRadius: '6px',
                margin: '1px 8px', transition: 'all 0.15s',
              })}>
              <span style={{ fontSize: '14px', opacity: 0.8 }}>{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          )
        })}
      </nav>

      {/* user footer */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ fontSize: '12px', color: 'rgba(245,240,232,0.5)', marginBottom: '2px' }}>{profile?.role || 'user'}</div>
        <div style={{ fontSize: '13px', fontWeight: 600, color: '#f5f0e8', marginBottom: '8px' }}>{profile?.full_name || profile?.email || 'User'}</div>
        <button onClick={handleSignOut}
          style={{ background: 'rgba(245,240,232,0.08)', border: '1px solid rgba(245,240,232,0.12)', color: 'rgba(245,240,232,0.55)', padding: '5px 12px', borderRadius: '5px', fontSize: '12px', cursor: 'pointer', fontFamily: 'inherit' }}>
          Sign out
        </button>
      </div>
    </div>
  )
}
