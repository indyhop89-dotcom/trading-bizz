import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import { C, Card, StatCard, Badge, Btn, Spinner } from '../../components/UI/index'
import { formatINR } from '../../utils/money'
import { fmtDate } from '../../utils/dates'
import { generateNotifications } from '../../utils/notifications'
import { useAuth } from '../../hooks/useAuth'

export default function Dashboard() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [data, setData]     = useState(null)
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
        supabase.from('bill_discounting_events').select('id,status,outstanding_amount').eq('is_deleted', false),
        supabase.from('invoices')
          .select('id,invoice_no,invoice_type,status,total_amount,outstanding_amount,invoice_date,seller:seller_entity_id(name,short_name),buyer:buyer_entity_id(name,short_name)')
          .eq('is_deleted', false).order('invoice_date', { ascending: false }).limit(8),
        supabase.from('orders')
          .select('id,name,status,movement_type,created_at,origin:origin_entity_id(name,short_name),destination:destination_entity_id(name,short_name)')
          .eq('is_deleted', false).order('created_at', { ascending: false }).limit(6),
      ])

      const totalInvoiced      = (invoices || []).reduce((s, i) => s + (i.total_amount || 0), 0)
      const totalOutstanding   = (invoices || []).reduce((s, i) => s + (i.outstanding_amount || 0), 0)
      const totalReceipts      = (payments || []).filter(p => p.payment_type === 'receipt').reduce((s, p) => s + p.net_amount, 0)
      const totalPaymentsOut   = (payments || []).filter(p => p.payment_type === 'payment').reduce((s, p) => s + p.net_amount, 0)
      const openOrders         = (orders || []).filter(o => o.status === 'open' || o.status === 'in_progress').length
      const unpaidExpenses     = (expenses || []).filter(e => e.status === 'unpaid').reduce((s, e) => s + e.total_amount, 0)
      const bdOutstanding      = (bdEvents || []).filter(e => e.status === 'active').reduce((s, e) => s + (e.outstanding_amount || 0), 0)
      const overdueInvoices    = (invoices || []).filter(i => i.outstanding_amount > 0 && i.status !== 'paid' && i.status !== 'cancelled').length

      setData({ totalInvoiced, totalOutstanding, totalReceipts, totalPaymentsOut, openOrders, unpaidExpenses, bdOutstanding, overdueInvoices, recentInvoices: recentInvoices || [], recentOrders: recentOrders || [] })
      setLoading(false)
    }
    load()
    // Generate notifications in background
    if (user?.id) generateNotifications(user.id)
  }, [user])

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px' }}>
      <Spinner size={28} />
    </div>
  )

  return (
    <div>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: '20px', fontWeight: 700, color: C.text, margin: 0 }}>Dashboard</h1>
        <p style={{ fontSize: '13px', color: C.textMuted, margin: '4px 0 0' }}>Vananam Group — Live overview</p>
      </div>

      {/* KPI grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', gap: '12px', marginBottom: '28px' }}>
        <StatCard label='Total Invoiced'     value={formatINR(data.totalInvoiced)} />
        <StatCard label='Outstanding'        value={formatINR(data.totalOutstanding)} color={data.totalOutstanding > 0 ? C.warning : C.success} />
        <StatCard label='Receipts (all-time)' value={formatINR(data.totalReceipts)} color={C.success} />
        <StatCard label='Payments (all-time)' value={formatINR(data.totalPaymentsOut)} color={C.warning} />
        <StatCard label='Open Orders'        value={data.openOrders} />
        <StatCard label='Unpaid Expenses'    value={formatINR(data.unpaidExpenses)} color={data.unpaidExpenses > 0 ? C.warning : C.success} />
        <StatCard label='BD Outstanding'     value={formatINR(data.bdOutstanding)} color={data.bdOutstanding > 0 ? C.danger : C.success} />
        <StatCard label='Invoices Pending'   value={data.overdueInvoices} color={data.overdueInvoices > 0 ? C.warning : C.success} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        {/* Recent Invoices */}
        <Card>
          <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: '14px' }}>Recent Invoices</div>
            <Btn size='sm' variant='ghost' onClick={() => navigate('/invoices')}>View all</Btn>
          </div>
          {data.recentInvoices.length === 0
            ? <div style={{ padding: '32px', textAlign: 'center', color: C.textMuted, fontSize: '13px' }}>No invoices yet</div>
            : data.recentInvoices.map(inv => (
              <div key={inv.id}
                onClick={() => navigate(`/invoices/${inv.id}`)}
                style={{ padding: '11px 18px', borderBottom: `1px solid #f0e8d8`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', transition: 'background 0.1s' }}
                onMouseEnter={e => e.currentTarget.style.background = '#f0e8d8'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'monospace', fontSize: '12px', fontWeight: 600, color: C.text }}>{inv.invoice_no || '—'}</div>
                  <div style={{ fontSize: '11px', color: C.textMuted, marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {inv.seller?.short_name || inv.seller?.name} → {inv.buyer?.short_name || inv.buyer?.name}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: '12px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 600 }}>{formatINR(inv.total_amount)}</div>
                  <Badge status={inv.status} />
                </div>
              </div>
            ))
          }
        </Card>

        {/* Recent Orders */}
        <Card>
          <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: '14px' }}>Recent Orders</div>
            <Btn size='sm' variant='ghost' onClick={() => navigate('/orders')}>View all</Btn>
          </div>
          {data.recentOrders.length === 0
            ? <div style={{ padding: '32px', textAlign: 'center', color: C.textMuted, fontSize: '13px' }}>No orders yet</div>
            : data.recentOrders.map(ord => (
              <div key={ord.id}
                onClick={() => navigate(`/orders/${ord.id}`)}
                style={{ padding: '11px 18px', borderBottom: `1px solid #f0e8d8`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', transition: 'background 0.1s' }}
                onMouseEnter={e => e.currentTarget.style.background = '#f0e8d8'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ord.name}</div>
                  <div style={{ fontSize: '11px', color: C.textMuted, marginTop: '1px' }}>
                    {ord.origin?.short_name || ord.origin?.name || '?'} → {ord.destination?.short_name || ord.destination?.name || '?'}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: '12px', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px' }}>
                  <Badge status={ord.movement_type} />
                  <Badge status={ord.status} />
                </div>
              </div>
            ))
          }
        </Card>
      </div>

      {/* Quick Actions */}
      <div style={{ marginTop: '24px' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px' }}>Quick Actions</div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <Btn variant='ghost' onClick={() => navigate('/orders')}>+ New Order</Btn>
          <Btn variant='ghost' onClick={() => navigate('/pi')}>+ New PI</Btn>
          <Btn variant='ghost' onClick={() => navigate('/invoices/new')}>+ New Invoice</Btn>
          <Btn variant='ghost' onClick={() => navigate('/payments')}>+ Record Payment</Btn>
          <Btn variant='ghost' onClick={() => navigate('/expenses')}>+ Log Expense</Btn>
        </div>
      </div>
    </div>
  )
}
