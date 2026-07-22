import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, FormRow, Input, Select, Textarea, StatCard,
} from '../../components/UI/index'
import DocumentChecklist from '../../components/DocumentChecklist'
import { fmtDate, today, currentFYLabel, fyCodeForDate } from '../../utils/dates'
import { formatINR, formatQty, toNum, round2 } from '../../utils/money'
import { suggestNextNo } from '../../utils/numbering'
import { useAuth } from '../../hooks/useAuth' // CHANGED: needed for master/admin-only delete, matches PI/PO/Invoices pattern
import { hasFullAccess } from '../../utils/roles'
import { useEntityAccess } from '../../hooks/useEntityAccess'
import { getInvoiceLifecycleStage, fetchActualStockPosition } from '../../utils/stock'
import { ORDER_STATUSES, deriveOrderStatus, getOrderProgress } from '../../utils/orders'
import { getDriveViewUrl } from '../../utils/drive'
import { fetchAllPages, isAutoPurchaseMirror } from '../../utils/query'
import { printDocument } from '../../utils/documentTemplate'
import { downloadDocumentExcel } from '../../utils/documentExcel'
// CHANGED: import from the shared utils module (not '../PI/index' etc.) —
// see utils/documentBuilders.js's header comment for why: a static import
// of the full page component would defeat route-level code-splitting.
import { buildPIDoc, buildPODoc, buildInvoiceDoc } from '../../utils/documentBuilders'

// Per-leg "Generate Docs" convenience action — the leg view here only holds
// summary columns (piMap/poMap/invMap), so each click fetches that one
// document's full header + line items on demand (build*Doc() itself fetches
// the full entity rows it needs), then reuses the exact same
// printDocument/downloadDocumentExcel calls each document's own detail page uses.
async function fetchAndBuildLegDoc(docType, docId) {
  if (docType === 'PI') {
    const [{ data: pi }, { data: lines }] = await Promise.all([
      supabase.from('proforma_invoices').select('*').eq('id', docId).single(),
      fetchAllPages(() => supabase.from('proforma_invoice_lines').select('*').eq('pi_id', docId).order('line_no')),
    ])
    return buildPIDoc(pi, lines || [])
  }
  if (docType === 'PO') {
    const [{ data: po }, { data: lines }] = await Promise.all([
      supabase.from('purchase_orders').select('*').eq('id', docId).single(),
      fetchAllPages(() => supabase.from('purchase_order_lines').select('*').eq('po_id', docId).order('line_no')),
    ])
    return buildPODoc(po, lines || [])
  }
  const [{ data: inv }, { data: lines }] = await Promise.all([
    supabase.from('invoices').select('*').eq('id', docId).single(),
    fetchAllPages(() => supabase.from('invoice_lines').select('*').eq('invoice_id', docId).order('line_no')),
  ])
  return buildInvoiceDoc(inv, lines || [])
}

const MOVEMENT_TYPES    = ['domestic', 'export', 'blended']
// ORDER_STATUSES (now including 'planned') comes from utils/orders.js — the
// same module that auto-derives status from leg activity.
const CARGO_STATUSES    = ['awaiting_cargo','cargo_dispatched','cargo_received','ready_for_pi','ready_for_invoice','completed']
const MOVEMENT_STATUSES = ['pending','in_transit','delivered']

const EMPTY_ORDER = { name:'', movement_type:'domestic', status:'open', origin_entity_id:'', destination_entity_id:'', notes:'' }
const EMPTY_LEG   = { from_entity_id:'', to_entity_id:'', movement_status:'pending', cargo_status:'awaiting_cargo', dispatch_date:'', delivery_date:'', notes:'' }

// Resolve current FY — next_order_no takes ONLY fy_id (no ent_id)
async function resolveFY() {
  const label = currentFYLabel()
  const { data } = await supabase.from('financial_years').select('id,name,code,start_date').order('start_date',{ascending:false}).limit(5)
  return (data||[]).find(f=>f.name===label) || data?.[0]
}

function LegPipeline({ pi, inv }) {
  // CHANGED: third stage reflects actual stock movement (E-way-Bill-gated),
  // distinct from the Invoice stage's payment status above it — an invoice
  // can be fully paid while stock still sits with the seller if no E-way
  // Bill has been generated yet, or vice versa.
  const stockStage = inv ? getInvoiceLifecycleStage(inv) : null
  const stages = [
    { label:'Proforma Invoice', no:pi?.pi_no||null, status:pi?.status||null, amount:pi?.total_amount||0, stage:!pi?'pending':pi.status==='converted'?'done':'active' },
    { label:'Invoice', no:inv?.invoice_no||null, status:inv?.status||null, amount:inv?.total_amount||0, stage:!inv?'pending':inv.status==='paid'?'done':'active' },
    { label:'Stock', no:stockStage?.label||null, status:stockStage?.key||null, amount:0, stage:!inv?'pending':stockStage.key==='completed'?'done':stockStage.key==='overdue'||stockStage.key==='cancelled'?'active':'active' },
  ]
  const COL = { done:{bg:'#edf7f1',text:'#1a7a40',border:'#b8dfca'}, active:{bg:'#e8f3fd',text:'#2490ef',border:'#b8d8f8'}, pending:{bg:'#f5f0e8',text:'#9a8a6a',border:'#e8dfc8'} }
  return (
    <div style={{display:'flex',gap:0,margin:'10px 0 6px'}}>
      {stages.map((s,i)=>{
        const c=COL[s.stage]
        return (
          <div key={i} style={{display:'flex',alignItems:'stretch',flex:1}}>
            <div style={{flex:1,padding:'8px 12px',background:c.bg,border:`1px solid ${c.border}`,borderLeft:i>0?'none':undefined,borderRadius:i===0?'6px 0 0 6px':i===stages.length-1?'0 6px 6px 0':'0'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                <div>
                  <div style={{fontSize:'10px',fontWeight:700,color:c.text,textTransform:'uppercase',letterSpacing:'0.06em'}}>{s.label}</div>
                  <div style={{fontSize:'12px',fontWeight:600,color:C.text,marginTop:'2px',fontFamily:'monospace'}}>{s.no||(s.stage==='pending'?'—':'Draft')}</div>
                </div>
                <div style={{textAlign:'right',display:'flex',flexDirection:'column',alignItems:'flex-end',gap:'3px'}}>
                  {s.status?<Badge status={s.status}/>:<span style={{fontSize:'11px',color:C.textMuted}}>Not started</span>}
                  {s.amount>0&&<div style={{fontSize:'11px',color:C.textMuted}}>{formatINR(s.amount)}</div>}
                </div>
              </div>
            </div>
            {i<stages.length-1&&<div style={{width:0,height:0,alignSelf:'center',borderTop:'14px solid transparent',borderBottom:'14px solid transparent',borderLeft:`10px solid ${c.border}`,flexShrink:0,zIndex:1}}/>}
          </div>
        )
      })}
    </div>
  )
}

// CHANGED: single cascading status per leg — PI → PO → Invoice → Movement,
// showing whichever stage is furthest along instead of four separate status
// columns that could silently disagree with each other (e.g. Invoice showing
// "submitted" while Stock already says "Stock Moved").
function getLegStatus(pi, po, inv) {
  if (inv) {
    const stock = getInvoiceLifecycleStage(inv)
    if (inv.status === 'cancelled') return { key: stock.key, label: stock.key === 'overdue' ? 'Cancelled — Reversed' : 'Invoice Cancelled' }
    if (inv.status === 'draft') return { key: 'draft', label: 'Invoice Drafted' }
    if (stock.key === 'completed') return { key: 'completed', label: 'Stock Moved' }
    return { key: inv.status, label: `Invoice ${inv.status} — Awaiting Movement` }
  }
  if (po) return { key: po.status, label: `PO ${po.status}` }
  if (pi) return { key: pi.status, label: `PI ${pi.status}` }
  return { key: 'pending', label: 'Not Started' }
}

// CHANGED: real trading margin, not PI-vs-Invoice-of-the-same-leg (a leg's PI
// and Invoice are the same sale — quote vs final bill — so that comparison
// is always ~0% and was never a margin at all). The first leg's margin is
// this entity's actual stock cost vs what it billed out, sourced from
// Opening Stock (stock_opening_balance.rate) since the system went live
// mid-flow and the entity's own original purchase was never recorded as an
// invoice here. Every leg after that is priced off what the entity actually
// paid to acquire the goods — the previous leg's Invoice value.
// CHANGED: a leg can carry MULTIPLE invoices (partial dispatches / tranches),
// so both sides of the margin are SUMS — total sale value of all active
// invoices on this leg vs total purchase cost, never a single-invoice pair.
// invAggMap[legId] = { taxable, total, qty, count } summed over every
// non-cancelled invoice on that leg (built in load()).
function computeLegMargin(leg, legs, invAggMap, costBasisMap, crossOrderCostMap) {
  const sale = invAggMap[leg.id]?.taxable
  if (!(sale > 0)) return null
  let cost
  // CHANGED: a leg whose PI was copied from another order's PI isn't a
  // same-order continuation — its real cost is whatever that source leg
  // actually invoiced at (see crossOrderCostMap above), not "previous leg
  // of this order" or Opening Stock. A present-but-null entry means the
  // source leg isn't invoiced yet, so margin is deliberately left unknown
  // rather than falling back to an unrelated same-order figure.
  if (crossOrderCostMap && leg.id in crossOrderCostMap) {
    cost = crossOrderCostMap[leg.id]
  } else if (leg.leg_no === 1) {
    cost = costBasisMap?.[leg.id]
  } else {
    const prevLeg = legs.find(l => l.leg_no === leg.leg_no - 1)
    cost = prevLeg ? invAggMap[prevLeg.id]?.taxable : null
  }
  if (!(cost > 0)) return null
  return (sale - cost) / cost * 100
}

// CHANGED: PI/PO/Invoice numbers link straight through to whatever's been
// uploaded for that doc slot (leg_document_checklist → documents), so a
// number in this table is one click from the actual file instead of just
// being a label you then have to go find in the Documents panel.
function DocLink({ doc, children }) {
  if (!doc?.drive_file_id) return children
  return (
    <a
      href='#'
      onClick={async e => {
        e.preventDefault()
        try {
          const url = await getDriveViewUrl(doc.drive_file_id, doc.drive_url)
          window.open(url, '_blank', 'noopener,noreferrer')
          setTimeout(() => URL.revokeObjectURL(url), 60000)
        } catch (err) {
          console.error('Could not open document:', err)
        }
      }}
      style={{ color: C.accent, textDecoration: 'underline', cursor: 'pointer' }}
    >
      {children}
    </a>
  )
}

function OrderSummaryTable({ legs, piMap, poMap, invMap, invAggMap, docMap, costBasisMap, crossOrderCostMap, stockMarginMap }) {
  if (!legs.length) return null
  const en = e=>e?.short_name||e?.name||'—'
  const td = {padding:'8px 10px',borderBottom:`1px solid ${C.border}`}
  const th = {padding:'7px 10px',fontSize:'10px',fontWeight:700,color:C.textSoft,textTransform:'uppercase',letterSpacing:'0.05em',background:C.bg,borderBottom:`1px solid ${C.border}`,borderTop:`1px solid ${C.border}`,whiteSpace:'nowrap'}
  return (
    <div style={{overflowX:'auto'}}>
      <table style={{width:'100%',borderCollapse:'collapse',fontSize:'12px',whiteSpace:'nowrap'}}>
        <thead>
          <tr>
            <th style={th}>Leg</th><th style={th}>Route</th><th style={th}>PI No</th><th style={th}>PI Date</th>
            <th style={th}>PO No</th>
            <th style={th}>Invoice No</th><th style={th}>Inv Date</th>
            <th style={{...th,textAlign:'right'}}>PI Qty</th>
            <th style={{...th,textAlign:'right'}}>Inv Qty</th>
            <th style={{...th,textAlign:'right'}}>PI Value</th>
            <th style={{...th,textAlign:'right'}}>Inv Value</th>
            <th style={{...th,textAlign:'right'}}>Margin</th>
            <th style={th}>Status</th>
            <th style={{...th,textAlign:'right'}}>Payment</th>
          </tr>
        </thead>
        <tbody>
          {legs.map((leg,ri)=>{
            const pi=piMap[leg.id], po=poMap?.[leg.id], inv=invMap[leg.id]
            const agg=invAggMap?.[leg.id]
            const legDocs=docMap?.[leg.id]
            const payStatus=!inv?'—':inv.status==='paid'?'Paid':inv.status==='partial'?'Partial':inv.outstanding_amount>0?'Outstanding':'—'
            const payColor=payStatus==='Paid'?C.success:payStatus==='Partial'?C.warning:payStatus==='Outstanding'?C.danger:C.textMuted
            const margin=computeLegMargin(leg,legs,invAggMap||{},costBasisMap,crossOrderCostMap)
            const stockMargin=stockMarginMap?.[leg.id]
            const status=getLegStatus(pi,po,inv)
            return (
              <tr key={leg.id} style={{background:ri%2===0?C.surface:'#faf6ed'}}>
                <td style={td}><div style={{width:22,height:22,borderRadius:'50%',background:C.accent,color:'#f5f0e8',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'11px',fontWeight:700}}>{leg.leg_no}</div></td>
                <td style={td}><span style={{fontWeight:600}}>{en(leg.from_entity)}</span><span style={{color:C.textMuted,margin:'0 4px'}}>→</span><span style={{fontWeight:600}}>{en(leg.to_entity)}</span></td>
                <td style={{...td,fontFamily:'monospace'}}>{pi?.pi_no?<DocLink doc={legDocs?.pi}>{pi.pi_no}</DocLink>:<span style={{color:C.textMuted}}>—</span>}</td>
                <td style={{...td,color:C.textSoft}}>{pi?fmtDate(pi.pi_date):'—'}</td>
                <td style={{...td,fontFamily:'monospace'}}>{po?.po_no?<DocLink doc={legDocs?.po}>{po.po_no}</DocLink>:<span style={{color:C.textMuted}}>—</span>}</td>
                <td style={{...td,fontFamily:'monospace'}}>
                  {inv?.invoice_no?<DocLink doc={legDocs?.invoice}>{inv.invoice_no}</DocLink>:<span style={{color:C.textMuted}}>—</span>}
                  {/* CHANGED: a leg can hold several invoices (tranches) — show the count so the summed Qty/Value columns make sense */}
                  {agg?.count>1&&<span style={{marginLeft:4,fontSize:'10px',color:C.textMuted,fontFamily:'inherit'}}>+{agg.count-1} more</span>}
                </td>
                <td style={{...td,color:C.textSoft}}>{inv?fmtDate(inv.invoice_date):'—'}</td>
                <td style={{...td,textAlign:'right',fontVariantNumeric:'tabular-nums'}}>{pi?.total_qty>0?formatQty(pi.total_qty):'—'}</td>
                <td style={{...td,textAlign:'right',fontVariantNumeric:'tabular-nums'}}>{agg?.qty>0?formatQty(agg.qty):'—'}</td>
                <td style={{...td,textAlign:'right',fontVariantNumeric:'tabular-nums'}}>{pi?.total_amount>0?formatINR(pi.total_amount):'—'}</td>
                <td style={{...td,textAlign:'right',fontWeight:600,fontVariantNumeric:'tabular-nums'}}>{agg?.total>0?formatINR(agg.total):'—'}</td>
                <td style={{...td,textAlign:'right',fontWeight:700,color:margin===null?C.textMuted:margin>=0?'#1a5c30':C.danger}}>
                  <div>{margin!==null?`${margin>=0?'+':''}${margin.toFixed(1)}%`:'—'}</div>
                  {/* CHANGED: second margin basis — sale vs the last purchase rate the from-entity's stock was actually acquired at, see fetchActualStockPosition's last_purchase_rate */}
                  {stockMargin!=null&&<div title='Margin vs last purchase rate of stock on hand' style={{fontSize:'10px',fontWeight:600,color:stockMargin>=0?'#1a7a40':C.danger}}>stk {stockMargin>=0?'+':''}{stockMargin.toFixed(1)}%</div>}
                </td>
                <td style={td}><Badge status={status.key} label={status.label}/></td>
                <td style={{...td,textAlign:'right',fontWeight:600,color:payColor}}>{payStatus}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function OrdersList() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  // CHANGED: bulk delete — restricted to 'master' role, same convention as PI/PO/Invoices
  const canDelete = hasFullAccess(profile)
  // CHANGED: which entities this user may raise an order *from* — orders_write
  // is gated on has_entity_grant(origin_entity_id).
  const { entities: accessEntities, frozen: originEntityFrozen, defaultEntityId } = useEntityAccess()
  const [selected, setSelected] = useState(new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [orders, setOrders]   = useState([])
  const [entities, setEntities] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch]   = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')  // date filters
  const [dateTo, setDateTo]     = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm]       = useState(EMPTY_ORDER)
  const [saving, setSaving]   = useState(false)
  const [toast, setToast]     = useState(null)
  // CHANGED: per-order live progress ("Leg 2/3 · Invoiced") derived from leg
  // document activity — replaces the old expand-row UI.
  const [progressMap, setProgressMap] = useState({})

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: os }, { data: es }, { data: legRows }] = await Promise.all([
      supabase.from('orders').select('*, origin:origin_entity_id(name,short_name), destination:destination_entity_id(name,short_name), financial_years(name)').eq('is_deleted',false).order('created_at',{ascending:false}),
      supabase.from('entities').select('id,name,short_name,state_code').eq('is_active',true).eq('is_deleted',false).order('name'),
      fetchAllPages(() => supabase.from('order_legs').select('id,order_id,leg_no')),
    ])
    // CHANGED: derive each order's live status + current-leg progress from
    // the PI/PO/Invoice activity on its legs (utils/orders.js), and persist
    // any status that has auto-advanced (planned/open → in_progress →
    // completed) so the DB never lags behind reality.
    const [{ data: piRows }, { data: poRows }, { data: invRows }] = await Promise.all([
      fetchAllPages(() => supabase.from('proforma_invoices').select('order_leg_id,status').not('order_leg_id','is',null).eq('is_deleted',false)),
      fetchAllPages(() => supabase.from('purchase_orders').select('order_leg_id,status').not('order_leg_id','is',null).eq('is_deleted',false)),
      fetchAllPages(() => supabase.from('invoices').select('order_leg_id,status,eway_bill_no,invoice_type,source_invoice_id').not('order_leg_id','is',null).eq('is_deleted',false)),
    ])
    const docsByLeg = {}
    const ensureLeg = id => { if (!docsByLeg[id]) docsByLeg[id] = { pis: [], pos: [], invoices: [] }; return docsByLeg[id] }
    for (const r of (piRows||[]))  ensureLeg(r.order_leg_id).pis.push(r)
    for (const r of (poRows||[]))  ensureLeg(r.order_leg_id).pos.push(r)
    // CHANGED: exclude auto-generated purchase mirrors (see utils/query.js) —
    // otherwise a leg's tranche/document activity counts each mirrored
    // transaction twice.
    for (const r of (invRows||[]).filter(inv => !isAutoPurchaseMirror(inv))) ensureLeg(r.order_leg_id).invoices.push(r)
    const legsByOrder = {}
    for (const l of (legRows||[])) { if (!legsByOrder[l.order_id]) legsByOrder[l.order_id] = []; legsByOrder[l.order_id].push(l) }
    const pMap = {}
    const changed = {}
    const derivedOrders = (os||[]).map(o => {
      const oLegs = legsByOrder[o.id] || []
      pMap[o.id] = getOrderProgress(oLegs, docsByLeg)
      const derived = deriveOrderStatus(o, oLegs, docsByLeg) || o.status
      if (derived !== o.status) {
        if (!changed[derived]) changed[derived] = []
        changed[derived].push(o.id)
        return { ...o, status: derived }
      }
      return o
    })
    for (const [status, ids] of Object.entries(changed)) {
      await supabase.from('orders').update({ status, updated_at: new Date() }).in('id', ids)
    }
    setOrders(derivedOrders); setEntities(es||[]); setProgressMap(pMap); setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  function setF(k,v) { setForm(f=>({...f,[k]:v})) }

  async function handleSave() {
    if (!form.name.trim()) return setToast({message:'Order name is required',type:'error'})
    setSaving(true)
    const fy = await resolveFY()
    if (!fy) { setSaving(false); return setToast({message:'No financial year found in DB',type:'error'}) }
    // CHANGED: was calling the next_order_no RPC, which relied on the
    // order_sequence counter table. After that table was reset (and like the
    // other numbering RPCs that never reliably existed on the live DB), the
    // RPC returned NULL with no error → NOT-NULL violation on order_no. Now
    // uses the same client-side suggestNextNo() pattern as PI/PO/Invoice:
    // format ORD-{fyCode}-NNN, derived from the highest existing order_no.
    const fyCode = fyCodeForDate(fy.start_date || today())
    const orderNo = await suggestNextNo({ table: 'orders', noCol: 'order_no', entityShort: 'ORD', fyCode })
    const payload = {...form, order_no:orderNo, financial_year_id:fy.id}
    if (!payload.origin_entity_id) delete payload.origin_entity_id
    if (!payload.destination_entity_id) delete payload.destination_entity_id
    const { data, error } = await supabase.from('orders').insert(payload).select().single()
    setSaving(false)
    if (error) return setToast({message:error.message,type:'error'})
    setModalOpen(false)
    navigate(`/orders/${data.id}`)
  }

  const filtered = orders.filter(o => {
    const ms  = !search||o.name.toLowerCase().includes(search.toLowerCase())||(o.order_no||'').toLowerCase().includes(search.toLowerCase())
    const mst = statusFilter==='all'||o.status===statusFilter
    const mdf = !dateFrom||o.created_at>=dateFrom
    const mdt = !dateTo||o.created_at<=dateTo+'T23:59:59'
    return ms&&mst&&mdf&&mdt
  })
  const en = e=>e?.short_name||e?.name||'—'

  // CHANGED: multi-select + bulk soft-delete, same shape as PI/PO/Invoices
  function toggleSelect(id) {
    setSelected(s => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next })
  }
  function toggleSelectAll() {
    setSelected(s => s.size === filtered.length ? new Set() : new Set(filtered.map(o => o.id)))
  }
  async function handleBulkDelete() {
    setBulkDeleting(true)
    const { error } = await supabase.from('orders').update({ is_deleted: true }).in('id', [...selected])
    setBulkDeleting(false)
    setConfirmBulkDelete(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: `${selected.size} order(s) deleted`, type: 'success' })
    setSelected(new Set())
    load()
  }

  return (
    <div>
      <PageHeader title='Orders' subtitle='Track every movement of goods end-to-end' action={<Btn onClick={()=>{setForm({...EMPTY_ORDER,origin_entity_id:defaultEntityId});setModalOpen(true)}}>+ New Order</Btn>}/>
      <div style={{display:'flex',gap:'10px',marginBottom:'16px',flexWrap:'wrap'}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder='Search orders…' style={{padding:'8px 12px',border:`1.5px solid ${C.border}`,borderRadius:'6px',background:C.surface,fontSize:'13px',outline:'none',flex:1,minWidth:'180px',fontFamily:'inherit'}}/>
        <select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)} style={{padding:'8px 12px',border:`1.5px solid ${C.border}`,borderRadius:'6px',background:C.surface,fontSize:'13px',outline:'none',cursor:'pointer',fontFamily:'inherit'}}>
          <option value='all'>All statuses</option>
          {ORDER_STATUSES.map(s=><option key={s} value={s}>{s}</option>)}
        </select>
        <input type='date' value={dateFrom} onChange={e=>setDateFrom(e.target.value)} style={{padding:'8px 10px',border:`1.5px solid ${C.border}`,borderRadius:'6px',background:C.surface,fontSize:'13px',outline:'none',fontFamily:'inherit'}} title='From date'/>
        <input type='date' value={dateTo} onChange={e=>setDateTo(e.target.value)} style={{padding:'8px 10px',border:`1.5px solid ${C.border}`,borderRadius:'6px',background:C.surface,fontSize:'13px',outline:'none',fontFamily:'inherit'}} title='To date'/>
        {(dateFrom||dateTo)&&<Btn size='sm' variant='ghost' onClick={()=>{setDateFrom('');setDateTo('')}}>Clear dates</Btn>}
      </div>

      {/* CHANGED: bulk-selection action bar, same pattern as PI/PO/Invoices */}
      {canDelete && selected.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fff3cc', border: '1px solid #e8d89a', borderRadius: '6px', padding: '8px 14px', marginBottom: '12px' }}>
          <span style={{ fontSize: '13px', fontWeight: 600 }}>{selected.size} order{selected.size > 1 ? 's' : ''} selected</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn size='sm' variant='ghost' onClick={() => setSelected(new Set())}>Clear</Btn>
            <Btn size='sm' variant='danger' onClick={() => setConfirmBulkDelete(true)} disabled={bulkDeleting}>{bulkDeleting ? 'Deleting…' : 'Delete Selected'}</Btn>
          </div>
        </div>
      )}

      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:'8px',overflow:'hidden'}}>
        {loading ? <div style={{padding:'48px',textAlign:'center',color:C.textMuted}}>Loading…</div>
        : <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:'13px'}}>
              <thead><tr>
                {/* CHANGED: checkbox column, master-only, same as PI/PO/Invoices */}
                {canDelete && <th style={{padding:'8px 12px',background:C.bg,borderBottom:`1px solid ${C.border}`,borderTop:`1px solid ${C.border}`,width:'32px'}}>
                  <input type='checkbox' checked={filtered.length>0 && selected.size===filtered.length}
                    onChange={toggleSelectAll} style={{width:'14px',height:'14px',cursor:'pointer'}}/>
                </th>}
                {['Order','Type','From','To','FY','Status','Progress','Date'].map((h,i)=>(
                <th key={i} style={{padding:'8px 12px',textAlign:'left',fontSize:'11px',fontWeight:700,color:C.textSoft,textTransform:'uppercase',letterSpacing:'0.05em',background:C.bg,borderBottom:`1px solid ${C.border}`,borderTop:`1px solid ${C.border}`,whiteSpace:'nowrap'}}>{h}</th>
              ))}</tr></thead>
              <tbody>
                {filtered.length===0&&<tr><td colSpan={canDelete?9:8} style={{padding:'48px',textAlign:'center',color:C.textMuted}}>No orders found.</td></tr>}
                {/* CHANGED: the whole row opens the order (no more ▼/"Open →" buttons at the end) */}
                {filtered.map((o,ri)=>{
                  const pr = progressMap[o.id]
                  return (
                    <tr key={o.id} style={{background:ri%2===0?C.surface:'#faf6ed',cursor:'pointer'}} onClick={()=>navigate(`/orders/${o.id}`)} onMouseEnter={e=>e.currentTarget.style.background='#f0e8d8'} onMouseLeave={e=>e.currentTarget.style.background=ri%2===0?C.surface:'#faf6ed'}>
                      {canDelete && <td style={{padding:'9px 12px',borderBottom:`1px solid ${C.border}`}} onClick={e=>e.stopPropagation()}>
                        <input type='checkbox' checked={selected.has(o.id)} onChange={()=>toggleSelect(o.id)} style={{width:'14px',height:'14px',cursor:'pointer'}}/>
                      </td>}
                      <td style={{padding:'9px 12px',borderBottom:`1px solid ${C.border}`}}><div style={{fontWeight:600}}>{o.name}</div>{o.order_no&&<div style={{fontSize:'11px',color:C.textMuted,fontFamily:'monospace'}}>{o.order_no}</div>}</td>
                      <td style={{padding:'9px 12px',borderBottom:`1px solid ${C.border}`}}><Badge status={o.movement_type}/></td>
                      <td style={{padding:'9px 12px',borderBottom:`1px solid ${C.border}`,fontSize:'12px'}}>{en(o.origin)}</td>
                      <td style={{padding:'9px 12px',borderBottom:`1px solid ${C.border}`,fontSize:'12px'}}>{en(o.destination)}</td>
                      <td style={{padding:'9px 12px',borderBottom:`1px solid ${C.border}`,fontSize:'12px',color:C.textSoft}}>{o.financial_years?.name||'—'}</td>
                      <td style={{padding:'9px 12px',borderBottom:`1px solid ${C.border}`}}><Badge status={o.status}/></td>
                      {/* CHANGED: live "which leg is this order at" — derived from actual PI/PO/Invoice activity */}
                      <td style={{padding:'9px 12px',borderBottom:`1px solid ${C.border}`,fontSize:'12px',color:C.textSoft,whiteSpace:'nowrap'}}>
                        {!pr ? <span style={{color:C.textMuted}}>No legs</span>
                          : pr.legNo ? <><span style={{fontWeight:600,color:C.text}}>Leg {pr.legNo}/{pr.totalLegs}</span> · {pr.stage}</>
                          : `${pr.totalLegs} leg${pr.totalLegs>1?'s':''} · Not started`}
                      </td>
                      <td style={{padding:'9px 12px',borderBottom:`1px solid ${C.border}`,fontSize:'12px',color:C.textSoft}}>{fmtDate(o.created_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        }
      </div>

      <Modal open={modalOpen} onClose={()=>setModalOpen(false)} title='New Order' width={600}>
        <div style={{display:'flex',flexDirection:'column',gap:'14px'}}>
          <div style={{background:'#e8f3ec',border:'1px solid #b8dfca',borderRadius:'6px',padding:'8px 12px',fontSize:'12px',color:'#1a5c30'}}>
            📅 Will be created under <strong>{currentFYLabel()}</strong>
          </div>
          <FormRow label='Order Name' required hint='e.g. "Siddi → Retail → MVL Jun-25"'>
            <Input value={form.name} onChange={e=>setF('name',e.target.value)} placeholder='Descriptive name'/>
          </FormRow>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px'}}>
            <FormRow label='Movement Type' required>
              <Select value={form.movement_type} onChange={e=>setF('movement_type',e.target.value)}>{MOVEMENT_TYPES.map(t=><option key={t} value={t}>{t}</option>)}</Select>
            </FormRow>
            <FormRow label='Status'>
              <Select value={form.status} onChange={e=>setF('status',e.target.value)}>{ORDER_STATUSES.map(s=><option key={s} value={s}>{s}</option>)}</Select>
            </FormRow>
            <FormRow label='Origin Entity' hint={originEntityFrozen ? 'Locked to the only entity you have access to' : undefined}>
              <Select value={form.origin_entity_id} onChange={e=>setF('origin_entity_id',e.target.value)} disabled={originEntityFrozen}>
                <option value=''>Select entity</option>{accessEntities.map(e=><option key={e.id} value={e.id}>{e.short_name||e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Destination Entity'>
              <Select value={form.destination_entity_id} onChange={e=>setF('destination_entity_id',e.target.value)}>
                <option value=''>Select entity</option>{entities.map(e=><option key={e.id} value={e.id}>{e.short_name||e.name}</option>)}
              </Select>
            </FormRow>
          </div>
          <FormRow label='Notes'><Textarea value={form.notes} onChange={e=>setF('notes',e.target.value)} rows={2}/></FormRow>
          <div style={{display:'flex',justifyContent:'flex-end',gap:'10px',paddingTop:'8px',borderTop:`1px solid ${C.border}`}}>
            <Btn variant='ghost' onClick={()=>setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving?'Creating…':'Create Order'}</Btn>
          </div>
        </div>
      </Modal>
      {/* CHANGED: bulk delete confirmation, same pattern as PI/PO/Invoices */}
      <ConfirmModal open={confirmBulkDelete} onClose={()=>setConfirmBulkDelete(false)} onConfirm={handleBulkDelete}
        title='Delete Orders' message={`Delete ${selected.size} selected order(s)? This cannot be undone.`} danger/>
      {toast&&<Toast message={toast.message} type={toast.type} onClose={()=>setToast(null)}/>}
    </div>
  )
}

function OrderDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuth()
  // CHANGED: single-order delete, master-only, same convention as PI/PO/Invoices detail pages
  const canDelete = hasFullAccess(profile)
  // CHANGED: orders_write / order_legs_write are both gated on
  // has_entity_grant(origin_entity_id / from_entity_id) — same "creating
  // side" restriction as the New Order form.
  const { entities: accessEntities, frozen: originEntityFrozen, defaultEntityId } = useEntityAccess()
  const [confirmDeleteOrder, setConfirmDeleteOrder] = useState(false)
  const [deletingOrder, setDeletingOrder] = useState(false)
  const [order, setOrder]       = useState(null)
  const [legs, setLegs]         = useState([])
  const [entities, setEntities] = useState([])
  const [loading, setLoading]   = useState(true)
  const [legModal, setLegModal] = useState(false)
  const [editingLeg, setEditingLeg] = useState(null)
  const [legForm, setLegForm]   = useState(EMPTY_LEG)
  const [saving, setSaving]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [editOrderModal, setEditOrderModal] = useState(false)
  const [orderForm, setOrderForm] = useState({})
  const [toast, setToast]       = useState(null)
  const [piMap, setPiMap]       = useState({})
  const [poMap, setPoMap]       = useState({})
  const [invMap, setInvMap]     = useState({})
  // CHANGED: a leg can carry multiple invoices (tranches) — invMap keeps the
  // primary/latest for the pipeline display, invAggMap holds the SUMS
  // (taxable/total/qty/count over non-cancelled invoices) that margins and
  // the summary table's Inv columns are computed from.
  const [invAggMap, setInvAggMap] = useState({})
  // CHANGED: per-leg margin vs the from-entity's average stock carrying cost
  // (opening + purchased-in) — the "what are we really making on the goods
  // we hold" view, alongside the deal margin.
  const [stockMarginMap, setStockMarginMap] = useState({})
  // CHANGED: live "which leg is this order at" summary for the header.
  const [orderProgress, setOrderProgress] = useState(null)
  const [docMap, setDocMap]     = useState({})
  const [costBasisMap, setCostBasisMap] = useState({}) // CHANGED: leg-1's real acquisition cost, keyed by leg id — see computeLegMargin
  // CHANGED: for a leg whose PI was built via "Copy Lines from Another PI"
  // (any order), the real cost isn't "previous leg of this order" — it's
  // wherever the copy actually came from. Keyed by leg id; a key present
  // (even with a null value, meaning the source leg isn't invoiced yet)
  // means computeLegMargin should use this instead of the same-order chain.
  const [crossOrderCostMap, setCrossOrderCostMap] = useState({})
  const [docsOpen, setDocsOpen] = useState({})
  const [legDocBusy, setLegDocBusy] = useState('') // `${legId}:${docType}:${format}` while generating
  // CHANGED: order-wide document completeness — sums each leg's checklist
  // instead of only showing completeness one leg at a time.
  const [docCompleteness, setDocCompleteness] = useState({ uploaded: 0, total: 0 })

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: o }, { data: ls }, { data: es }] = await Promise.all([
      supabase.from('orders').select('*, origin:origin_entity_id(name,short_name), destination:destination_entity_id(name,short_name), financial_years(name)').eq('id',id).single(),
      supabase.from('order_legs').select('*, from_entity:from_entity_id(name,short_name), to_entity:to_entity_id(name,short_name)').eq('order_id',id).order('leg_no'),
      supabase.from('entities').select('id,name,short_name,state_code').eq('is_active',true).eq('is_deleted',false).order('name'),
    ])
    setOrder(o); setLegs(ls||[]); setEntities(es||[]); setLoading(false)
    if (ls?.length) {
      const legIds = ls.map(l=>l.id)
      const [{ data: piRows },{ data: poRows },{ data: invRows },{ data: checklistRows }] = await Promise.all([
        // CHANGED: was querying/filtering on `leg_id`, but proforma_invoices/
        // invoices reference a leg via `order_leg_id` (see PI/Invoices save
        // payloads) — `leg_id` doesn't exist on these two tables, so both
        // queries errored and this map silently stayed empty for every leg.
        supabase.from('proforma_invoices').select('id,pi_no,status,total_amount,total_qty,taxable_amount,order_leg_id,pi_date,copied_from_pi_id').in('order_leg_id',legIds).eq('is_deleted',false).order('created_at',{ascending:false}),
        // CHANGED: PO feeds the cascading leg Status column (PI → PO → Invoice → Movement)
        supabase.from('purchase_orders').select('id,po_no,status,order_leg_id').in('order_leg_id',legIds).eq('is_deleted',false).order('created_at',{ascending:false}),
        supabase.from('invoices').select('id,invoice_no,status,total_amount,total_qty,taxable_amount,outstanding_amount,order_leg_id,invoice_date,eway_bill_no,invoice_type,source_invoice_id').in('order_leg_id',legIds).eq('is_deleted',false).order('created_at',{ascending:false}),
        // CHANGED: joined document (drive_file_id/drive_url) so PI/PO/Invoice
        // numbers in the summary table can link straight to the uploaded file.
        supabase.from('leg_document_checklist').select('leg_id,doc_slot,status,document:document_id(drive_file_id,drive_url)').in('leg_id',legIds),
      ])
      // CHANGED: drop auto-generated purchase mirrors (invoice_type='purchase'
      // with source_invoice_id set — see utils/query.js) before building
      // ANY of the per-leg maps below. The mirror is created immediately
      // after (so always later than) its source, and this array is ordered
      // created_at DESC — so without this filter, `iMap`'s "keep the first
      // one seen" pick would take the MIRROR as the leg's "primary" invoice
      // for every internal-buyer leg (wrong invoice_no/date/status shown in
      // the pipeline and summary table), and `iListMap`'s sums would double
      // every such leg's Inv Qty/Value and margin inputs.
      const realInvRows = (invRows||[]).filter(inv => !isAutoPurchaseMirror(inv))
      const pMap={}, poM={}, iMap={}, iListMap={}
      for (const pi of (piRows||[])){ if(!pMap[pi.order_leg_id]) pMap[pi.order_leg_id]=pi }
      for (const po of (poRows||[])){ if(!poM[po.order_leg_id]) poM[po.order_leg_id]=po }
      for (const inv of realInvRows){
        if(!iMap[inv.order_leg_id]) iMap[inv.order_leg_id]=inv
        if(!iListMap[inv.order_leg_id]) iListMap[inv.order_leg_id]=[]
        iListMap[inv.order_leg_id].push(inv)
      }
      setPiMap(pMap); setPoMap(poM); setInvMap(iMap)

      // CHANGED: sum every non-cancelled invoice on a leg — margins and the
      // summary table's Inv Qty/Value read these sums, so a leg invoiced in
      // several tranches is measured on its full purchase/sale totals, not
      // just whichever invoice happened to be first.
      const aggMap = {}
      for (const [legId, list] of Object.entries(iListMap)) {
        const act = list.filter(v => v.status !== 'cancelled')
        aggMap[legId] = {
          taxable: round2(act.reduce((s,v)=>s+toNum(v.taxable_amount),0)),
          total:   round2(act.reduce((s,v)=>s+toNum(v.total_amount),0)),
          qty:     round2(act.reduce((s,v)=>s+toNum(v.total_qty),0)),
          count:   act.length,
        }
      }
      setInvAggMap(aggMap)

      // CHANGED: resolve cross-order cost for legs whose PI has
      // copied_from_pi_id set — see crossOrderCostMap above. Only one hop
      // (the immediate source), not a full chain walk.
      const copiedEntries = Object.entries(pMap).filter(([, pi]) => pi.copied_from_pi_id)
      const coMap = {}
      if (copiedEntries.length) {
        const sourcePiIds = [...new Set(copiedEntries.map(([, pi]) => pi.copied_from_pi_id))]
        const { data: sourcePis } = await supabase.from('proforma_invoices').select('id,order_leg_id').in('id', sourcePiIds)
        const sourceLegBySourcePi = {}
        for (const sp of (sourcePis||[])) sourceLegBySourcePi[sp.id] = sp.order_leg_id
        const sourceLegIds = [...new Set(Object.values(sourceLegBySourcePi).filter(Boolean))]
        let sourceInvByLeg = {}
        if (sourceLegIds.length) {
          // CHANGED: SUM the source leg's non-cancelled invoices, not just the
          // first — the source leg may have been invoiced in tranches too.
          // Also excludes auto-generated purchase mirrors (utils/query.js) —
          // otherwise a source leg whose buyer was internal would have its
          // real cost double-counted here.
          const { data: sourceInvs } = await supabase.from('invoices').select('order_leg_id,taxable_amount,status,invoice_type,source_invoice_id').in('order_leg_id', sourceLegIds).eq('is_deleted', false)
          for (const inv of (sourceInvs||[])) {
            if (inv.status === 'cancelled' || isAutoPurchaseMirror(inv)) continue
            sourceInvByLeg[inv.order_leg_id] = (sourceInvByLeg[inv.order_leg_id] || 0) + toNum(inv.taxable_amount)
          }
        }
        for (const [legId, pi] of copiedEntries) {
          const sourceLegId = sourceLegBySourcePi[pi.copied_from_pi_id]
          coMap[legId] = sourceLegId ? (sourceInvByLeg[sourceLegId] ?? null) : null
        }
      }
      setCrossOrderCostMap(coMap)

      const dMap={}
      for (const c of (checklistRows||[])){
        if (c.status==='uploaded' && c.document){
          if (!dMap[c.leg_id]) dMap[c.leg_id]={}
          dMap[c.leg_id][c.doc_slot]=c.document
        }
      }
      setDocMap(dMap)
      const relevant = (checklistRows||[]).filter(c=>c.status!=='na')
      setDocCompleteness({ uploaded: relevant.filter(c=>c.status==='uploaded').length, total: relevant.length })

      // CHANGED: leg-1's cost basis for margin — the real rate this entity's
      // stock was carried at (Opening Stock), not a purchase invoice, since
      // no such invoice exists for stock the entity already held when this
      // system went live. Only computed for leg 1; every later leg's margin
      // uses the previous leg's own Invoice value instead (see computeLegMargin).
      const leg1 = ls.find(l => l.leg_no === 1)
      // CHANGED: cost basis spans ALL of leg 1's non-cancelled invoices, not
      // just the first — tranche-invoiced legs need every line costed.
      const leg1Invs = leg1 ? (iListMap[leg1.id] || []).filter(v => v.status !== 'cancelled') : []
      const cbMap = {}
      if (leg1Invs.length) {
        const [{ data: invLines }, { data: obRows }] = await Promise.all([
          fetchAllPages(() => supabase.from('invoice_lines').select('product_id,qty').in('invoice_id', leg1Invs.map(v => v.id))),
          supabase.from('stock_opening_balance').select('product_id,rate').eq('entity_id', leg1.from_entity_id).eq('financial_year_id', o.financial_year_id),
        ])
        const rateByProduct = {}
        for (const ob of (obRows||[])) rateByProduct[ob.product_id] = toNum(ob.rate)
        let cost = 0, known = true
        for (const line of (invLines||[])) {
          const r = rateByProduct[line.product_id]
          if (!(r > 0)) { known = false; break }
          cost += toNum(line.qty) * r
        }
        cbMap[leg1.id] = (known && cost > 0) ? cost : null
      }
      setCostBasisMap(cbMap)

      // CHANGED: stock-basis margin per leg — the summed sale value of the
      // leg's invoices vs what the from-entity's stock was actually LAST
      // ACQUIRED at (last purchase rate, not a blended average — see
      // buildLastPurchaseRateMap in utils/stock.js), E-way-Bill gated like
      // the live stock calc. Left unknown when any product on the leg has
      // no known purchase rate, rather than guessing.
      const smMap = {}
      const allActiveInvs = Object.values(iListMap).flat().filter(v => v.status !== 'cancelled')
      if (allActiveInvs.length) {
        // CHANGED: fetchActualStockPosition() hits the server-side
        // aggregation RPC (migration 041/044) for last_purchase_rate per
        // entity+product instead of downloading every raw invoice/opening-
        // balance row just to rank them in the browser.
        const [{ data: allLines }, valuation] = await Promise.all([
          fetchAllPages(() => supabase.from('invoice_lines').select('invoice_id,product_id,qty,rate').in('invoice_id', allActiveInvs.map(v => v.id))),
          fetchActualStockPosition(),
        ])
        const linesByInvoice = {}
        for (const l of (allLines||[])) {
          if (!linesByInvoice[l.invoice_id]) linesByInvoice[l.invoice_id] = []
          linesByInvoice[l.invoice_id].push(l)
        }
        for (const leg of ls) {
          const legInvs = (iListMap[leg.id] || []).filter(v => v.status !== 'cancelled')
          if (!legInvs.length) continue
          let cost = 0, sale = 0, known = true
          for (const v of legInvs) {
            for (const l of (linesByInvoice[v.id] || [])) {
              const val = valuation[`${leg.from_entity_id}__${l.product_id}`]
              if (!val || !(val.last_purchase_rate > 0)) { known = false; break }
              cost += toNum(l.qty) * val.last_purchase_rate
              sale += toNum(l.qty) * toNum(l.rate)
            }
            if (!known) break
          }
          if (known && cost > 0) smMap[leg.id] = (sale - cost) / cost * 100
        }
      }
      setStockMarginMap(smMap)

      // CHANGED: auto-advance the order's status from real leg activity
      // (planned/open → in_progress → completed once every leg's stock has
      // moved) and persist it, so the Orders list and this page always show
      // where the order actually stands. 'cancelled' and manual forward
      // statuses are never overridden — see deriveOrderStatus.
      const docsByLeg = {}
      for (const l of ls) docsByLeg[l.id] = {
        pis:      (piRows||[]).filter(p => p.order_leg_id === l.id),
        pos:      (poRows||[]).filter(p => p.order_leg_id === l.id),
        invoices: iListMap[l.id] || [],
      }
      setOrderProgress(getOrderProgress(ls, docsByLeg))
      const derived = deriveOrderStatus(o, ls, docsByLeg)
      if (derived && derived !== o.status) {
        const { error: stErr } = await supabase.from('orders').update({ status: derived, updated_at: new Date() }).eq('id', o.id)
        if (!stErr) setOrder({ ...o, status: derived })
      }
    } else {
      setInvAggMap({}); setStockMarginMap({}); setOrderProgress(null)
    }
  }, [id])

  useEffect(() => { load() }, [load])
  function setLF(k,v){ setLegForm(f=>({...f,[k]:v})) }
  function setOF(k,v){ setOrderForm(f=>({...f,[k]:v})) }
  function toggleDocs(legId){ setDocsOpen(d=>({...d,[legId]:!d[legId]})) }

  async function handleLegDoc(legId, docType, docId, format) {
    if (!docId) return
    const key = `${legId}:${docType}:${format}`
    setLegDocBusy(key)
    try {
      const doc = await fetchAndBuildLegDoc(docType, docId)
      if (format === 'pdf') printDocument(doc)
      else downloadDocumentExcel(doc)
    } catch (err) {
      setToast({ message: err.message || `Could not generate ${docType} ${format}`, type: 'error' })
    } finally {
      setLegDocBusy('')
    }
  }
  function openNewLeg(){ setEditingLeg(null); setLegForm({...EMPTY_LEG,from_entity_id:defaultEntityId}); setLegModal(true) }
  function openEditLeg(leg){ setEditingLeg(leg); setLegForm({from_entity_id:leg.from_entity_id||'',to_entity_id:leg.to_entity_id||'',movement_status:leg.movement_status||'pending',cargo_status:leg.cargo_status||'awaiting_cargo',dispatch_date:leg.dispatch_date||'',delivery_date:leg.delivery_date||'',notes:leg.notes||''}); setLegModal(true) }

  async function handleSaveLeg(){
    if (!legForm.from_entity_id||!legForm.to_entity_id) return setToast({message:'From and To entities are required',type:'error'})
    setSaving(true)
    const payload={...legForm,order_id:id}
    if (!payload.dispatch_date) delete payload.dispatch_date
    if (!payload.delivery_date) delete payload.delivery_date
    const fromEnt=entities.find(e=>e.id===legForm.from_entity_id), toEnt=entities.find(e=>e.id===legForm.to_entity_id)
    payload.is_interstate=(fromEnt?.state_code&&toEnt?.state_code)?fromEnt.state_code!==toEnt.state_code:false
    let error
    if (editingLeg){ const r=await supabase.from('order_legs').update(payload).eq('id',editingLeg.id); error=r.error }
    // CHANGED: max(leg_no)+1, not legs.length+1 — deleting a middle leg used
    // to make the next added leg collide with an existing leg_no.
    else { payload.leg_no=legs.reduce((m,l)=>Math.max(m,l.leg_no||0),0)+1; const r=await supabase.from('order_legs').insert(payload); error=r.error }
    setSaving(false)
    if (error) return setToast({message:error.message,type:'error'})
    setToast({message:editingLeg?'Leg updated':'Leg added',type:'success'})
    setLegModal(false); load()
  }

  // CHANGED: both results were unchecked — a leg with PI/PO/Invoice rows
  // pointing at it fails the FK delete silently, and a failed order save
  // just closed the modal as if it worked. Surface the error instead.
  async function handleDeleteLeg(){
    const { error } = await supabase.from('order_legs').delete().eq('id',confirmDelete.id)
    setConfirmDelete(null)
    if (error) return setToast({message:`Could not remove leg: ${error.message}`,type:'error'})
    load()
  }
  async function handleSaveOrder(){
    const payload={...orderForm,updated_at:new Date()}
    if (!payload.origin_entity_id) delete payload.origin_entity_id
    if (!payload.destination_entity_id) delete payload.destination_entity_id
    const { error } = await supabase.from('orders').update(payload).eq('id',id)
    if (error) return setToast({message:error.message,type:'error'})
    setEditOrderModal(false); load()
  }
  // CHANGED: soft-delete the order itself (order_legs are untouched — same
  // as PI/PO/Invoices, which don't cascade-delete their child rows either)
  async function handleDeleteOrder(){
    setDeletingOrder(true)
    const { error } = await supabase.from('orders').update({ is_deleted: true }).eq('id', id)
    setDeletingOrder(false); setConfirmDeleteOrder(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    navigate('/orders')
  }

  if (loading) return <div style={{padding:'48px',textAlign:'center',color:C.textMuted}}>Loading…</div>
  if (!order)  return <div style={{padding:'48px',textAlign:'center',color:C.danger}}>Order not found.</div>

  const en = e=>e?.short_name||e?.name||'—'
  // CHANGED: true end-to-end margin — final leg's Invoice value against
  // leg-1's real acquisition cost (Opening Stock), not a sum of per-leg
  // PI-vs-Invoice differences (which was always ~0, see computeLegMargin).
  const leg1 = legs.find(l=>l.leg_no===1)
  const lastLeg = legs.reduce((max,l)=>!max||l.leg_no>max.leg_no?l:max,null)
  // CHANGED: last leg's SUMMED sale (all non-cancelled invoices), not just
  // its first invoice — see invAggMap.
  const lastSale = lastLeg ? invAggMap[lastLeg.id]?.taxable : null
  // CHANGED: same cross-order override as computeLegMargin — if leg 1's own
  // PI was copied from another order's PI, Opening Stock isn't the right
  // cost basis either.
  const leg1Cost = leg1 ? (leg1.id in crossOrderCostMap ? crossOrderCostMap[leg1.id] : costBasisMap[leg1.id]) : null
  const bm = (lastSale>0 && leg1Cost>0) ? ((lastSale-leg1Cost)/leg1Cost*100) : null

  return (
    <div>
      <button onClick={()=>navigate('/orders')} style={{background:'none',border:'none',color:C.textMuted,fontSize:'13px',cursor:'pointer',padding:0,fontFamily:'inherit',marginBottom:'4px'}}>← Orders</button>
      <PageHeader
        title={order.name}
        subtitle={`${order.order_no?order.order_no+' · ':''}${order.financial_years?.name||''}`}
        action={<div style={{display:'flex',gap:'8px'}}>
          <Btn variant='ghost' onClick={()=>{setOrderForm({name:order.name,movement_type:order.movement_type,status:order.status,origin_entity_id:order.origin_entity_id||'',destination_entity_id:order.destination_entity_id||'',notes:order.notes||''});setEditOrderModal(true)}}>Edit Order</Btn>
          <Btn onClick={openNewLeg}>+ Add Leg</Btn>
          {/* CHANGED: master-only order delete, same convention as PI/PO/Invoices */}
          {canDelete && <Btn variant='danger' onClick={()=>setConfirmDeleteOrder(true)} disabled={deletingOrder}>{deletingOrder?'Deleting…':'Delete Order'}</Btn>}
        </div>}
      />

      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))',gap:'12px',marginBottom:'24px'}}>
        <StatCard label='Status'        value={<Badge status={order.status}/>}/>
        <StatCard label='Movement Type' value={<Badge status={order.movement_type}/>}/>
        <StatCard label='Origin'        value={en(order.origin)}/>
        <StatCard label='Destination'   value={en(order.destination)}/>
        <StatCard label='Legs'          value={legs.length}/>
        {/* CHANGED: live position — which leg the order is currently at */}
        {orderProgress&&<StatCard label='Current Leg' value={orderProgress.legNo?`Leg ${orderProgress.legNo}/${orderProgress.totalLegs} · ${orderProgress.stage}`:'Not started'}/>}
        {bm!==null&&<StatCard label='Blended Margin' value={<span style={{color:bm>=0?'#1a5c30':C.danger,fontWeight:700}}>{bm>=0?'+':''}{bm.toFixed(1)}%</span>}/>}
      </div>

      {legs.length>0&&(
        <div style={{marginBottom:'24px'}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'10px'}}>
            <div style={{fontWeight:700,fontSize:'14px',color:C.text}}>Order Summary</div>
            <span style={{fontSize:'11px',color:C.textMuted}}>Live — updates as PIs and Invoices are created</span>
          </div>
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:'8px',overflow:'hidden'}}>
            <OrderSummaryTable legs={legs} piMap={piMap} poMap={poMap} invMap={invMap} invAggMap={invAggMap} stockMarginMap={stockMarginMap} docMap={docMap} costBasisMap={costBasisMap} crossOrderCostMap={crossOrderCostMap}/>
          </div>
        </div>
      )}

      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'12px'}}>
        <div style={{display:'flex',alignItems:'center',gap:'10px'}}>
          <div style={{fontWeight:700,fontSize:'14px',color:C.text}}>Order Legs</div>
          {docCompleteness.total > 0 && (
            <span style={{
              fontSize:'11px',fontWeight:700,padding:'2px 8px',borderRadius:'4px',
              background: docCompleteness.uploaded===docCompleteness.total ? '#e6f4ec' : '#fef6e4',
              color: docCompleteness.uploaded===docCompleteness.total ? '#1a6b35' : '#7a4f00',
            }}>
              📎 {docCompleteness.uploaded}/{docCompleteness.total} docs across order
            </span>
          )}
        </div>
        <Btn size='sm' onClick={openNewLeg}>+ Add Leg</Btn>
      </div>

      {legs.length===0
        ? <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:'8px'}}><EmptyState icon='↗' title='No legs yet' message='Add the first leg to this order.' action={<Btn onClick={openNewLeg}>+ Add Leg</Btn>}/></div>
        : legs.map(leg=>{
          const pi=piMap[leg.id], po=poMap[leg.id], inv=invMap[leg.id]
          const legM=computeLegMargin(leg,legs,invAggMap,costBasisMap,crossOrderCostMap)
          const stockM=stockMarginMap[leg.id]
          const docBtn=(docType,docRow,label)=>{
            const docId=docRow?.id
            return (
              <span key={docType} style={{display:'inline-flex',alignItems:'center',gap:'4px',opacity:docId?1:0.4}}>
                <span style={{fontSize:'11px',color:C.textMuted,fontWeight:600}}>{label}</span>
                <button title={`Download ${label} PDF`} disabled={!docId||!!legDocBusy} onClick={()=>handleLegDoc(leg.id,docType,docId,'pdf')}
                  style={{background:'none',border:`1px solid ${C.border}`,borderRadius:'4px',padding:'2px 6px',fontSize:'11px',cursor:docId?'pointer':'not-allowed'}}>
                  {legDocBusy===`${leg.id}:${docType}:pdf`?'…':'⎙'}
                </button>
                <button title={`Download ${label} Excel`} disabled={!docId||!!legDocBusy} onClick={()=>handleLegDoc(leg.id,docType,docId,'excel')}
                  style={{background:'none',border:`1px solid ${C.border}`,borderRadius:'4px',padding:'2px 6px',fontSize:'11px',cursor:docId?'pointer':'not-allowed'}}>
                  {legDocBusy===`${leg.id}:${docType}:excel`?'…':'↓'}
                </button>
              </span>
            )
          }
          return (
            <div key={leg.id} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:'8px',marginBottom:'12px',overflow:'hidden'}}>
              <div style={{padding:'14px 18px',borderBottom:`1px solid ${C.border}`,display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:'8px'}}>
                <div style={{display:'flex',alignItems:'center',gap:'12px'}}>
                  <div style={{width:26,height:26,borderRadius:'50%',background:C.accent,color:'#f5f0e8',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'12px',fontWeight:700,flexShrink:0}}>{leg.leg_no}</div>
                  <div>
                    <div style={{fontWeight:700,fontSize:'14px'}}>{en(leg.from_entity)} → {en(leg.to_entity)}</div>
                    <div style={{fontSize:'12px',color:C.textMuted,marginTop:'2px',display:'flex',gap:'12px',alignItems:'center',flexWrap:'wrap'}}>
                      <span>{leg.is_interstate===true?'Interstate — IGST':leg.is_interstate===false?'Local — CGST+SGST':'Tax type TBD'}</span>
                      {legM!==null&&<span style={{fontWeight:700,color:legM>=0?'#1a5c30':C.danger}}>Margin: {legM>=0?'+':''}{legM.toFixed(1)}%</span>}
                      {/* CHANGED: second margin basis — sale vs avg carrying cost of the from-entity's stock */}
                      {stockM!=null&&<span title='Margin vs average cost of stock on hand (opening + purchased-in)' style={{fontWeight:700,color:stockM>=0?'#1a7a40':C.danger}}>Stock margin: {stockM>=0?'+':''}{stockM.toFixed(1)}%</span>}
                    </div>
                  </div>
                </div>
                <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
                  <Badge status={leg.movement_status}/>
                  <Badge status={leg.cargo_status?.replace(/_/g,' ')} label={leg.cargo_status?.replace(/_/g,' ')}/>
                  <Btn size='sm' variant='ghost' onClick={()=>openEditLeg(leg)}>Edit</Btn>
                  <Btn size='sm' variant='ghost' onClick={()=>setConfirmDelete(leg)} style={{color:C.danger}}>Remove</Btn>
                </div>
              </div>
              <div style={{padding:'10px 18px 0',display:'flex',gap:'24px',flexWrap:'wrap',fontSize:'13px',color:C.textSoft}}>
                {leg.dispatch_date&&<div><span style={{fontWeight:600}}>Dispatched:</span> {fmtDate(leg.dispatch_date)}</div>}
                {leg.delivery_date&&<div><span style={{fontWeight:600}}>Delivered:</span> {fmtDate(leg.delivery_date)}</div>}
                {leg.notes&&<div style={{color:C.textMuted}}>{leg.notes}</div>}
              </div>
              <div style={{padding:'0 18px'}}><LegPipeline pi={pi} inv={inv}/></div>
              <div style={{padding:'8px 18px 0',display:'flex',gap:'14px',flexWrap:'wrap',alignItems:'center'}}>
                <span style={{fontSize:'11px',color:C.textMuted,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.04em'}}>Generate:</span>
                {docBtn('PI',pi,'PI')}
                {docBtn('PO',po,'PO')}
                {docBtn('INVOICE',inv,'Invoice')}
              </div>
              <div style={{borderTop:`1px solid ${C.border}`,marginTop:'8px'}}>
                <button onClick={()=>toggleDocs(leg.id)} style={{width:'100%',padding:'8px 18px',background:'none',border:'none',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'space-between',fontSize:'12px',fontWeight:600,color:C.textSoft,fontFamily:'inherit'}}>
                  <span>📎 Documents</span>
                  <span style={{fontSize:'11px',color:C.textMuted,fontWeight:400}}>{docsOpen[leg.id]?'▲ Hide':'▼ Show'}</span>
                </button>
                {docsOpen[leg.id]&&<div style={{padding:'0 18px 14px'}}><DocumentChecklist legId={leg.id} entityId={leg.from_entity_id} entityName={leg.from_entity?.name||'General'} movementType={leg.leg_type||order.movement_type||'domestic'}/></div>}
              </div>
            </div>
          )
        })
      }

      <Modal open={editOrderModal} onClose={()=>setEditOrderModal(false)} title='Edit Order' width={560}>
        <div style={{display:'flex',flexDirection:'column',gap:'14px'}}>
          <FormRow label='Name' required><Input value={orderForm.name||''} onChange={e=>setOF('name',e.target.value)}/></FormRow>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px'}}>
            <FormRow label='Movement Type'><Select value={orderForm.movement_type||'domestic'} onChange={e=>setOF('movement_type',e.target.value)}>{MOVEMENT_TYPES.map(t=><option key={t} value={t}>{t}</option>)}</Select></FormRow>
            <FormRow label='Status'><Select value={orderForm.status||'open'} onChange={e=>setOF('status',e.target.value)}>{ORDER_STATUSES.map(s=><option key={s} value={s}>{s}</option>)}</Select></FormRow>
            <FormRow label='Origin Entity' hint={originEntityFrozen ? 'Locked to the only entity you have access to' : undefined}><Select value={orderForm.origin_entity_id||''} onChange={e=>setOF('origin_entity_id',e.target.value)} disabled={originEntityFrozen}><option value=''>Select</option>{accessEntities.map(e=><option key={e.id} value={e.id}>{e.short_name||e.name}</option>)}</Select></FormRow>
            <FormRow label='Destination Entity'><Select value={orderForm.destination_entity_id||''} onChange={e=>setOF('destination_entity_id',e.target.value)}><option value=''>Select</option>{entities.map(e=><option key={e.id} value={e.id}>{e.short_name||e.name}</option>)}</Select></FormRow>
          </div>
          <FormRow label='Notes'><Textarea value={orderForm.notes||''} onChange={e=>setOF('notes',e.target.value)} rows={2}/></FormRow>
          <div style={{display:'flex',justifyContent:'flex-end',gap:'10px',paddingTop:'8px',borderTop:`1px solid ${C.border}`}}>
            <Btn variant='ghost' onClick={()=>setEditOrderModal(false)}>Cancel</Btn>
            <Btn onClick={handleSaveOrder}>Save Changes</Btn>
          </div>
        </div>
      </Modal>

      <Modal open={legModal} onClose={()=>setLegModal(false)} title={editingLeg?'Edit Leg':'Add Leg'} width={540}>
        <div style={{display:'flex',flexDirection:'column',gap:'14px'}}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px'}}>
            <FormRow label='From Entity' required hint={originEntityFrozen ? 'Locked to the only entity you have access to' : undefined}><Select value={legForm.from_entity_id} onChange={e=>setLF('from_entity_id',e.target.value)} disabled={originEntityFrozen}><option value=''>Select</option>{accessEntities.map(e=><option key={e.id} value={e.id}>{e.short_name||e.name}</option>)}</Select></FormRow>
            <FormRow label='To Entity' required><Select value={legForm.to_entity_id} onChange={e=>setLF('to_entity_id',e.target.value)}><option value=''>Select</option>{entities.map(e=><option key={e.id} value={e.id}>{e.short_name||e.name}</option>)}</Select></FormRow>
            <FormRow label='Movement Status'><Select value={legForm.movement_status} onChange={e=>setLF('movement_status',e.target.value)}>{MOVEMENT_STATUSES.map(s=><option key={s} value={s}>{s}</option>)}</Select></FormRow>
            <FormRow label='Cargo Status'><Select value={legForm.cargo_status} onChange={e=>setLF('cargo_status',e.target.value)}>{CARGO_STATUSES.map(s=><option key={s} value={s}>{s.replace(/_/g,' ')}</option>)}</Select></FormRow>
            <FormRow label='Dispatch Date'><Input type='date' value={legForm.dispatch_date} onChange={e=>setLF('dispatch_date',e.target.value)}/></FormRow>
            <FormRow label='Delivery Date'><Input type='date' value={legForm.delivery_date} onChange={e=>setLF('delivery_date',e.target.value)}/></FormRow>
          </div>
          <FormRow label='Notes'><Textarea value={legForm.notes} onChange={e=>setLF('notes',e.target.value)} rows={2}/></FormRow>
          <div style={{display:'flex',justifyContent:'flex-end',gap:'10px',paddingTop:'8px',borderTop:`1px solid ${C.border}`}}>
            <Btn variant='ghost' onClick={()=>setLegModal(false)}>Cancel</Btn>
            <Btn onClick={handleSaveLeg} disabled={saving}>{saving?'Saving…':editingLeg?'Save Changes':'Add Leg'}</Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal open={!!confirmDelete} onClose={()=>setConfirmDelete(null)} onConfirm={handleDeleteLeg} title='Remove Leg' message={`Remove Leg ${confirmDelete?.leg_no}? This cannot be undone.`} danger/>
      {/* CHANGED: confirm modal for deleting the whole order */}
      <ConfirmModal open={confirmDeleteOrder} onClose={()=>setConfirmDeleteOrder(false)} onConfirm={handleDeleteOrder}
        title='Delete Order' message={`Delete "${order.name}"${order.order_no?' ('+order.order_no+')':''}? This cannot be undone.`} danger/>
      {toast&&<Toast message={toast.message} type={toast.type} onClose={()=>setToast(null)}/>}
    </div>
  )
}

export default function Orders() {
  return (
    <Routes>
      <Route index      element={<OrdersList/>}/>
      <Route path=':id' element={<OrderDetail/>}/>
    </Routes>
  )
}
