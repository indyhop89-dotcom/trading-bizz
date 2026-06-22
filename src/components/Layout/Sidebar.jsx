import { useNavigate, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, Building2, Package, Truck, FileText,
  ShoppingCart, Receipt, CreditCard, TrendingUp, BarChart3,
  Settings, ChevronRight, Layers, DollarSign, Wallet
} from 'lucide-react'

const NAV = [
  { section: 'Overview' },
  { path: '/',           label: 'Dashboard',          icon: LayoutDashboard },
  { path: '/orders',     label: 'Orders',             icon: Layers },
  { section: 'Setup' },
  { path: '/entities',   label: 'Entities',           icon: Building2 },
  { path: '/stock',      label: 'Stock',              icon: Package },
  { section: 'Operations' },
  { path: '/pi',         label: 'Proforma Invoices',  icon: FileText },
  { path: '/po',         label: 'Purchase Orders',    icon: ShoppingCart },
  { path: '/invoices',   label: 'Invoices',           icon: Receipt },
  { path: '/payments',   label: 'Payments',           icon: CreditCard },
  { path: '/expenses',   label: 'Expenses',           icon: Wallet },
  { section: 'Finance' },
  { path: '/discounting',label: 'Bill Discounting',   icon: DollarSign },
  { section: 'Reports' },
  { path: '/reports',    label: 'Reports',            icon: BarChart3 },
  { section: 'Settings' },
  { path: '/settings',   label: 'Settings',           icon: Settings },
]

export function Sidebar({ user, onSignOut }) {
  const navigate = useNavigate()
  const location = useLocation()

  function isActive(path) {
    if (path === '/') return location.pathname === '/'
    return location.pathname.startsWith(path)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className="sidebar-logo-name">Trading Bizz</div>
        <div className="sidebar-logo-sub">
          {user?.full_name || user?.email || 'Loading…'}
        </div>
      </div>

      <nav className="sidebar-nav">
        {NAV.map((item, i) => {
          if (item.section) {
            return <div key={i} className="nav-section">{item.section}</div>
          }
          const Icon = item.icon
          return (
            <button
              key={item.path}
              className={`nav-item ${isActive(item.path) ? 'active' : ''}`}
              onClick={() => navigate(item.path)}
            >
              <Icon size={15} />
              {item.label}
            </button>
          )
        })}
      </nav>

      <div style={{ marginTop: 'auto', padding: '12px 8px', borderTop: '1px solid var(--border)' }}>
        <button
          className="nav-item"
          onClick={onSignOut}
          style={{ color: 'var(--red)', fontSize: 12 }}
        >
          Sign out
        </button>
      </div>
    </aside>
  )
}
