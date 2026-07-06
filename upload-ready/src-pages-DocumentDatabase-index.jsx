import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom' // CHANGED: read ?order= for deep-linking from Orders
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, Toast, EmptyState,
  PageHeader, Card, FormRow, Input, Select,
} from '../../components/UI/index'
import DocumentChecklist from '../../components/DocumentChecklist'
import { fmtDate } from '../../utils/dates'
import { getDriveViewUrl, getDriveDownloadUrl, fileIcon } from '../../utils/drive'

// ── helpers ──────────────────────────────────────────────────────────────────

function taxLabel(isInterstate) {
  if (isInterstate === true)  return { label: 'Interstate',  color: '#1a4a6a', bg: '#e8f0f3' }
  if (isInterstate === false) return { label: 'Local',       color: '#1a5c30', bg: '#e6f4ec' }
  return                             { label: 'TBD',         color: '#888',    bg: '#f2f2f2' }
}

function DocStatusBadge({ uploaded, total }) {
  const allDone = uploaded === total
  return (
    <span style={{
      fontSize: '11px', fontWeight: 700,
      background: allDone ? '#e6f4ec' : uploaded > 0 ? '#fef6e4' : '#f2f2f2',
      color:      allDone ? '#1a6b35' : uploaded > 0 ? '#7a4f00' : '#888',
      padding: '2px 8px', borderRadius: '4px', whiteSpace: 'nowrap',
    }}>
      {uploaded}/{total} docs
    </span>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DocumentDatabase() {
  const [searchParams] = useSearchParams()
  const deepLinkOrderId = searchParams.get('order') // CHANGED: set when arriving from Orders' "Open in Document Database"
  const [orders, setOrders]           = useState([])
  const [entities, setEntities]       = useState([])
  const [loading, setLoading]         = useState(true)
  const [search, setSearch]           = useState('')
  const [entityFilter, setEntityFilter] = useState('all')
  const [taxFilter, setTaxFilter]     = useState('all')
  const [expandedLeg, setExpandedLeg] = useState(null)   // leg.id with checklist open
  // CHANGED: orders now collapse to a summary row by default (previously
  // every leg of every order rendered at all times — the "bloated" table).
  // expandedOrders tracks which order IDs are showing their legs.
  const [expandedOrders, setExpandedOrders] = useState(new Set())
  const [toast, setToast]             = useState(null)

  // Per-leg doc counts
  const [legDocCounts, setLegDocCounts] = useState({})  // legId → { uploaded, total }

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: os }, { data: es }] = await Promise.all([
      supabase.from('orders')
        .select(`
          id, order_no, name, movement_type, status, created_at,
          origin:origin_entity_id(id,name,short_name),
          destination:destination_entity_id(id,name,short_name),
          financial_years(name),
          order_legs(
            id, leg_no, leg_type, is_interstate, movement_status, cargo_status,
            dispatch_date, delivery_date,
            from_entity:from_entity_id(id,name,short_name,state_code),
            to_entity:to_entity_id(id,name,short_name,state_code)
          )
        `)
        .eq('is_deleted', false)
        .order('created_at', { ascending: false }),
      supabase.from('entities').select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name'),
    ])

    const allOrders = os || []
    setOrders(allOrders)
    setEntities(es || [])

    // Load doc counts per leg from leg_document_checklist
    const legIds = allOrders.flatMap(o => (o.order_legs || []).map(l => l.id))
    if (legIds.length > 0) {
      const { data: cl } = await supabase
        .from('leg_document_checklist')
        .select('leg_id, status')
        .in('leg_id', legIds)
      const counts = {}
      for (const legId of legIds) {
        const rows = (cl || []).filter(r => r.leg_id === legId)
        counts[legId] = {
          uploaded: rows.filter(r => r.status === 'uploaded').length,
          total:    rows.length,
        }
      }
      setLegDocCounts(counts)
    }

    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // CHANGED: auto-expand whichever order we arrived here for (from Orders'
  // new "Open in Document Database" link), so the person lands directly on
  // the right leg instead of an empty collapsed list.
  useEffect(() => {
    if (deepLinkOrderId && orders.length) {
      setExpandedOrders(new Set([deepLinkOrderId]))
    }
  }, [deepLinkOrderId, orders])

  function toggleOrder(orderId) {
    setExpandedOrders(s => { const next = new Set(s); next.has(orderId) ? next.delete(orderId) : next.add(orderId); return next })
  }

  // ── Filtering ──────────────────────────────────────────────────────────────

  const filtered = orders.filter(o => {
    if (search) {
      const q = search.toLowerCase()
      const match = (o.order_no || '').toLowerCase().includes(q)
        || (o.name || '').toLowerCase().includes(q)
      if (!match) return false
    }
    if (entityFilter !== 'all') {
      const legEntities = (o.order_legs || []).flatMap(l => [l.from_entity?.id, l.to_entity?.id])
      if (!legEntities.includes(entityFilter)) return false
    }
    // CHANGED: taxFilter existed as state but was never actually applied —
    // this is the "filter is not working" bug. An order matches if any of
    // its legs has the selected tax type.
    if (taxFilter !== 'all') {
      const legs = o.order_legs || []
      const want = taxFilter === 'interstate'
      const hasMatch = legs.some(l => l.is_interstate === want)
      if (!hasMatch) return false
    }
    return true
  })

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div>
      <PageHeader
        title='Document Database'
        subtitle='All shipments and their document status — upload, view, and track'
      />

      {/* ── Filters ── */}
      <div style={{
        display: 'flex', gap: '10px', flexWrap: 'wrap',
        marginBottom: '20px', alignItems: 'center',
      }}>
        <Input
          placeholder='Search order ID or name…'
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: '240px' }}
        />
        <Select
          value={entityFilter}
          onChange={e => setEntityFilter(e.target.value)}
          style={{ width: '180px' }}
        >
          <option value='all'>All Entities</option>
          {entities.map(e => (
            <option key={e.id} value={e.id}>{e.short_name || e.name}</option>
          ))}
        </Select>
        {/* CHANGED: this control never existed even though taxFilter state
            did — that mismatch is exactly what made "the filter" seem broken. */}
        <Select
          value={taxFilter}
          onChange={e => setTaxFilter(e.target.value)}
          style={{ width: '150px' }}
        >
          <option value='all'>All Tax Types</option>
          <option value='local'>Local (CGST+SGST)</option>
          <option value='interstate'>Interstate (IGST)</option>
        </Select>
        {(search || entityFilter !== 'all' || taxFilter !== 'all') && (
          <Btn size='sm' variant='ghost' onClick={() => { setSearch(''); setEntityFilter('all'); setTaxFilter('all') }}>Clear</Btn>
        )}
        <div style={{
          marginLeft: 'auto', fontSize: '12px', color: C.textMuted,
          background: '#f5f0e8', padding: '4px 12px', borderRadius: '6px',
        }}>
          {filtered.length} order{filtered.length !== 1 ? 's' : ''}
          {' · '}
          {filtered.reduce((n, o) => n + (o.order_legs?.length || 0), 0)} legs
        </div>
      </div>

      {/* ── Table header row ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '140px 1fr 180px 120px 90px 90px',
        gap: '0',
        padding: '8px 16px',
        background: '#ede8df',
        borderRadius: '6px 6px 0 0',
        border: `1px solid ${C.border}`,
        borderBottom: 'none',
        fontSize: '11px', fontWeight: 700, color: C.textMuted,
        textTransform: 'uppercase', letterSpacing: '0.04em',
      }}>
        <div>Order ID</div>
        <div>Leg</div>
        <div>Bill From → Bill To</div>
        <div>Tax Type</div>
        <div>Documents</div>
        <div>Status</div>
      </div>

      {/* ── Content ── */}
      {loading ? (
        <div style={{
          padding: '48px', textAlign: 'center', color: C.textMuted,
          border: `1px solid ${C.border}`, borderRadius: '0 0 6px 6px',
          background: C.surface,
        }}>
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div style={{
          padding: '48px', textAlign: 'center', color: C.textMuted,
          border: `1px solid ${C.border}`, borderRadius: '0 0 6px 6px',
          background: C.surface,
        }}>
          No orders found.
        </div>
      ) : (
        <div style={{
          border: `1px solid ${C.border}`,
          borderRadius: '0 0 6px 6px',
          background: C.surface,
          overflow: 'hidden',
        }}>
          {filtered.map((order, oi) => {
            const legs = order.order_legs || []
            const isLast = oi === filtered.length - 1
            // CHANGED: orders collapse by default — this is the main fix for
            // "the table is very bloated". Only the order summary shows
            // until you click it; legs render underneath only when expanded.
            const isOrderOpen = expandedOrders.has(order.id)
            const orderCounts = legs.reduce((acc, l) => {
              const c = legDocCounts[l.id] || { uploaded: 0, total: 0 }
              return { uploaded: acc.uploaded + c.uploaded, total: acc.total + c.total }
            }, { uploaded: 0, total: 0 })

            return (
              <div
                key={order.id}
                style={{
                  borderBottom: isLast ? 'none' : `2px solid #e0d8cc`,
                }}
              >
                {/* ── Order header row (click to expand/collapse) ── */}
                <div
                  onClick={() => toggleOrder(order.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '12px',
                    padding: '10px 16px',
                    background: '#f8f4ee',
                    borderBottom: isOrderOpen ? `1px solid ${C.border}` : 'none',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ fontSize: '11px', color: C.textMuted, width: '10px' }}>{isOrderOpen ? '▼' : '▶'}</span>
                  <span style={{
                    fontWeight: 800, fontSize: '13px', color: C.accent,
                    fontFamily: 'monospace', letterSpacing: '0.02em',
                  }}>
                    {order.order_no || '—'}
                  </span>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: C.text }}>
                    {order.name}
                  </span>
                  <Badge status={order.movement_type} label={order.movement_type} />
                  <Badge status={order.status} />
                  <span style={{ fontSize: '11px', color: C.textMuted }}>{legs.length} leg{legs.length !== 1 ? 's' : ''}</span>
                  {!isOrderOpen && <DocStatusBadge uploaded={orderCounts.uploaded} total={orderCounts.total} />}
                  <span style={{ fontSize: '11px', color: C.textMuted, marginLeft: 'auto' }}>
                    {order.financial_years?.name}
                    {' · '}
                    {order.origin?.short_name || order.origin?.name || '—'}
                    {' → '}
                    {order.destination?.short_name || order.destination?.name || '—'}
                  </span>
                </div>

                {/* ── Leg rows (only when order is expanded) ── */}
                {isOrderOpen && (legs.length === 0 ? (
                  <div style={{ padding: '12px 16px', fontSize: '12px', color: C.textMuted }}>
                    No legs for this order.
                  </div>
                ) : (
                  legs
                    .sort((a, b) => a.leg_no - b.leg_no)
                    .map((leg, li) => {
                      const tax = taxLabel(leg.is_interstate)
                      const counts = legDocCounts[leg.id] || { uploaded: 0, total: 0 }
                      const isOpen = expandedLeg === leg.id

                      return (
                        <div key={leg.id}>
                          {/* ── Leg summary row ── */}
                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns: '140px 1fr 180px 120px 90px 90px',
                              gap: '0',
                              padding: '10px 16px',
                              borderBottom: `1px solid #f0e8d8`,
                              background: isOpen ? '#f5f0e8' : li % 2 === 0 ? C.surface : '#faf6f0',
                              cursor: 'pointer',
                              transition: 'background 0.1s',
                            }}
                            onClick={() => setExpandedLeg(isOpen ? null : leg.id)}
                          >
                            {/* Order ID col — blank for leg rows, shows leg badge */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <div style={{
                                width: '22px', height: '22px', borderRadius: '50%',
                                background: C.accent, color: '#f5f0e8',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: '11px', fontWeight: 700, flexShrink: 0,
                              }}>
                                {leg.leg_no}
                              </div>
                              <span style={{ fontSize: '11px', color: C.textMuted }}>
                                {leg.leg_type || order.movement_type}
                              </span>
                            </div>

                            {/* Leg entities */}
                            <div style={{ fontSize: '13px', fontWeight: 600, color: C.text, display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span>{leg.from_entity?.short_name || leg.from_entity?.name || '—'}</span>
                              <span style={{ color: C.textMuted, fontSize: '11px' }}>→</span>
                              <span>{leg.to_entity?.short_name || leg.to_entity?.name || '—'}</span>
                              {leg.from_entity?.state_code && leg.to_entity?.state_code && (
                                <span style={{ fontSize: '10px', color: C.textMuted, fontWeight: 400 }}>
                                  ({leg.from_entity.state_code} → {leg.to_entity.state_code})
                                </span>
                              )}
                            </div>

                            {/* Bill From → Bill To */}
                            <div style={{ fontSize: '11px', color: C.textMuted, display: 'flex', alignItems: 'center' }}>
                              {leg.from_entity?.name || '—'} → {leg.to_entity?.name || '—'}
                            </div>

                            {/* Tax type */}
                            <div style={{ display: 'flex', alignItems: 'center' }}>
                              <span style={{
                                fontSize: '11px', fontWeight: 700,
                                background: tax.bg, color: tax.color,
                                padding: '2px 8px', borderRadius: '4px',
                                whiteSpace: 'nowrap',
                              }}>
                                {tax.label}
                              </span>
                            </div>

                            {/* Doc count */}
                            <div style={{ display: 'flex', alignItems: 'center' }}>
                              <DocStatusBadge uploaded={counts.uploaded} total={counts.total || (leg.leg_type === 'export' || order.movement_type === 'export' ? 8 : 6)} />
                            </div>

                            {/* Expand indicator */}
                            <div style={{
                              fontSize: '12px', color: C.textMuted,
                              display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
                              gap: '4px',
                            }}>
                              <Badge status={leg.cargo_status?.replace(/_/g, ' ')} label={leg.cargo_status?.replace(/_/g, ' ')} />
                              <span style={{ marginLeft: '4px' }}>{isOpen ? '▲' : '▼'}</span>
                            </div>
                          </div>

                          {/* ── Expanded checklist ── */}
                          {isOpen && (
                            <div style={{
                              padding: '16px 16px 16px 52px',
                              background: '#f8f4ee',
                              borderBottom: li < legs.length - 1 ? `1px solid #f0e8d8` : 'none',
                            }}>
                              {/* Leg meta: dispatch / delivery / e-way dates */}
                              <div style={{
                                display: 'flex', gap: '24px', flexWrap: 'wrap',
                                fontSize: '12px', color: C.textSoft,
                                marginBottom: '12px', paddingBottom: '10px',
                                borderBottom: `1px solid ${C.border}`,
                              }}>
                                {leg.dispatch_date && (
                                  <span><strong>Dispatched:</strong> {fmtDate(leg.dispatch_date)}</span>
                                )}
                                {leg.delivery_date && (
                                  <span><strong>Delivered:</strong> {fmtDate(leg.delivery_date)}</span>
                                )}
                                <span>
                                  <strong>Movement:</strong>{' '}
                                  <Badge status={leg.movement_status} label={leg.movement_status} />
                                </span>
                              </div>

                              {/* Document checklist */}
                              <DocumentChecklist
                                legId={leg.id}
                                entityName={leg.from_entity?.name || 'General'}
                                movementType={leg.leg_type === 'export' || order.movement_type === 'export' ? 'export' : 'domestic'}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })
                ))}
              </div>
            )
          })}
        </div>
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}
