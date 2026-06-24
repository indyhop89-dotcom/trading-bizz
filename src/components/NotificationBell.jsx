import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { C } from './UI/index'
import { fmtDate } from '../utils/dates'

const TYPE_CONFIG = {
  payment_due:          { icon: '💳', color: '#1a4a6a' },
  overdue_invoice:      { icon: '⚠️', color: '#8a2020' },
  bill_discounting_due: { icon: '🏦', color: '#7a5000' },
  stock_shortfall:      { icon: '📦', color: '#8a2020' },
  system:               { icon: '🔔', color: '#1a1208' },
  intercompany:         { icon: '🔄', color: '#3a1a6a' },
}

export default function NotificationBell() {
  const navigate = useNavigate()
  const [notifs, setNotifs]   = useState([])
  const [open, setOpen]       = useState(false)
  const ref                   = useRef(null)

  useEffect(() => {
    loadNotifs()
    // poll every 60 seconds
    const interval = setInterval(loadNotifs, 60000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  async function loadNotifs() {
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .eq('is_read', false)
      .eq('is_dismissed', false)
      .order('created_at', { ascending: false })
      .limit(10)
    setNotifs(data || [])
  }

  async function markRead(id, e) {
    e.stopPropagation()
    await supabase.from('notifications').update({ is_read: true }).eq('id', id)
    loadNotifs()
  }

  const count = notifs.length

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {/* Bell button */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          position: 'relative', background: 'none', border: 'none',
          cursor: 'pointer', padding: '6px', borderRadius: '8px',
          fontSize: '18px', lineHeight: 1,
          background: open ? 'rgba(245,240,232,0.1)' : 'transparent',
        }}
      >
        🔔
        {count > 0 && (
          <span style={{
            position: 'absolute', top: '2px', right: '2px',
            background: C.danger, color: '#fff',
            fontSize: '10px', fontWeight: 700,
            borderRadius: '50%', width: '16px', height: '16px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            lineHeight: 1,
          }}>
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: '42px',
          width: '340px', background: C.surface,
          border: `1px solid ${C.border}`, borderRadius: '10px',
          boxShadow: '0 8px 32px rgba(26,18,8,0.18)',
          zIndex: 999, overflow: 'hidden',
        }}>
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: '13px' }}>Notifications {count > 0 && <span style={{ color: C.danger }}>({count})</span>}</div>
            <button onClick={() => { setOpen(false); navigate('/notifications') }}
              style={{ background: 'none', border: 'none', fontSize: '12px', color: C.textSoft, cursor: 'pointer', fontFamily: 'inherit' }}>
              View all
            </button>
          </div>

          {notifs.length === 0 ? (
            <div style={{ padding: '24px', textAlign: 'center', fontSize: '13px', color: C.textMuted }}>All caught up 🎉</div>
          ) : (
            notifs.map(n => {
              const cfg = TYPE_CONFIG[n.notification_type] || TYPE_CONFIG.system
              return (
                <div key={n.id} style={{
                  padding: '10px 16px',
                  borderBottom: `1px solid #f0e8d8`,
                  display: 'flex', gap: '10px', alignItems: 'flex-start',
                  cursor: 'default',
                }}>
                  <span style={{ fontSize: '16px', flexShrink: 0, marginTop: '1px' }}>{cfg.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '12px', color: C.text }}>{n.title}</div>
                    <div style={{ fontSize: '11px', color: C.textSoft, marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.message}</div>
                    <div style={{ fontSize: '10px', color: C.textMuted, marginTop: '2px' }}>{fmtDate(n.created_at)}</div>
                  </div>
                  <button onClick={e => markRead(n.id, e)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted, fontSize: '14px', padding: '2px', flexShrink: 0 }}>
                    ✓
                  </button>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
