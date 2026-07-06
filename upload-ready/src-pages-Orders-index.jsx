import React, { useState, useEffect, useCallback } from 'react'
import { Routes, Route, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, FormRow, Input, Select, Textarea, SectionDivider, StatCard,
} from '../../components/UI/index'
import DocumentChecklist from '../../components/DocumentChecklist'
import { fmtDate, today, currentFYLabel } from '../../utils/dates'
import { formatINR } from '../../utils/money'
import { useAuth } from '../../hooks/useAuth' // CHANGED: needed for master-only delete, matches PI/PO/Invoices pattern

const MOVEMENT_TYPES    = ['domestic', 'export', 'blended']
const ORDER_STATUSES    = ['open', 'in_progress', 'completed', 'cancelled']
const CARGO_STATUSES    = ['awaiting_cargo','cargo_dispatched','cargo_received','ready_for_pi','ready_for_invoice','completed']
const MOVEMENT_STATUSES = ['pending','in_transit','delivered']

const EMPTY_ORDER = { name:'', movement_type:'domestic', status:'open', origin_entity_id:'', destination_entity_id:'', notes:'' }
const EMPTY_LEG   = { from_entity_id:'', to_entity_id:'', movement_status:'pending', cargo_status:'awaiting_cargo', dispatch_date:'', delivery_date:'', notes:'' }

// Resolve current FY — next_order_no takes ONLY fy_id (no ent_id)
async function resolveFY() {
  const label = currentFYLabel()
  const { data } = await supabase.from('financial_years').select('id,name,code').order('start_date',{ascending:false}).limit(5)
  return (data||[]).find(f=>f.name===label) || data?.[0]
}

function LegPipeline({ pi, inv }) {
  const stages = [
    { label:'Proforma Invoice', no:pi?.pi_no||null, status:pi?.status||null, amount:pi?.total_amount||0, stage:!pi?'pending':pi.status==='converted'?'done':'active' },
    { label:'Invoice', no:inv?.invoice_no||null, status:inv?.status||null, amount:inv?.total_amount||0, stage:!inv?'pending':inv.status==='paid'?'done':'active' },
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

function OrderSummaryTable({ legs, piMap, invMap }) {
  if (!legs.length) return null
  const en = e=>e?.short_name||e?.name||'—'
  const td = {padding:'8px 10px',borderBottom:`1px solid ${C.border}`}
  const th = {padding:'7px 10px',fontSize:'10px',fontWeight:700,color:C.textSoft,textTransform:'uppercase',letterSpacing:'0.05em',background:C.bg,borderBottom:`1px solid ${C.border}`,borderTop:`1px solid ${C.border}`,whiteSpace:'nowrap'}
  return (
    <div style={{overflowX:'auto'}}>
      <table style={{width:'100%',borderCollapse:'collapse',fontSize:'12px',whiteSpace:'nowrap'}}>
        <thead>
          <tr>
            <th style={th}>Leg</th><th style={th}>Route</th><th style={th}>PI No</th><th style={th}>PI Status</th>
            <th style={th}>Invoice No</th><th style={th}>Inv Date</th>
            <th style={{...th,textAlign:'right'}}>PI Value</th>
            <th style={{...th,textAlign:'right'}}>Inv Value</th>
            <th style={{...th,textAlign:'right'}}>Margin</th>
            <th style={th}>Inv Status</th><th style={th}>Movement</th>
            <th style={{...th,textAlign:'right'}}>Payment</th>
          </tr>
        </thead>
        <tbody>
          {legs.map((leg,ri)=>{
            const pi=piMap[leg.id], inv=invMap[leg.id]
            const payStatus=!inv?'—':inv.status==='paid'?'Paid':inv.status==='partial'?'Partial':inv.outstanding_amount>0?'Outstanding':'—'
            const payColor=payStatus==='Paid'?C.success:payStatus==='Partial'?C.warning:payStatus==='Outstanding'?C.danger:C.textMuted
            const piTax=pi?.taxable_amount||0, invTax=inv?.taxable_amount||0
            const margin=piTax>0&&invTax>0?((invTax-piTax)/piTax*100):null
            return (
              <tr key={leg.id} style={{background:ri%2===0?C.surface:'#faf6ed'}}>
                <td style={td}><div style={{width:22,height:22,borderRadius:'50%',background:C.accent,color:'#f5f0e8',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'11px',fontWeight:700}}>{leg.leg_no}</div></td>
                <td style={td}><span style={{fontWeight:600}}>{en(leg.from_entity)}</span><span style={{color:C.textMuted,margin:'0 4px'}}>→</span><span style={{fontWeight:600}}>{en(leg.to_entity)}</span></td>
                <td style={{...td,fontFamily:'monospace'}}>{pi?.pi_no||<span style={{color:C.textMuted}}>—</span>}</td>
                <td style={td}>{pi?<Badge status={pi.status}/>:<span style={{color:C.textMuted,fontSize:'11px'}}>No PI</span>}</td>
                <td style={{...td,fontFamily:'monospace'}}>{inv?.invoice_no||<span style={{color:C.textMuted}}>—</span>}</td>
                <td style={{...td,color:C.textSoft}}>{inv?fmtDate(inv.invoice_date):'—'}</td>
                <td style={{...td,textAlign:'right',fontVariantNumeric:'tabular-nums'}}>{pi?.total_amount>0?formatINR(pi.total_amount):'—'}</td>
                <td style={{...td,textAlign:'right',fontWeight:600,fontVariantNumeric:'tabular-nums'}}>{inv?.total_amount>0?formatINR(inv.total_amount):'—'}</td>
                <td style={{...td,textAlign:'right',fontWeight:700,color:margin===null?C.textMuted:margin>=0?'#1a5c30':C.danger}}>{margin!==null?`${margin>=0?'+':''}${margin.toFixed(1)}%`:'—'}</td>
                <td style={td}>{inv?<Badge status={inv.status}/>:<span style={{color:C.textMuted,fontSize:'11px'}}>—</span>}</td>
                <td style={td}><Badge status={leg.movement_status}/></td>
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
  const canDelete = profile?.role === 'master'
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
  const [expandedRow, setExpandedRow] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: os }, { data: es }] = await Promise.all([
      supabase.from('orders').select('*, origin:origin_entity_id(name,short_name), destination:destination_entity_id(name,short_name), financial_years(name)').eq('is_deleted',false).order('created_at',{ascending:false}),
      supabase.from('entities').select('id,name,short_name,state_code').eq('is_active',true).eq('is_deleted',false).order('name'),
    ])
    setOrders(os||[]); setEntities(es||[]); setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  function setF(k,v) { setForm(f=>({...f,[k]:v})) }

  async function handleSave() {
    if (!form.name.trim()) return setToast({message:'Order name is required',type:'error'})
    setSaving(true)
    const fy = await resolveFY()
    if (!fy) { setSaving(false); return setToast({message:'No financial year found in DB',type:'error'}) }
    // next_order_no takes ONLY fy_id
    const { data: orderNo, error: noErr } = await supabase.rpc('next_order_no', { fy_id: fy.id })
    if (noErr) { setSaving(false); return setToast({message:'Could not generate order number: '+noErr.message,type:'error'}) }
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
      <PageHeader title='Orders' subtitle='Track every movement of goods end-to-end' action={<Btn onClick={()=>{setForm(EMPTY_ORDER);setModalOpen(true)}}>+ New Order</Btn>}/>
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
                {['Order','Type','From','To','FY','Status','Date',''].map((h,i)=>(
                <th key={i} style={{padding:'8px 12px',textAlign:i===7?'right':'left',fontSize:'11px',fontWeight:700,color:C.textSoft,textTransform:'uppercase',letterSpacing:'0.05em',background:C.bg,borderBottom:`1px solid ${C.border}`,borderTop:`1px solid ${C.border}`,whiteSpace:'nowrap'}}>{h}</th>
              ))}</tr></thead>
              <tbody>
                {filtered.length===0&&<tr><td colSpan={canDelete?9:8} style={{padding:'48px',textAlign:'center',color:C.textMuted}}>No orders found.</td></tr>}
                {filtered.map((o,ri)=>(
                  <React.Fragment key={o.id}>
                    <tr key={o.id} style={{background:ri%2===0?C.surface:'#faf6ed'}} onMouseEnter={e=>e.currentTarget.style.background='#f0e8d8'} onMouseLeave={e=>e.currentTarget.style.background=ri%2===0?C.surface:'#faf6ed'}>
                      {/* CHANGED: per-row checkbox */}
                      {canDelete && <td style={{padding:'9px 12px',borderBottom:expandedRow===o.id?'none':`1px solid ${C.border}`}} onClick={e=>e.stopPropagation()}>
                        <input type='checkbox' checked={selected.has(o.id)} onChange={()=>toggleSelect(o.id)} style={{width:'14px',height:'14px',cursor:'pointer'}}/>
                      </td>}
                      <td style={{padding:'9px 12px',borderBottom:expandedRow===o.id?'none':`1px solid ${C.border}`}}><div style={{fontWeight:600}}>{o.name}</div>{o.order_no&&<div style={{fontSize:'11px',color:C.textMuted,fontFamily:'monospace'}}>{o.order_no}</div>}</td>
                      <td style={{padding:'9px 12px',borderBottom:expandedRow===o.id?'none':`1px solid ${C.border}`}}><Badge status={o.movement_type}/></td>
                      <td style={{padding:'9px 12px',borderBottom:expandedRow===o.id?'none':`1px solid ${C.border}`,fontSize:'12px'}}>{en(o.origin)}</td>
                      <td style={{padding:'9px 12px',borderBottom:expandedRow===o.id?'none':`1px solid ${C.border}`,fontSize:'12px'}}>{en(o.destination)}</td>
                      <td style={{padding:'9px 12px',borderBottom:expandedRow===o.id?'none':`1px solid ${C.border}`,fontSize:'12px',color:C.textSoft}}>{o.financial_years?.name||'—'}</td>
                      <td style={{padding:'9px 12px',borderBottom:expandedRow===o.id?'none':`1px solid ${C.border}`}}><Badge status={o.status}/></td>
                      <td style={{padding:'9px 12px',borderBottom:expandedRow===o.id?'none':`1px solid ${C.border}`,fontSize:'12px',color:C.textSoft}}>{fmtDate(o.created_at)}</td>
                      <td style={{padding:'9px 12px',borderBottom:expandedRow===o.id?'none':`1px solid ${C.border}`,textAlign:'right'}}>
                        <div style={{display:'flex',gap:'6px',justifyContent:'flex-end'}} onClick={e=>e.stopPropagation()}>
                          <Btn size='sm' variant='ghost' onClick={()=>setExpandedRow(r=>r===o.id?null:o.id)}>{expandedRow===o.id?'▲':'▼'}</Btn>
                          <Btn size='sm' variant='primary' onClick={()=>navigate(`/orders/${o.id}`)}>Open →</Btn>
                        </div>
                      </td>
                    </tr>
                    {expandedRow===o.id&&(
                      <tr key={o.id+'-exp'}>
                        <td colSpan={canDelete?9:8} style={{padding:0,borderBottom:`1px solid ${C.border}`}}>
                          <div style={{padding:'14px 16px',background:'#f5f0e8',display:'flex',gap:'24px',alignItems:'flex-start',flexWrap:'wrap'}}>
                            <div style={{flex:1,minWidth:'200px'}}>
                              <div style={{fontSize:'11px',fontWeight:700,color:C.textMuted,textTransform:'uppercase',letterSpacing:'0.05em',marginBottom:'6px'}}>Order Details</div>
                              <div style={{fontSize:'13px',fontWeight:600,marginBottom:'2px'}}>{o.name}</div>
                              {o.order_no&&<div style={{fontSize:'11px',fontFamily:'monospace',color:C.textSoft,marginBottom:'4px'}}>{o.order_no}</div>}
                              <div style={{fontSize:'12px',color:C.textSoft}}>{en(o.origin)} → {en(o.destination)}</div>
                              {o.notes&&<div style={{fontSize:'12px',color:C.textMuted,marginTop:'4px',fontStyle:'italic'}}>{o.notes}</div>}
                            </div>
                            <div style={{flex:1,minWidth:'160px'}}>
                              <div style={{fontSize:'11px',fontWeight:700,color:C.textMuted,textTransform:'uppercase',letterSpacing:'0.05em',marginBottom:'6px'}}>Info</div>
                              <div style={{fontSize:'12px',color:C.textSoft,marginBottom:'3px'}}>FY: {o.financial_years?.name||'—'}</div>
                              <div style={{fontSize:'12px',color:C.textSoft,marginBottom:'3px'}}>Created: {fmtDate(o.created_at)}</div>
                              <div style={{display:'flex',gap:'6px',marginTop:'4px'}}><Badge status={o.movement_type}/><Badge status={o.status}/></div>
                            </div>
                            <div style={{flexShrink:0,display:'flex',flexDirection:'column',gap:'8px',justifyContent:'center'}}>
                              <Btn size='sm' variant='primary' onClick={()=>navigate(`/orders/${o.id}`)}>Open full order →</Btn>
                              <Btn size='sm' variant='ghost' onClick={()=>setExpandedRow(null)}>Close</Btn>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
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
            <FormRow label='Origin Entity'>
              <Select value={form.origin_entity_id} onChange={e=>setF('origin_entity_id',e.target.value)}>
                <option value=''>Select entity</option>{entities.map(e=><option key={e.id} value={e.id}>{e.short_name||e.name}</option>)}
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
  const canDelete = profile?.role === 'master'
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
  const [invMap, setInvMap]     = useState({})
  const [docsOpen, setDocsOpen] = useState({})

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
      const [{ data: piRows },{ data: invRows }] = await Promise.all([
        supabase.from('proforma_invoices').select('id,pi_no,status,total_amount,taxable_amount,leg_id,pi_date').in('leg_id',legIds).eq('is_deleted',false).order('created_at',{ascending:false}),
        supabase.from('invoices').select('id,invoice_no,status,total_amount,taxable_amount,outstanding_amount,leg_id,invoice_date').in('leg_id',legIds).eq('is_deleted',false).order('created_at',{ascending:false}),
      ])
      const pMap={}, iMap={}
      for (const pi of (piRows||[])){ if(!pMap[pi.leg_id]) pMap[pi.leg_id]=pi }
      for (const inv of (invRows||[])){ if(!iMap[inv.leg_id]) iMap[inv.leg_id]=inv }
      setPiMap(pMap); setInvMap(iMap)
    }
  }, [id])

  useEffect(() => { load() }, [load])
  function setLF(k,v){ setLegForm(f=>({...f,[k]:v})) }
  function setOF(k,v){ setOrderForm(f=>({...f,[k]:v})) }
  function toggleDocs(legId){ setDocsOpen(d=>({...d,[legId]:!d[legId]})) }
  function openNewLeg(){ setEditingLeg(null); setLegForm({...EMPTY_LEG}); setLegModal(true) }
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
    else { payload.leg_no=legs.length+1; const r=await supabase.from('order_legs').insert(payload); error=r.error }
    setSaving(false)
    if (error) return setToast({message:error.message,type:'error'})
    setToast({message:editingLeg?'Leg updated':'Leg added',type:'success'})
    setLegModal(false); load()
  }

  async function handleDeleteLeg(){ await supabase.from('order_legs').delete().eq('id',confirmDelete.id); setConfirmDelete(null); load() }
  async function handleSaveOrder(){
    const payload={...orderForm,updated_at:new Date()}
    if (!payload.origin_entity_id) delete payload.origin_entity_id
    if (!payload.destination_entity_id) delete payload.destination_entity_id
    await supabase.from('orders').update(payload).eq('id',id)
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
  const piVal=legs.reduce((s,l)=>s+(piMap[l.id]?.taxable_amount||0),0)
  const invVal=legs.reduce((s,l)=>s+(invMap[l.id]?.taxable_amount||0),0)
  const bm=piVal>0&&invVal>0?((invVal-piVal)/piVal*100):null

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
        {bm!==null&&<StatCard label='Blended Margin' value={<span style={{color:bm>=0?'#1a5c30':C.danger,fontWeight:700}}>{bm>=0?'+':''}{bm.toFixed(1)}%</span>}/>}
      </div>

      {legs.length>0&&(
        <div style={{marginBottom:'24px'}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'10px'}}>
            <div style={{fontWeight:700,fontSize:'14px',color:C.text}}>Order Summary</div>
            <span style={{fontSize:'11px',color:C.textMuted}}>Live — updates as PIs and Invoices are created</span>
          </div>
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:'8px',overflow:'hidden'}}>
            <OrderSummaryTable legs={legs} piMap={piMap} invMap={invMap}/>
          </div>
        </div>
      )}

      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'12px'}}>
        <div style={{fontWeight:700,fontSize:'14px',color:C.text}}>Order Legs</div>
        <Btn size='sm' onClick={openNewLeg}>+ Add Leg</Btn>
      </div>

      {legs.length===0
        ? <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:'8px'}}><EmptyState icon='↗' title='No legs yet' message='Add the first leg to this order.' action={<Btn onClick={openNewLeg}>+ Add Leg</Btn>}/></div>
        : legs.map(leg=>{
          const pi=piMap[leg.id], inv=invMap[leg.id]
          const legM=pi?.taxable_amount&&inv?.taxable_amount?((inv.taxable_amount-pi.taxable_amount)/pi.taxable_amount*100):null
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
            <FormRow label='Origin Entity'><Select value={orderForm.origin_entity_id||''} onChange={e=>setOF('origin_entity_id',e.target.value)}><option value=''>Select</option>{entities.map(e=><option key={e.id} value={e.id}>{e.short_name||e.name}</option>)}</Select></FormRow>
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
            <FormRow label='From Entity' required><Select value={legForm.from_entity_id} onChange={e=>setLF('from_entity_id',e.target.value)}><option value=''>Select</option>{entities.map(e=><option key={e.id} value={e.id}>{e.short_name||e.name}</option>)}</Select></FormRow>
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
