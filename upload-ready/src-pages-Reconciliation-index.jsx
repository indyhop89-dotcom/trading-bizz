import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Card, PageHeader, EmptyState, StatCard, Toast, Modal, FormRow, Select,
} from '../../components/UI/index'
import { formatINR } from '../../utils/money'
import { fmtDate } from '../../utils/dates'

const TABS = ['Intercompany', 'Invoice Match']

// ─── Intercompany Reconciliation ──────────────────────────────────────────────
// For every internal invoice (associate→associate), both sides should exist.
// We detect: sales invoice exists but no matching purchase invoice for same amount/date.

function IntercompanyTab() {
  const [pairs, setPairs]   = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all') // all | matched | unmatched | variance | waived
  const [toast, setToast] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)

    // Get all sales invoices between associates
    const { data: salesInvoices } = await supabase
      .from('invoices')
      .select('id, invoice_no, invoice_date, total_amount, status, no_purchase_needed, seller:seller_entity_id(id,name,short_name,type), buyer:buyer_entity_id(id,name,short_name,type)')
      .eq('invoice_type', 'sales')
      .eq('is_deleted', false)
      .neq('status', 'cancelled')
      .order('invoice_date', { ascending: false })

    if (!salesInvoices) { setLoading(false); return }

    // Filter to internal only (both seller + buyer are associate/group)
    const internal = salesInvoices.filter(inv =>
      ['associate','group'].includes(inv.seller?.type) &&
      ['associate','group'].includes(inv.buyer?.type)
    )

    // For each, find matching purchase invoice (same buyer, seller, approx amount, same period)
    const results = await Promise.all(internal.map(async (inv) => {
      const { data: purchaseMatch } = await supabase
        .from('invoices')
        .select('id, invoice_no, invoice_date, total_amount, status')
        .eq('invoice_type', 'purchase')
        .eq('buyer_entity_id', inv.buyer.id)
        .eq('seller_entity_id', inv.seller.id)
        .eq('is_deleted', false)
        .gte('invoice_date', inv.invoice_date)
        // within 7 days
        .lte('invoice_date', new Date(new Date(inv.invoice_date).getTime() + 7 * 86400000).toISOString().split('T')[0])
        .limit(1)

      const match = purchaseMatch?.[0] || null
      const variance = match ? Math.abs(inv.total_amount - match.total_amount) : null
      const isMatched = !!match && variance === 0
      const hasVariance = !!match && variance > 0

      return {
        sales_invoice:    inv,
        purchase_invoice: match,
        is_matched:       isMatched,
        has_variance:     hasVariance,
        variance_amount:  variance,
        // A sale can legitimately have no purchase side (goods shipped from
        // existing inventory rather than a fresh purchase) — inv.no_purchase_needed
        // lets that be acknowledged instead of showing as a permanent error.
        status: !match ? (inv.no_purchase_needed ? 'waived' : 'unmatched') : isMatched ? 'matched' : 'variance',
      }
    }))

    setPairs(results)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function toggleNoPurchaseNeeded(invoiceId, next) {
    const { error } = await supabase.from('invoices').update({ no_purchase_needed: next }).eq('id', invoiceId)
    if (error) return setToast({ message: error.message, type: 'error' })
    setPairs(ps => ps.map(p => p.sales_invoice.id === invoiceId
      ? { ...p, sales_invoice: { ...p.sales_invoice, no_purchase_needed: next }, status: next ? 'waived' : 'unmatched' }
      : p))
  }

  const filtered = filter === 'all' ? pairs : pairs.filter(p => p.status === filter)
  const matchedCount   = pairs.filter(p => p.status === 'matched').length
  const unmatchedCount = pairs.filter(p => p.status === 'unmatched').length
  const varianceCount  = pairs.filter(p => p.status === 'variance').length
  const waivedCount    = pairs.filter(p => p.status === 'waived').length

  const statusStyle = {
    matched:   { bg: '#e8f3ec', color: '#1a5c30', label: '✓ Matched' },
    unmatched: { bg: '#f0e8e8', color: '#8a2020', label: '✗ Purchase side missing' },
    variance:  { bg: '#fff3cc', color: '#7a5000', label: '⚠ Amount mismatch' },
    waived:    { bg: '#e8eef3', color: '#2a4a68', label: 'ℹ Inventory source' },
  }

  const th = { padding: '9px 14px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }
  const td = { padding: '10px 14px', borderBottom: `1px solid #f0e8d8`, fontSize: '13px', verticalAlign: 'middle' }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label='Internal Invoices' value={pairs.length} />
        <StatCard label='Matched'   value={matchedCount}   color={C.success} />
        <StatCard label='Unmatched' value={unmatchedCount} color={unmatchedCount > 0 ? C.danger : C.success} />
        <StatCard label='Variance'  value={varianceCount}  color={varianceCount  > 0 ? C.warning : C.success} />
        <StatCard label='Inventory source' value={waivedCount} />
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        {['all','matched','unmatched','variance','waived'].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            style={{ padding: '6px 14px', border: `1.5px solid ${filter === f ? C.accent : C.border}`, borderRadius: '6px', background: filter === f ? C.accent : C.surface, color: filter === f ? '#f5f0e8' : C.textMid, fontSize: '12px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize' }}>
            {f}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <Btn variant='ghost' size='sm' onClick={load}>↻ Refresh</Btn>
      </div>

      <Card>
        {loading ? (
          <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Checking reconciliation…</div>
        ) : filtered.length === 0 ? (
          <EmptyState icon='🔄' title='No internal invoices found' message='Internal invoices between associate entities will appear here.' />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '900px' }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: 'left' }}>Sales Invoice</th>
                  <th style={{ ...th, textAlign: 'left' }}>Seller → Buyer</th>
                  <th style={{ ...th, textAlign: 'left' }}>Date</th>
                  <th style={{ ...th, textAlign: 'right' }}>Sales Amount</th>
                  <th style={{ ...th, textAlign: 'left' }}>Purchase Invoice</th>
                  <th style={{ ...th, textAlign: 'right' }}>Purchase Amount</th>
                  <th style={{ ...th, textAlign: 'right' }}>Variance</th>
                  <th style={{ ...th, textAlign: 'left' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((pair, i) => {
                  const s = statusStyle[pair.status]
                  return (
                    <tr key={pair.sales_invoice.id}
                      style={{ background: pair.status === 'unmatched' ? '#fff5f5' : pair.status === 'variance' ? '#fffdf0' : i % 2 === 0 ? C.surface : '#faf6ed' }}>
                      <td style={{ ...td, fontFamily: 'monospace', fontWeight: 600 }}>{pair.sales_invoice.invoice_no || pair.sales_invoice.id.slice(0,8)}</td>
                      <td style={td}>
                        <span style={{ fontSize: '12px' }}>{pair.sales_invoice.seller?.short_name || pair.sales_invoice.seller?.name}</span>
                        <span style={{ color: C.textMuted, margin: '0 6px' }}>→</span>
                        <span style={{ fontSize: '12px' }}>{pair.sales_invoice.buyer?.short_name || pair.sales_invoice.buyer?.name}</span>
                      </td>
                      <td style={{ ...td, fontSize: '12px' }}>{fmtDate(pair.sales_invoice.invoice_date)}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{formatINR(pair.sales_invoice.total_amount)}</td>
                      <td style={{ ...td, fontFamily: 'monospace', fontSize: '12px', color: pair.purchase_invoice ? C.text : C.danger }}>
                        {pair.purchase_invoice?.invoice_no || pair.purchase_invoice?.id?.slice(0,8) ||
                          (pair.status === 'waived'
                            ? <span style={{ color: C.textMuted }}>— inventory source</span>
                            : <span style={{ color: C.danger }}>— not found</span>)}
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: pair.purchase_invoice ? C.text : C.textMuted }}>
                        {pair.purchase_invoice ? formatINR(pair.purchase_invoice.total_amount) : '—'}
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: pair.variance_amount > 0 ? C.warning : C.success }}>
                        {pair.variance_amount != null ? (pair.variance_amount === 0 ? '—' : formatINR(pair.variance_amount)) : '—'}
                      </td>
                      <td style={td}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '11px', fontWeight: 700, background: s.bg, color: s.color, padding: '3px 8px', borderRadius: '4px', whiteSpace: 'nowrap' }}>
                            {s.label}
                          </span>
                          {(pair.status === 'unmatched' || pair.status === 'waived') && (
                            <button
                              onClick={() => toggleNoPurchaseNeeded(pair.sales_invoice.id, pair.status === 'unmatched')}
                              style={{
                                fontSize: '11px', fontWeight: 600, padding: '3px 8px', borderRadius: '4px',
                                background: 'none', color: C.textMuted, border: `1px solid ${C.border}`,
                                cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
                              }}
                            >
                              {pair.status === 'unmatched' ? 'Mark inventory source' : 'Undo'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Invoice Match (outstanding by entity) ────────────────────────────────────
function InvoiceMatchTab() {
  const [data, setData]         = useState([])
  const [entities, setEntities] = useState([])
  const [entityFilter, setEntityFilter] = useState('')
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    supabase.from('entities').select('id,name,short_name').eq('is_active',true).eq('is_deleted',false).order('name')
      .then(({ data: es }) => setEntities(es || []))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)

    // Get all submitted invoices
    let q = supabase.from('invoices')
      .select('id,invoice_no,invoice_date,due_date,total_amount,paid_amount,outstanding_amount,status,seller:seller_entity_id(id,name,short_name),buyer:buyer_entity_id(id,name,short_name)')
      .eq('is_deleted', false)
      .neq('status', 'cancelled')
      .neq('status', 'paid')
      .gt('outstanding_amount', 0)
      .order('due_date', { ascending: true })

    if (entityFilter) {
      // Filter where entity is seller OR buyer
      q = supabase.from('invoices')
        .select('id,invoice_no,invoice_date,due_date,total_amount,paid_amount,outstanding_amount,status,seller:seller_entity_id(id,name,short_name),buyer:buyer_entity_id(id,name,short_name)')
        .eq('is_deleted', false).neq('status','cancelled').neq('status','paid').gt('outstanding_amount',0)
        .or(`seller_entity_id.eq.${entityFilter},buyer_entity_id.eq.${entityFilter}`)
        .order('due_date', { ascending: true })
    }

    const { data: invoices } = await q
    setData(invoices || [])
    setLoading(false)
  }, [entityFilter])

  useEffect(() => { load() }, [load])

  const totalOutstanding = data.reduce((s, i) => s + (i.outstanding_amount || 0), 0)
  const overdueCount     = data.filter(i => i.due_date && new Date(i.due_date) < new Date()).length

  const th = { padding: '9px 14px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }
  const td = { padding: '10px 14px', borderBottom: `1px solid #f0e8d8`, fontSize: '13px', verticalAlign: 'middle' }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label='Outstanding' value={formatINR(totalOutstanding)} color={totalOutstanding > 0 ? C.warning : C.success} />
        <StatCard label='Overdue'     value={overdueCount} color={overdueCount > 0 ? C.danger : C.success} />
        <StatCard label='Invoices'    value={data.length} />
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', alignItems: 'center' }}>
        <select value={entityFilter} onChange={e => setEntityFilter(e.target.value)}
          style={{ padding: '7px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value=''>All entities</option>
          {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
        </select>
      </div>

      <Card>
        {loading ? (
          <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
        ) : data.length === 0 ? (
          <EmptyState icon='✅' title='No outstanding invoices' message='All invoices are settled.' />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: 'left' }}>Invoice No</th>
                  <th style={{ ...th, textAlign: 'left' }}>Seller</th>
                  <th style={{ ...th, textAlign: 'left' }}>Buyer</th>
                  <th style={{ ...th, textAlign: 'left' }}>Date</th>
                  <th style={{ ...th, textAlign: 'left' }}>Due</th>
                  <th style={{ ...th, textAlign: 'right' }}>Total</th>
                  <th style={{ ...th, textAlign: 'right' }}>Paid</th>
                  <th style={{ ...th, textAlign: 'right' }}>Outstanding</th>
                  <th style={{ ...th, textAlign: 'left' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.map((inv, i) => {
                  const overdue = inv.due_date && new Date(inv.due_date) < new Date()
                  return (
                    <tr key={inv.id} style={{ background: overdue ? '#fff5f5' : i % 2 === 0 ? C.surface : '#faf6ed' }}>
                      <td style={{ ...td, fontFamily: 'monospace', fontWeight: 600 }}>{inv.invoice_no || '—'}</td>
                      <td style={{ ...td, fontSize: '12px' }}>{inv.seller?.short_name || inv.seller?.name}</td>
                      <td style={{ ...td, fontSize: '12px' }}>{inv.buyer?.short_name || inv.buyer?.name}</td>
                      <td style={{ ...td, fontSize: '12px' }}>{fmtDate(inv.invoice_date)}</td>
                      <td style={{ ...td, fontSize: '12px', color: overdue ? C.danger : C.text, fontWeight: overdue ? 700 : 400 }}>
                        {inv.due_date ? fmtDate(inv.due_date) : '—'}
                        {overdue && <span style={{ marginLeft: '4px', fontSize: '11px' }}>⚠</span>}
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>{formatINR(inv.total_amount)}</td>
                      <td style={{ ...td, textAlign: 'right', color: C.success }}>{formatINR(inv.paid_amount)}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: C.danger }}>{formatINR(inv.outstanding_amount)}</td>
                      <td style={td}><Badge status={inv.status} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

// ─── Shell ────────────────────────────────────────────────────────────────────
export default function Reconciliation() {
  const [tab, setTab] = useState('Intercompany')
  return (
    <div>
      <PageHeader
        title='Reconciliation'
        subtitle='Intercompany matching and outstanding invoice tracking'
      />
      <div style={{ display: 'flex', gap: '4px', marginBottom: '24px', borderBottom: `2px solid ${C.border}` }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 20px', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            fontWeight: tab === t ? 700 : 500, fontSize: '13px',
            color: tab === t ? C.text : C.textSoft, background: 'transparent',
            borderBottom: tab === t ? `2px solid ${C.accent}` : '2px solid transparent',
            marginBottom: '-2px', transition: 'all 0.15s',
          }}>{t}</button>
        ))}
      </div>
      {tab === 'Intercompany' && <IntercompanyTab />}
      {tab === 'Invoice Match' && <InvoiceMatchTab />}
    </div>
  )
}
