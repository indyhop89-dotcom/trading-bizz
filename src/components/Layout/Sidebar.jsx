import { useState } from 'react'
import { createPortal } from 'react-dom'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'

// ─── Nav definition ───────────────────────────────────────────────────────────
export const NAV = [
  { path: '/',                   label: 'Dashboard',          icon: HomeIcon,    section: 'Home' },
  { divider: 'Operations' },
  { path: '/orders',             label: 'Orders',             icon: ArrowUpRightIcon, section: 'Operations' },
  { path: '/stock',              label: 'Stock',              icon: BoxIcon,     section: 'Operations' },
  { path: '/pi',                 label: 'Proforma Invoices',  icon: FileTextIcon,section: 'Operations' },
  { path: '/po',                 label: 'Purchase Orders',    icon: ClipboardIcon,section:'Operations' },
  { path: '/invoices',           label: 'Invoices',           icon: ReceiptIcon, section: 'Operations' },
  { path: '/credit-debit-notes', label: 'Credit/Debit Notes', icon: EditIcon,    section: 'Operations' },
  { divider: 'Finance' },
  { path: '/payments',           label: 'Payments',           icon: CreditCardIcon, section: 'Finance' },
  { path: '/expenses',           label: 'Expenses',           icon: TrendingDownIcon, section: 'Finance' },
  { path: '/bill-discounting',   label: 'Bill Discounting',   icon: BankIcon,    section: 'Finance' },
  { divider: 'Reports' },
  { path: '/reports',            label: 'Reports',            icon: BarChartIcon,section: 'Reports' },
  { path: '/reconciliation',     label: 'Reconciliation',     icon: RefreshIcon, section: 'Reports' },
  { path: '/documents',          label: 'Document Database',  icon: FolderIcon,  section: 'Reports' },
  { divider: 'Master Data' },
  { path: '/entities',           label: 'Entities',           icon: BuildingIcon,section: 'Master Data' },
  { path: '/settings',           label: 'Settings',           icon: SettingsIcon,section: 'Master Data' },
]

// ─── Inline SVG icons (Lucide-style, 16×16) ───────────────────────────────────
function Icon({ d, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
      {Array.isArray(d) ? d.map((path, i) => <path key={i} d={path} />) : <path d={d} />}
    </svg>
  )
}
function HomeIcon()         { return <Icon d='M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10' /> }
function ArrowUpRightIcon() { return <Icon d='M7 17L17 7 M7 7h10v10' /> }
function BoxIcon()          { return <Icon d={['M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z','M3.27 6.96L12 12.01l8.73-5.05','M12 22.08V12']} /> }
function FileTextIcon()     { return <Icon d={['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z','M14 2v6h6','M16 13H8','M16 17H8','M10 9H8']} /> }
function ClipboardIcon()    { return <Icon d={['M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2','M15 2H9a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1z']} /> }
function ReceiptIcon()      { return <Icon d='M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1zm3 5h10M7 10h10M7 15h6' /> }
function EditIcon()         { return <Icon d={['M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7','M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z']} /> }
function CreditCardIcon()   { return <Icon d={['M1 4h22v16H1z','M1 10h22']} /> }
function TrendingDownIcon() { return <Icon d='M23 18l-9.5-9.5-5 5L1 6 M17 18h6v-6' /> }
function BankIcon()         { return <Icon d={['M3 22h18','M6 18v-7','M10 18v-7','M14 18v-7','M18 18v-7','M12 2L2 7h20z']} /> }
function BarChartIcon()     { return <Icon d={['M18 20V10','M12 20V4','M6 20v-6']} /> }
function RefreshIcon()      { return <Icon d='M1 4v6h6 M23 20v-6h-6 M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15' /> }
function FolderIcon()       { return <Icon d='M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' /> }
function BuildingIcon()     { return <Icon d={['M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z','M9 22V12h6v10']} /> }
function SettingsIcon()     { return <Icon d='M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' /> }
function ChevronLeftIcon()  { return <Icon d='M15 18l-6-6 6-6' /> }
function ChevronRightIcon() { return <Icon d='M9 18l6-6-6-6' /> }
function LogOutIcon()       { return <Icon d='M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9' /> }

// ─── Sidebar ──────────────────────────────────────────────────────────────────
export default function Sidebar({ collapsed, onToggle }) {
  const { profile, signOut } = useAuth()
  const navigate = useNavigate()
  const [hoverTip, setHoverTip] = useState(null)

  async function handleSignOut() {
    await signOut()
    navigate('/login')
  }

  const W = collapsed ? 56 : 220

  return (
    <div style={{
      width: W, minWidth: W,
      background: '#1a1208',
      display: 'flex', flexDirection: 'column',
      height: '100vh', position: 'sticky', top: 0,
      overflowY: 'auto', overflowX: 'hidden',
      transition: 'width 0.2s ease, min-width 0.2s ease',
      flexShrink: 0,
    }}>
      {/* ── Logo + collapse toggle ── */}
      <div style={{
        padding: collapsed ? '16px 0' : '16px 14px',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        display: 'flex', alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'space-between',
        minHeight: 56,
      }}>
        {!collapsed && (
          <div>
            <div style={{ fontSize: '14px', fontWeight: 800, color: '#f5f0e8', letterSpacing: '-0.02em', lineHeight: 1.2 }}>Trading Bizz</div>
            <div style={{ fontSize: '10px', color: 'rgba(245,240,232,0.38)', marginTop: '1px' }}>Vananam Group</div>
          </div>
        )}
        <button
          onClick={onToggle}
          title={collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'}
          style={{
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '5px',
            color: 'rgba(245,240,232,0.5)',
            cursor: 'pointer',
            width: 26, height: 26,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 0.15s, color 0.15s',
            flexShrink: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; e.currentTarget.style.color = '#f5f0e8' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = 'rgba(245,240,232,0.5)' }}
        >
          {collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
        </button>
      </div>

      {/* ── Nav ── */}
      <nav style={{ flex: 1, padding: '6px 0', overflowY: 'auto', overflowX: 'hidden' }}>
        {NAV.map((item, i) => {
          if (item.divider) {
            if (collapsed) return (
              <div key={i} style={{ margin: '6px 12px', height: '1px', background: 'rgba(255,255,255,0.07)' }} />
            )
            return (
              <div key={i} style={{
                fontSize: '9px', fontWeight: 700,
                color: 'rgba(245,240,232,0.28)',
                textTransform: 'uppercase', letterSpacing: '0.1em',
                padding: '10px 14px 3px',
              }}>
                {item.divider}
              </div>
            )
          }

          const IconComp = item.icon

          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === '/'}
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: collapsed ? 0 : '9px',
                justifyContent: collapsed ? 'center' : 'flex-start',
                padding: collapsed ? '9px 0' : '7px 12px',
                fontSize: '13px', fontWeight: 500,
                color: isActive ? '#f5f0e8' : 'rgba(245,240,232,0.52)',
                background: isActive ? 'rgba(36,144,239,0.18)' : 'transparent',
                textDecoration: 'none',
                borderRadius: '5px',
                margin: collapsed ? '1px 6px' : '1px 6px',
                transition: 'all 0.12s',
                position: 'relative',
                // left accent bar for active
                borderLeft: isActive && !collapsed ? '2px solid #2490ef' : '2px solid transparent',
              })}
              className='sidebar-nav-item'
              onMouseEnter={collapsed ? (e => {
                const r = e.currentTarget.getBoundingClientRect()
                setHoverTip({ label: item.label, top: r.top + r.height / 2, left: r.right + 10 })
              }) : undefined}
              onMouseLeave={collapsed ? (() => setHoverTip(null)) : undefined}
            >
              {({ isActive }) => (
                <>
                  <span style={{
                    color: isActive ? '#2490ef' : 'rgba(245,240,232,0.5)',
                    display: 'flex', alignItems: 'center',
                    flexShrink: 0,
                  }}>
                    <IconComp />
                  </span>
                  {!collapsed && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>}
                </>
              )}
            </NavLink>
          )
        })}
      </nav>

      {/* ── User footer ── */}
      <div style={{
        padding: collapsed ? '10px 6px' : '10px 12px',
        borderTop: '1px solid rgba(255,255,255,0.07)',
      }}>
        {!collapsed && (
          <div style={{ marginBottom: '8px' }}>
            <div style={{ fontSize: '10px', color: 'rgba(245,240,232,0.38)', marginBottom: '1px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{profile?.role || 'user'}</div>
            <div style={{ fontSize: '12px', fontWeight: 600, color: '#f5f0e8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profile?.full_name || profile?.email || 'User'}</div>
          </div>
        )}
        <div style={{ display: 'flex', gap: '6px', flexDirection: collapsed ? 'column' : 'row' }}>
          {/* CHANGED: "Change Password" removed — Google SSO is now the
              sole sign-in path shown in this app's UI (see Login.jsx), so a
              self-service password-setting feature that could never
              actually be used to log in was just confusing dead weight.
              Supabase's own Email/Password provider is untouched server-side. */}
          <button
            onClick={handleSignOut}
            title='Sign out'
            style={{
              background: 'rgba(245,240,232,0.06)',
              border: '1px solid rgba(245,240,232,0.1)',
              color: 'rgba(245,240,232,0.45)',
              padding: collapsed ? '6px' : '5px 10px',
              borderRadius: '5px', fontSize: '12px',
              cursor: 'pointer', fontFamily: 'var(--font-sans)',
              display: 'flex', alignItems: 'center', gap: '6px',
              width: collapsed ? '100%' : 'auto',
              justifyContent: 'center',
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; e.currentTarget.style.color = '#f5f0e8' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = 'rgba(245,240,232,0.45)' }}
          >
            <LogOutIcon />
            {!collapsed && <span>Sign out</span>}
          </button>
        </div>
      </div>

      {hoverTip && createPortal(
        <div style={{
          position: 'fixed',
          top: hoverTip.top, left: hoverTip.left,
          transform: 'translateY(-50%)',
          background: '#1a1208',
          color: '#f5f0e8',
          fontSize: '12px', fontWeight: 600,
          padding: '4px 8px',
          borderRadius: '5px',
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          zIndex: 1000,
          boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        }}>
          {hoverTip.label}
        </div>,
        document.body
      )}
    </div>
  )
}
