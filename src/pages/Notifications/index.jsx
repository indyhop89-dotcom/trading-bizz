import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import { C, Btn, Card, PageHeader, EmptyState, Toast } from '../../components/UI/index'
import { fmtDate } from '../../utils/dates'

const TYPE_CONFIG = {
  payment_due:          { icon: '💳', color: '#1a4a6a', bg: '#e8f0f3', label: 'Payment Due' },
  overdue_invoice:      { icon: '⚠️', color: '#8a2020', bg: '#f0e8e8', label: 'Invoice Overdue' },
  bill_discounting_due: { icon: '🏦', color: '#7a5000', bg: '#fff3cc', label: 'BD Due' },
  stock_shortfall:      { icon: '📦', color: '#8a2020', bg: '#f0e8e8', label: 'Stock Shortfall' },
  system:               { icon: '🔔', color: '#1a1208', bg: '#f0ebe0', label: 'System' },
  intercompany:         { icon: '🔄', color: '#3a1a6a', bg: '#ede8f3', label: 'Intercompany' },
}

function typeConfig(type) {
  return TYPE_CONFIG[type] || TYPE_CONFIG.system
}

export default function Notifications() {
  const navigate   = useNavigate()
  const [notifs, setNotifs]     = useState([])
  const [loading, setLoading]   = useState(true)
  const [filter, setFilter]     = useState('unread')
  const [toast, setToast]       = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    let q = supabase.from('notifications').select('*').order('created_at', { ascending: false })
    if (filter === 'unread') q = q.eq('is_read', false)
    if (filter === 'dismissed') q = q.eq('is_dismissed', true)
    const { data } = await q
    setNotifs(data || [])
    setLoading(false)
  }, [filter])

  useEffect(() => { load() }, [load])

  async function markRead(id) {
    await supabase.from('notifications').update({ is_read: true }).eq('id', id)
    load()
  }

  async function markAllRead() {
    await supabase.from('notifications').update({ is_read: true }).eq('is_read', false)
    setToast({ message: 'All marked as read', type: 'success' })
    load()
  }

  async function dismiss(id) {
    await supabase.from('notifications').update({ is_dismissed: true, is_read: true }).eq('id', id)
    load()
  }

  const unreadCount = notifs.filter(n => !n.is_read).length

  return (
    <div>
      <PageHeader
        title='Notifications'
        subtitle={unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
        action={
          <div style={{ display: 'flex', gap: '8px' }}>
            {unreadCount > 0 && <Btn variant='ghost' size='sm' onClick={markAllRead}>Mark all read</Btn>}
          </div>
        }
      />

      <div style={{ display: 'flex', gap: '4px', marginBottom: '20px', borderBottom: `2px solid ${C.border}` }}>
        {[['unread', 'Unread'], ['all', 'All'], ['dismissed', 'Dismissed']].map(([val, label]) => (
          <button key={val} onClick={() => setFilter(val)} style={{
            padding: '8px 18px', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            fontWeight: filter === val ? 700 : 500, fontSize: '13px',
            color: filter === val ? C.text : C.textSoft, background: 'transparent',
            borderBottom: filter === val ? `2px solid ${C.accent}` : '2px solid transparent',
            marginBottom: '-2px',
          }}>{label}</button>
        ))}
      </div>

      {loading ? (
        <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
      ) : notifs.length === 0 ? (
        <EmptyState icon='🔔' title='No notifications' message={filter === 'unread' ? 'You are all caught up.' : 'Nothing here.'} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {notifs.map(n => {
            const cfg = typeConfig(n.notification_type)
            return (
              <Card key={n.id} style={{ opacity: n.is_dismissed ? 0.5 : 1 }}>
                <div style={{
                  display: 'flex', alignItems: 'flex-start', gap: '14px',
                  padding: '14px 16px',
                  background: !n.is_read ? '#fffdf6' : C.surface,
                  borderLeft: !n.is_read ? `3px solid ${C.accent}` : '3px solid transparent',
                }}>
                  {/* icon */}
                  <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: cfg.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', flexShrink: 0 }}>
                    {cfg.icon}
                  </div>

                  {/* content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
                      <span style={{ fontSize: '11px', fontWeight: 700, background: cfg.bg, color: cfg.color, padding: '1px 6px', borderRadius: '4px' }}>{cfg.label}</span>
                      {!n.is_read && <span style={{ fontSize: '10px', fontWeight: 700, background: C.accent, color: '#f5f0e8', padding: '1px 5px', borderRadius: '3px' }}>NEW</span>}
                    </div>
                    <div style={{ fontWeight: 600, fontSize: '13px', color: C.text }}>{n.title}</div>
                    <div style={{ fontSize: '12px', color: C.textSoft, marginTop: '2px', lineHeight: 1.5 }}>{n.message}</div>
                    {n.due_date && (
                      <div style={{ fontSize: '11px', color: C.textMuted, marginTop: '4px' }}>Due: {fmtDate(n.due_date)}</div>
                    )}
                  </div>

                  {/* actions */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flexShrink: 0 }}>
                    <div style={{ fontSize: '11px', color: C.textMuted, textAlign: 'right', marginBottom: '4px' }}>{fmtDate(n.created_at)}</div>
                    {!n.is_read && <Btn size='sm' variant='ghost' onClick={() => markRead(n.id)}>Mark read</Btn>}
                    {!n.is_dismissed && <Btn size='sm' variant='ghost' onClick={() => dismiss(n.id)} style={{ color: C.textMuted }}>Dismiss</Btn>}
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}
