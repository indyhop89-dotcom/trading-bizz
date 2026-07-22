import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import Sidebar, { NAV } from './Sidebar'
import NotificationBell from '../NotificationBell'

// ─── Route → breadcrumb label map ────────────────────────────────────────────
const ROUTE_LABELS = {
  '/':                   'Dashboard',
  '/orders':             'Orders',
  '/stock':              'Stock',
  '/pi':                 'Proforma Invoices',
  '/po':                 'Purchase Orders',
  '/invoices':           'Invoices',
  '/invoices/new':       'New Invoice',
  '/credit-debit-notes': 'Credit / Debit Notes',
  '/payments':           'Payments',
  '/expenses':           'Expenses',
  '/bill-discounting':   'Bill Discounting',
  '/reports':            'Reports',
  '/reconciliation':     'Reconciliation',
  '/documents':          'Document Database',
  '/entities':           'Entities',
  '/settings':           'Settings',
  '/notifications':      'Notifications',
}

function getBreadcrumb(pathname) {
  // Exact match first
  if (ROUTE_LABELS[pathname]) return ROUTE_LABELS[pathname]
  // Partial match for sub-routes (e.g. /invoices/abc-123)
  const base = '/' + pathname.split('/')[1]
  if (ROUTE_LABELS[base]) return ROUTE_LABELS[base]
  return null
}

// ─── Command palette ──────────────────────────────────────────────────────────
function CommandPalette({ open, onClose }) {
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef(null)
  const navigate = useNavigate()

  // Flatten NAV into searchable items
  const allItems = NAV.filter(n => n.path).map(n => ({
    label: n.label,
    path:  n.path,
    section: n.section || '',
  }))

  const filtered = query.trim()
    ? allItems.filter(i => i.label.toLowerCase().includes(query.toLowerCase()))
    : allItems

  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIdx(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  useEffect(() => { setActiveIdx(0) }, [query])

  const handleKey = useCallback((e) => {
    if (!open) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, filtered.length - 1)) }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)) }
    if (e.key === 'Enter' && filtered[activeIdx]) {
      navigate(filtered[activeIdx].path)
      onClose()
    }
    if (e.key === 'Escape') onClose()
  }, [open, filtered, activeIdx, navigate, onClose])

  useEffect(() => {
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [handleKey])

  if (!open) return null

  return (
    <div className='cmd-overlay' onClick={e => e.target === e.currentTarget && onClose()}>
      <div className='cmd-palette'>
        {/* Search input */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '0 14px', borderBottom: '1px solid var(--border)' }}>
          <svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='var(--text-muted)' strokeWidth='2.5'>
            <circle cx='11' cy='11' r='8'/><path d='m21 21-4.35-4.35'/>
          </svg>
          <input
            ref={inputRef}
            className='cmd-input'
            style={{ border: 'none', padding: '13px 0' }}
            placeholder='Search modules… (↑↓ to navigate, Enter to open)'
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <kbd style={{ background: 'var(--bg)', border: '1px solid var(--border-dark)', borderRadius: '3px', padding: '2px 6px', fontSize: '10px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Esc</kbd>
        </div>

        {/* Results */}
        <div className='cmd-results'>
          {filtered.length === 0 && (
            <div className='cmd-empty'>No modules match "{query}"</div>
          )}
          {filtered.map((item, i) => (
            <div
              key={item.path}
              className={`cmd-result${i === activeIdx ? ' active' : ''}`}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => { navigate(item.path); onClose() }}
            >
              <div className='cmd-result-icon'>
                {item.label.charAt(0)}
              </div>
              <span className='cmd-result-label'>{item.label}</span>
              <span className='cmd-result-section'>{item.section}</span>
            </div>
          ))}
        </div>

        {/* Footer hints */}
        <div className='cmd-footer'>
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}

// ─── Layout ───────────────────────────────────────────────────────────────────
export default function Layout({ children }) {
  const location = useLocation()
  const navigate = useNavigate()

  // Sidebar collapsed state — persisted in localStorage
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('tb_sidebar_collapsed') === 'true' }
    catch { return false }
  })

  // Command palette
  const [cmdOpen, setCmdOpen] = useState(false)

  function toggleSidebar() {
    setCollapsed(c => {
      const next = !c
      try { localStorage.setItem('tb_sidebar_collapsed', String(next)) } catch { /* storage unavailable — sidebar just won't remember its state */ }
      return next
    })
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    function handleKey(e) {
      // Ctrl+B — toggle sidebar
      if (e.ctrlKey && e.key === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
      // Ctrl+K — open command palette
      if (e.ctrlKey && e.key === 'k') {
        e.preventDefault()
        setCmdOpen(c => !c)
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [])

  const breadcrumb = getBreadcrumb(location.pathname)
  const isHome = location.pathname === '/'

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)' }}>
      {/* Sidebar */}
      <Sidebar collapsed={collapsed} onToggle={toggleSidebar} />

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

        {/* ── Top bar ── */}
        <div style={{
          height: '48px',
          background: 'var(--surface-raised)',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 20px',
          flexShrink: 0,
          gap: '12px',
          boxShadow: '0 1px 0 var(--border)',
        }}>
          {/* Left — breadcrumb */}
          <div className='breadcrumb'>
            {!isHome && (
              <>
                <span
                  className='breadcrumb-item'
                  onClick={() => navigate('/')}
                >
                  Home
                </span>
                <span className='breadcrumb-sep'>›</span>
              </>
            )}
            <span className='breadcrumb-current'>
              {breadcrumb || 'Trading Bizz'}
            </span>
          </div>

          {/* Right — search trigger + bell */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {/* Command palette trigger */}
            <button
              onClick={() => setCmdOpen(true)}
              title='Search modules (Ctrl+K)'
              style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                background: 'var(--bg)',
                border: '1px solid var(--border-dark)',
                borderRadius: 'var(--radius)',
                padding: '5px 10px',
                color: 'var(--text-muted)',
                fontSize: '12px', fontFamily: 'var(--font-sans)',
                cursor: 'pointer',
                transition: 'border-color var(--transition), box-shadow var(--transition)',
                minWidth: '160px',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-focus)'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(36,144,239,0.10)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-dark)'; e.currentTarget.style.boxShadow = 'none' }}
            >
              <svg width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5'>
                <circle cx='11' cy='11' r='8'/><path d='m21 21-4.35-4.35'/>
              </svg>
              <span style={{ flex: 1, textAlign: 'left' }}>Search…</span>
              <span style={{
                background: 'var(--border)',
                border: '1px solid var(--border-dark)',
                borderRadius: '3px',
                padding: '1px 4px',
                fontSize: '10px', fontWeight: 600,
                color: 'var(--text-muted)',
              }}>⌃K</span>
            </button>

            <NotificationBell />
          </div>
        </div>

        {/* ── Page content ── */}
        <main style={{
          flex: 1, overflowY: 'auto', overflowX: 'hidden',
          padding: '24px 28px',
          fontFamily: 'var(--font-sans)',
        }}>
          {children}
        </main>
      </div>

      {/* Command palette overlay */}
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />
    </div>
  )
}
