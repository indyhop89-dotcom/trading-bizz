import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import { C, RAW, Card, CardHeader, StatCard, Badge, Btn, Spinner } from '../../components/UI/index'
import { formatINR } from '../../utils/money'
import { fmtDate } from '../../utils/dates'
import { generateNotifications } from '../../utils/notifications'
import { useAuth } from '../../hooks/useAuth'

// ─── Workspace module definitions ────────────────────────────────────────────
const WORKSPACE = [
  {
    section: 'Operations',
    color: RAW.accent,
    modules: [
      { label: 'Orders',             path: '/orders',             desc: 'Track trade orders and legs',          icon: '↗' },
      { label: 'Stock',              path: '/stock',              desc: 'Stock position and opening balances',  icon: '📦' },
      { label: 'Proforma Invoices',  path: '/pi',                 desc: 'Issue and manage PIs',                icon: '📄' },
      { label: 'Purchase Orders',    path: '/po',                 desc: 'Create and track POs',                icon: '📋' },
      { label: 'Invoices',           path: '/invoices',           desc: 'Sales and purchase invoices',         icon: '🧾' },
      { label: 'Credit/Debit Notes', path: '/credit-debit-notes', desc: 'Adjustments and corrections',         icon: '📝' },
    ],
  },
  {
    section: 'Finance',
    color: RAW.success,
    modules: [
      { label: 'Payments',        path: '/payments',         desc: 'Invoice and expense payment tracker', icon: '💳' },
      { label: 'Expenses',        path: '/expenses',         desc: 'Log and track business expenses',     icon: '📊' },
      { label: 'Bill Discounting',path: '/bill-discounting', desc: 'BD events and repayments',            icon: '🏦' },
    ],
  },
  {
    section: 'Reports',
    color: RAW.warning,
    modules: [
      { label: 'Reports',           path: '/reports',        desc: 'P&L, GST summary, ledger',            icon: '📈' },
      { label: 'Reconciliation',    path: '/reconciliation', desc: 'Intercompany and invoice matching',    icon: '🔄' },
      { label: 'Document Database', path: '/documents',      desc: 'All leg documents in one place',      icon: '📁' },
    ],
  },
  {
    section: 'Master Data',
    color: '#6b5c3e',
    modules: [
      { label: 'Entities',  path: '/entities', desc: 'Groups, associates, and externals', icon: '🏢' },
      { label: 'Settings',  path: '/settings', desc: 'FYs, HSN master, users',            icon: '⚙️' },
    ],
  },
]

// ─── Module card ──────────────────────────────────────────────────────────────
function ModuleCard({ label, desc, icon, path, color, onClick }) {
  const [hov, setHov] = useState(false)
  return (
    <div
      className='workspace-card animate-fade-up'
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        borderColor: hov ? color : undefined,
        boxShadow: hov ? `0 0 0 3px ${color}18, var(--shadow-sm)` : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div
          className='workspace-card-icon'
          style={{ background: `${color}14`, color }}
        >
          <span style={{ fontSize: '16px' }}>{icon}</span>
        </div>
        <div className='workspace-card-title' style={{ color: hov ? color : undefined }}>
          {label}
        </div>
      </div>
      <div className='workspace-card-desc'>{desc}</div>
    </div>
  )
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const [
        { data: invoices },
        { data: payments },
        { data: orders },
        { data: expenses },
        { data: bdEvents },
        { data: recentInvoices },
        { data: recentOrders },
      ] = await Promise.all([
        supabase.from('invoices').select('id,status,total_amount,outstanding_amount,invoice_type').eq('is_deleted', false),
        supabase.from('payments').select('id,payment_type,net_amount,payment_date').eq('is_deleted', false),
        supabase.from('orders').select('id,status').eq('is_deleted', false),
        supabase.from('expenses').select('id,status,total_amount').eq('is_deleted', false),
        supabase.from('bill_discounting').select('id,status,outstanding_amount').eq('is_deleted', false),
        supabase.from('invoices')
          .select('id,invoice_no,invoice_type,status,total_amount,outstanding_amount,invoice_date,seller:seller_entity_id(name,short_name),buyer:buyer_entity_id(name,short_name)')
          .eq('is_deleted', false).order('invoice_date', { ascending: false }).limit(8),
        supabase.from('orders')
          .select('id,name,status,movement_type,created_at,origin:origin_entity_id(name,short_name),destination:destination_entity_id(name,short_name)')
          .eq('is_deleted', false).order('created_at', { ascending: false }).limit(6),
      ])

      const totalInvoiced    = (invoices || []).reduce((s, i) => s + (i.total_amount || 0), 0)
      const totalOutstanding = (invoices || []).reduce((s, i) => s + (i.outstanding_amount || 0), 0)
      const totalReceipts    = (payments || []).filter(p => p.payment_type === 'receipt').reduce((s, p) => s + p.net_amount, 0)
      const totalPaymentsOut = (payments || []).filter(p => p.payment_type === 'payment').reduce((s, p) => s + p.net_amount, 0)
      const openOrders       = (orders || []).filter(o => o.status === 'open' || o.status === 'in_progress').length
      const unpaidExpenses   = (expenses || []).filter(e => e.status === 'unpaid').reduce((s, e) => s + e.total_amount, 0)
      const bdOutstanding    = (bdEvents || []).filter(e => e.status === 'active').reduce((s, e) => s + (e.outstanding_amount || 0), 0)
      const overdueInvoices  = (invoices || []).filter(i => i.outstanding_amount > 0 && i.status !== 'paid' && i.status !== 'cancelled').length

      setData({ totalInvoiced, totalOutstanding, totalReceipts, totalPaymentsOut, openOrders, unpaidExpenses, bdOutstanding, overdueInvoices, recentInvoices: recentInvoices || [], recentOrders: recentOrders || [] })
      setLoading(false)
    }
    load()
    if (user?.id) generateNotifications(user.id)
  }, [user])

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '240px', gap: '12px', color: 'var(--text-muted)', fontSize: '13px' }}>
      <Spinner size={24} />
      <span>Loading dashboard…</span>
    </div>
  )

  return (
    <div style={{ maxWidth: '1200px' }}>

      {/* ── Page header ── */}
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text)', margin: 0, lineHeight: 1.3 }}>
          Dashboard
        </h1>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '3px 0 0' }}>
          Vananam Group — Live overview
        </p>
      </div>

      {/* ── KPI strip ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px,1fr))', gap: '10px', marginBottom: '28px' }}>
        <StatCard
          label='Total Invoiced'
          value={formatINR(data.totalInvoiced)}
          onClick={() => navigate('/invoices')}
        />
        <StatCard
          label='Outstanding'
          value={formatINR(data.totalOutstanding)}
          color={data.totalOutstanding > 0 ? RAW.warning : RAW.success}
          onClick={() => navigate('/invoices')}
        />
        <StatCard
          label='Receipts'
          value={formatINR(data.totalReceipts)}
          color={RAW.success}
          onClick={() => navigate('/payments')}
        />
        <StatCard
          label='Payments Out'
          value={formatINR(data.totalPaymentsOut)}
          color={RAW.warning}
          onClick={() => navigate('/payments')}
        />
        <StatCard
          label='Open Orders'
          value={data.openOrders}
          onClick={() => navigate('/orders')}
        />
        <StatCard
          label='Unpaid Expenses'
          value={formatINR(data.unpaidExpenses)}
          color={data.unpaidExpenses > 0 ? RAW.warning : RAW.success}
          onClick={() => navigate('/expenses')}
        />
        <StatCard
          label='BD Outstanding'
          value={formatINR(data.bdOutstanding)}
          color={data.bdOutstanding > 0 ? RAW.danger : RAW.success}
          onClick={() => navigate('/bill-discounting')}
        />
        <StatCard
          label='Invoices Pending'
          value={data.overdueInvoices}
          color={data.overdueInvoices > 0 ? RAW.warning : RAW.success}
          onClick={() => navigate('/invoices')}
        />
      </div>

      {/* ── Workspace sections ── */}
      <div style={{ marginBottom: '28px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '14px' }}>
          Modules
        </div>
        {WORKSPACE.map(section => (
          <div key={section.section} style={{ marginBottom: '20px' }}>
            <div style={{
              fontSize: '11px', fontWeight: 700,
              color: section.color,
              textTransform: 'uppercase', letterSpacing: '0.08em',
              marginBottom: '8px',
              display: 'flex', alignItems: 'center', gap: '8px',
            }}>
              <div style={{ width: 16, height: 2, background: section.color, borderRadius: '1px', opacity: 0.6 }} />
              {section.section}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '8px' }}>
              {section.modules.map(mod => (
                <ModuleCard
                  key={mod.path}
                  {...mod}
                  color={section.color}
                  onClick={() => navigate(mod.path)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* ── Recent activity ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
        {/* Recent Invoices */}
        <Card>
          <CardHeader
            title='Recent Invoices'
            action={<Btn size='xs' variant='ghost' onClick={() => navigate('/invoices')}>View all</Btn>}
          />
          {data.recentInvoices.length === 0
            ? <div style={{ padding: '28px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>No invoices yet</div>
            : data.recentInvoices.map(inv => (
              <div
                key={inv.id}
                onClick={() => navigate(`/invoices/${inv.id}`)}
                style={{ padding: '9px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', transition: 'background var(--transition-fast)' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-light)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', fontWeight: 600 }}>{inv.invoice_no || '—'}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {inv.seller?.short_name || inv.seller?.name} → {inv.buyer?.short_name || inv.buyer?.name}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: '10px', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatINR(inv.total_amount)}</div>
                  <Badge status={inv.status} />
                </div>
              </div>
            ))
          }
        </Card>

        {/* Recent Orders */}
        <Card>
          <CardHeader
            title='Recent Orders'
            action={<Btn size='xs' variant='ghost' onClick={() => navigate('/orders')}>View all</Btn>}
          />
          {data.recentOrders.length === 0
            ? <div style={{ padding: '28px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>No orders yet</div>
            : data.recentOrders.map(ord => (
              <div
                key={ord.id}
                onClick={() => navigate(`/orders/${ord.id}`)}
                style={{ padding: '9px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', transition: 'background var(--transition-fast)' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-light)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ord.name}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px' }}>
                    {ord.origin?.short_name || ord.origin?.name || '?'} → {ord.destination?.short_name || ord.destination?.name || '?'}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: '10px', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px' }}>
                  <Badge status={ord.movement_type} />
                  <Badge status={ord.status} />
                </div>
              </div>
            ))
          }
        </Card>
      </div>

      {/* ── Quick Actions ── */}
      <div>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '10px' }}>
          Quick Actions
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <Btn variant='primary' size='sm' onClick={() => navigate('/orders')}>+ New Order</Btn>
          <Btn variant='ghost'   size='sm' onClick={() => navigate('/pi')}>+ New PI</Btn>
          <Btn variant='ghost'   size='sm' onClick={() => navigate('/invoices/new')}>+ New Invoice</Btn>
          <Btn variant='ghost'   size='sm' onClick={() => navigate('/payments')}>+ Record Payment</Btn>
          <Btn variant='ghost'   size='sm' onClick={() => navigate('/expenses')}>+ Log Expense</Btn>
          <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--text-muted)', display: 'flex', gap: '12px', alignItems: 'center' }}>
            <span>
              <kbd style={{ background: 'var(--bg)', border: '1px solid var(--border-dark)', borderRadius: '3px', padding: '1px 5px', fontSize: '10px', fontFamily: 'var(--font-sans)', color: 'var(--text-muted)' }}>⌃K</kbd>
              {' '}Search modules
            </span>
            <span>
              <kbd style={{ background: 'var(--bg)', border: '1px solid var(--border-dark)', borderRadius: '3px', padding: '1px 5px', fontSize: '10px', fontFamily: 'var(--font-sans)', color: 'var(--text-muted)' }}>⌃B</kbd>
              {' '}Toggle sidebar
            </span>
          </span>
        </div>
      </div>

    </div>
  )
}
