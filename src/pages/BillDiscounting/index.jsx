import { useState, useEffect, useCallback, useRef } from 'react'
import { Routes, Route, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, SectionDivider, StatCard,
} from '../../components/UI/index'
import { formatINR, toNum, roundRupees } from '../../utils/money'
import { downloadCSV } from '../../utils/csvTemplate'
import { fmtDate, today, currentFYLabel } from '../../utils/dates'
import DocumentAttachments from '../../components/DocumentAttachments'
import { useAuth } from '../../hooks/useAuth' // CHANGED: master-only delete, same convention as PI/PO/Invoices
import { useEntityAccess } from '../../hooks/useEntityAccess'

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveFY() {
  const label = currentFYLabel()
  const { data } = await supabase.from('financial_years').select('id,name,code').order('start_date',{ascending:false}).limit(5)
  return (data||[]).find(f=>f.name===label)||data?.[0]
}

function addDays(dateStr, days) {
  if (!dateStr || !days) return ''
  const d = new Date(dateStr)
  d.setDate(d.getDate() + parseInt(days))
  return d.toISOString().slice(0,10)
}

function todayStr() { return new Date().toISOString().slice(0,10) }

function daysBetween(a, b) { return Math.round((new Date(b)-new Date(a))/86400000) }

function isOverdue(ev) {
  if (!ev.maturity_date) return false
  return ev.maturity_date < todayStr() && !['repaid','recourse'].includes(ev.status)
}

function graceDaysLeft(ev, bank) {
  if (!ev.maturity_date || !bank?.grace_period_days) return null
  const graceEnd = addDays(ev.maturity_date, bank.grace_period_days)
  const t = todayStr()
  if (graceEnd < t) return -1
  return daysBetween(t, graceEnd)
}

// ─── Banks Master ─────────────────────────────────────────────────────────────

function BanksMaster({ onBack }) {
  const EMPTY = { name:'',short_name:'',bank_branch:'',account_no:'',ifsc_code:'',contact_name:'',contact_email:'',contact_phone:'',sanctioned_limit:'',base_rate:'',spread:'',processing_fee_pct:'',processing_fee_flat:'',recourse_type:'with_recourse',grace_period_days:'0',is_active:true,notes:'' }
  const [banks,setBanks]   = useState([])
  const [loading,setLoad]  = useState(true)
  const [modal,setModal]   = useState(false)
  const [editing,setEdit]  = useState(null)
  const [form,setForm]     = useState(EMPTY)
  const [saving,setSaving] = useState(false)
  const [util,setUtil]     = useState({})
  const [toast,setToast]   = useState(null)

  const load = useCallback(async () => {
    setLoad(true)
    const { data } = await supabase.from('banks').select('*').order('name')
    setBanks(data||[])
    setLoad(false)
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    supabase.from('bill_discounting_events').select('bank_id,net_proceeds,status')
      .in('status',['active','partially_repaid','overdue']).eq('is_deleted',false)
      .then(({ data }) => {
        const u={};(data||[]).forEach(e=>{ if(e.bank_id) u[e.bank_id]=(u[e.bank_id]||0)+(e.net_proceeds||0) });setUtil(u)
      })
  }, [banks])

  function sf(k,v) { setForm(f=>({...f,[k]:v})) }
  function openNew() { setEdit(null); setForm(EMPTY); setModal(true) }
  function openEdit(b) { setEdit(b); setForm({...b,sanctioned_limit:b.sanctioned_limit||'',base_rate:b.base_rate||'',spread:b.spread||'',processing_fee_pct:b.processing_fee_pct||'',processing_fee_flat:b.processing_fee_flat||'',grace_period_days:b.grace_period_days||'0'}); setModal(true) }

  async function save() {
    if (!form.name) return setToast({message:'Bank name required',type:'error'})
    setSaving(true)
    const p = { name:form.name.trim(),short_name:form.short_name||null,bank_branch:form.bank_branch||null,account_no:form.account_no||null,ifsc_code:form.ifsc_code||null,contact_name:form.contact_name||null,contact_email:form.contact_email||null,contact_phone:form.contact_phone||null,sanctioned_limit:toNum(form.sanctioned_limit)||0,base_rate:toNum(form.base_rate)||0,spread:toNum(form.spread)||0,processing_fee_pct:toNum(form.processing_fee_pct)||0,processing_fee_flat:toNum(form.processing_fee_flat)||0,recourse_type:form.recourse_type,grace_period_days:parseInt(form.grace_period_days)||0,is_active:form.is_active,notes:form.notes||null,updated_at:new Date().toISOString() }
    const { error } = editing ? await supabase.from('banks').update(p).eq('id',editing.id) : await supabase.from('banks').insert(p)
    setSaving(false)
    if (error) return setToast({message:error.message,type:'error'})
    setToast({message:editing?'Bank updated':'Bank added',type:'success'}); setModal(false); load()
  }

  return (
    <div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'20px'}}>
        <div style={{display:'flex',alignItems:'center',gap:'12px'}}>
          <Btn variant='ghost' onClick={onBack}>← Back</Btn>
          <div><div style={{fontSize:'18px',fontWeight:700,color:C.text}}>Banks / Financiers</div><div style={{fontSize:'13px',color:C.textMuted}}>Manage banks and NBFCs for bill discounting</div></div>
        </div>
        <Btn onClick={openNew}>+ Add Bank</Btn>
      </div>

      <div style={{display:'flex',flexDirection:'column',gap:'12px'}}>
        {loading ? <div style={{padding:'48px',textAlign:'center',color:C.textMuted}}>Loading…</div>
        : banks.length===0 ? <Card><EmptyState icon='🏦' title='No banks added' action={<Btn onClick={openNew}>+ Add Bank</Btn>}/></Card>
        : banks.map(b => {
          const used=util[b.id]||0, limit=(b.sanctioned_limit||0), pct=limit>0?Math.min(100,Math.round(used/limit*100)):0, avail=Math.max(0,limit-used)
          return (
            <Card key={b.id}>
              <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',flexWrap:'wrap',gap:'12px'}}>
                <div>
                  <div style={{display:'flex',alignItems:'center',gap:'10px',marginBottom:'4px'}}>
                    <span style={{fontSize:'15px',fontWeight:700}}>{b.name}</span>
                    {b.short_name&&<span style={{fontSize:'12px',color:C.textMuted}}>({b.short_name})</span>}
                    <Badge status={b.is_active?'active':'cancelled'} label={b.is_active?'Active':'Inactive'}/>
                    <Badge status={b.recourse_type==='with_recourse'?'pending':'domestic'} label={b.recourse_type==='with_recourse'?'With Recourse':'Non-Recourse'}/>
                  </div>
                  <div style={{fontSize:'12px',color:C.textSoft,display:'flex',gap:'16px',flexWrap:'wrap'}}>
                    {b.bank_branch&&<span>Branch: {b.bank_branch}</span>}
                    {b.account_no&&<span>A/C: <span style={{fontFamily:'monospace'}}>{b.account_no}</span></span>}
                    {b.contact_name&&<span>Contact: {b.contact_name}</span>}
                    {b.grace_period_days>0&&<span>Grace: {b.grace_period_days} days</span>}
                  </div>
                </div>
                <div style={{display:'flex',gap:'8px',alignItems:'center'}}>
                  <div style={{textAlign:'right',marginRight:'8px'}}>
                    <div style={{fontSize:'11px',color:C.textMuted,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.05em'}}>Effective Rate</div>
                    <div style={{fontSize:'18px',fontWeight:800,color:C.accent}}>{((b.base_rate||0)+(b.spread||0)).toFixed(2)}% p.a.</div>
                    <div style={{fontSize:'11px',color:C.textMuted}}>{b.base_rate||0}% base + {b.spread||0}% spread</div>
                  </div>
                  <Btn size='sm' variant='ghost' onClick={()=>openEdit(b)}>Edit</Btn>
                </div>
              </div>
              {limit>0&&(
                <div style={{marginTop:'14px'}}>
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:'12px',color:C.textMuted,marginBottom:'6px'}}>
                    <span>Credit Line Utilization</span>
                    <span>{formatINR(used)} of {formatINR(limit)} ({pct}%) · <span style={{color:avail>0?C.success:C.danger}}>{formatINR(avail)} available</span></span>
                  </div>
                  <div style={{height:8,background:C.border,borderRadius:4,overflow:'hidden'}}>
                    <div style={{height:'100%',width:`${pct}%`,background:pct>90?C.danger:pct>70?C.warning:C.success,borderRadius:4}}/>
                  </div>
                </div>
              )}
            </Card>
          )
        })}
      </div>

      <Modal open={modal} onClose={()=>setModal(false)} title={editing?`Edit — ${editing.name}`:'Add Bank / Financier'} width={680}>
        <div style={{display:'flex',flexDirection:'column',gap:'14px'}}>
          <SectionDivider label='Bank Details'/>
          <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:'12px'}}>
            <FormRow label='Bank / NBFC Name' required><Input value={form.name||''} onChange={e=>sf('name',e.target.value)} placeholder='e.g. HDFC Bank Ltd'/></FormRow>
            <FormRow label='Short Name'><Input value={form.short_name||''} onChange={e=>sf('short_name',e.target.value)} placeholder='HDFC'/></FormRow>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'12px'}}>
            <FormRow label='Branch'><Input value={form.bank_branch||''} onChange={e=>sf('bank_branch',e.target.value)}/></FormRow>
            <FormRow label='Account / Virtual A/C'><Input value={form.account_no||''} onChange={e=>sf('account_no',e.target.value)}/></FormRow>
            <FormRow label='IFSC Code'><Input value={form.ifsc_code||''} onChange={e=>sf('ifsc_code',e.target.value)}/></FormRow>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'12px'}}>
            <FormRow label='Contact Name'><Input value={form.contact_name||''} onChange={e=>sf('contact_name',e.target.value)}/></FormRow>
            <FormRow label='Contact Email'><Input value={form.contact_email||''} onChange={e=>sf('contact_email',e.target.value)}/></FormRow>
            <FormRow label='Contact Phone'><Input value={form.contact_phone||''} onChange={e=>sf('contact_phone',e.target.value)}/></FormRow>
          </div>
          <SectionDivider label='Rates & Limits'/>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'12px'}}>
            <FormRow label='Sanctioned Limit (₹)'><Input type='number' value={form.sanctioned_limit||''} onChange={e=>sf('sanctioned_limit',e.target.value)} placeholder='0'/></FormRow>
            <FormRow label='Base Rate (% p.a.)'><Input type='number' step='0.01' value={form.base_rate||''} onChange={e=>sf('base_rate',e.target.value)} placeholder='6.50'/></FormRow>
            <FormRow label='Spread (% p.a.)'><Input type='number' step='0.01' value={form.spread||''} onChange={e=>sf('spread',e.target.value)} placeholder='2.00'/></FormRow>
            <FormRow label='Processing Fee %'><Input type='number' step='0.01' value={form.processing_fee_pct||''} onChange={e=>sf('processing_fee_pct',e.target.value)} placeholder='0'/></FormRow>
            <FormRow label='Processing Fee Flat (₹)'><Input type='number' value={form.processing_fee_flat||''} onChange={e=>sf('processing_fee_flat',e.target.value)} placeholder='0'/></FormRow>
            <FormRow label='Grace Period (days)'><Input type='number' value={form.grace_period_days||'0'} onChange={e=>sf('grace_period_days',e.target.value)}/></FormRow>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px'}}>
            <FormRow label='Recourse Type'>
              <Select value={form.recourse_type||'with_recourse'} onChange={e=>sf('recourse_type',e.target.value)}>
                <option value='with_recourse'>With Recourse (you bear default risk)</option>
                <option value='non_recourse'>Non-Recourse (bank bears default risk)</option>
              </Select>
            </FormRow>
            <FormRow label='Status'>
              <Select value={form.is_active?'true':'false'} onChange={e=>sf('is_active',e.target.value==='true')}>
                <option value='true'>Active</option><option value='false'>Inactive</option>
              </Select>
            </FormRow>
          </div>
          <FormRow label='Notes'><Textarea value={form.notes||''} onChange={e=>sf('notes',e.target.value)} rows={2}/></FormRow>
          <div style={{display:'flex',justifyContent:'flex-end',gap:'10px',paddingTop:'8px',borderTop:`1px solid ${C.border}`}}>
            <Btn variant='ghost' onClick={()=>setModal(false)}>Cancel</Btn>
            <Btn onClick={save} disabled={saving}>{saving?'Saving…':editing?'Save Changes':'Add Bank'}</Btn>
          </div>
        </div>
      </Modal>
      {toast&&<Toast message={toast.message} type={toast.type} onClose={()=>setToast(null)}/>}
    </div>
  )
}

// ─── BD Dashboard ─────────────────────────────────────────────────────────────

function BDDashboard({ events, banks, onNewEvent }) {
  const today_str = todayStr()

  // ── Summary stats ──
  const active      = events.filter(e => e.status === 'active')
  const overdue     = events.filter(e => isOverdue(e))
  const partial     = events.filter(e => e.status === 'partially_repaid')
  const repaid      = events.filter(e => e.status === 'repaid')
  const totalNet    = events.reduce((s,e) => s + (e.net_proceeds||0), 0)
  const totalOut    = events.reduce((s,e) => s + (e.outstanding_amount||0), 0)
  const totalRepaid = events.reduce((s,e) => s + (e.repaid_amount||0), 0)

  // ── Upcoming maturities (next 30 days, not yet overdue) ──
  const upcoming = active.filter(e => {
    if (!e.maturity_date || isOverdue(e)) return false
    const d = daysBetween(today_str, e.maturity_date)
    return d >= 0 && d <= 30
  }).sort((a,b) => a.maturity_date.localeCompare(b.maturity_date))

  // ── Per-bank utilization ──
  const bankUtil = {}
  events.filter(e => e.bank_id && !['repaid','recourse'].includes(e.status)).forEach(e => {
    if (!bankUtil[e.bank_id]) bankUtil[e.bank_id] = { name: e.bank?.name || e.bank_name, outstanding: 0, events: 0 }
    bankUtil[e.bank_id].outstanding += (e.outstanding_amount || 0)
    bankUtil[e.bank_id].events++
  })
  const bankRows = Object.values(bankUtil).sort((a,b) => b.outstanding - a.outstanding)

  // ── Recent events (last 5) ──
  const recent = [...events].sort((a,b) => (b.discounting_date||'').localeCompare(a.discounting_date||'')).slice(0,5)

  const statStyle = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: '8px', padding: '16px' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* ── Overdue alerts ── */}
      {overdue.length > 0 && (
        <div style={{ padding: '14px 18px', background: '#fde8e8', border: `1px solid ${C.danger}`, borderRadius: '8px' }}>
          <div style={{ fontWeight: 700, color: C.danger, fontSize: '14px', marginBottom: '8px' }}>
            🚨 {overdue.length} Overdue Event{overdue.length > 1 ? 's' : ''} — Immediate Action Required
          </div>
          {overdue.map(e => {
            const gl = graceDaysLeft(e, e.bank)
            return (
              <div key={e.id} style={{ fontSize: '13px', color: C.danger, marginBottom: '4px', display: 'flex', gap: '16px' }}>
                <span style={{ fontWeight: 600 }}>{e.entity?.short_name || e.entity?.name}</span>
                <span>{e.bank?.name || e.bank_name}</span>
                <span>{formatINR(e.outstanding_amount)} outstanding</span>
                <span>Due: {fmtDate(e.maturity_date)}</span>
                {gl !== null && <span style={{ fontWeight: 700 }}>{gl < 0 ? '⚠️ Grace expired!' : `${gl}d grace left`}</span>}
              </div>
            )
          })}
        </div>
      )}

      {/* ── KPI row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: '12px' }}>
        {[
          ['Total Financed',    formatINR(totalNet),    C.accent],
          ['Outstanding',       formatINR(totalOut),    totalOut > 0 ? C.warning : C.success],
          ['Repaid',            formatINR(totalRepaid), C.success],
          ['Active Events',     active.length,          C.accent],
          ['Overdue',           overdue.length,         overdue.length > 0 ? C.danger : C.success],
          ['Banks Active',      bankRows.length,        C.textMid],
        ].map(([l,v,c]) => (
          <div key={l} style={statStyle}>
            <div style={{ fontSize: '11px', color: C.textMuted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>{l}</div>
            <div style={{ fontSize: '22px', fontWeight: 800, color: c, lineHeight: 1 }}>{typeof v === 'number' ? v : v}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>

        {/* ── Upcoming maturities ── */}
        <div>
          <div style={{ fontWeight: 700, fontSize: '14px', color: C.text, marginBottom: '10px' }}>
            ⏰ Upcoming Maturities <span style={{ fontWeight: 400, color: C.textMuted, fontSize: '13px' }}>(next 30 days)</span>
          </div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: '8px', overflow: 'hidden' }}>
            {upcoming.length === 0 ? (
              <div style={{ padding: '24px', textAlign: 'center', color: C.textMuted, fontSize: '13px' }}>No events maturing in next 30 days</div>
            ) : upcoming.map((e, i) => {
              const d = daysBetween(today_str, e.maturity_date)
              const color = d <= 3 ? C.danger : d <= 7 ? C.warning : C.text
              return (
                <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', borderBottom: i < upcoming.length-1 ? `1px solid ${C.border}` : 'none', background: i%2===0 ? C.surface : '#faf6ed' }}>
                  <div style={{ width: 36, height: 36, borderRadius: '8px', background: d <= 3 ? '#fde8e8' : d <= 7 ? '#fff3cd' : '#e8f3fd', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 800, color, flexShrink: 0 }}>
                    {d}d
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '13px', fontWeight: 600 }}>{e.entity?.short_name || e.entity?.name} — {e.bank?.name || e.bank_name}</div>
                    <div style={{ fontSize: '11px', color: C.textMuted }}>Matures {fmtDate(e.maturity_date)}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: C.danger }}>{formatINR(e.outstanding_amount)}</div>
                    <div style={{ fontSize: '11px', color: C.textMuted }}>outstanding</div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* ── Bank utilization ── */}
        <div>
          <div style={{ fontWeight: 700, fontSize: '14px', color: C.text, marginBottom: '10px' }}>🏦 Bank Utilization</div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: '8px', overflow: 'hidden' }}>
            {bankRows.length === 0 ? (
              <div style={{ padding: '24px', textAlign: 'center', color: C.textMuted, fontSize: '13px' }}>No active bank exposure</div>
            ) : bankRows.map((b, i) => {
              const bankMaster = banks.find(bk => bk.name === b.name)
              const limit = bankMaster?.sanctioned_limit || 0
              const pct   = limit > 0 ? Math.min(100, Math.round(b.outstanding / limit * 100)) : 0
              return (
                <div key={b.name} style={{ padding: '12px 14px', borderBottom: i < bankRows.length-1 ? `1px solid ${C.border}` : 'none' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <div>
                      <span style={{ fontWeight: 600, fontSize: '13px' }}>{b.name}</span>
                      <span style={{ fontSize: '11px', color: C.textMuted, marginLeft: '8px' }}>{b.events} event{b.events !== 1 ? 's' : ''}</span>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontWeight: 700, color: C.warning }}>{formatINR(b.outstanding)}</span>
                      {limit > 0 && <span style={{ fontSize: '11px', color: C.textMuted, marginLeft: '6px' }}>of {formatINR(limit)}</span>}
                    </div>
                  </div>
                  {limit > 0 && (
                    <div style={{ height: 6, background: C.border, borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: pct > 90 ? C.danger : pct > 70 ? C.warning : C.success, borderRadius: 3 }} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* ── Recent events ── */}
      <div>
        <div style={{ fontWeight: 700, fontSize: '14px', color: C.text, marginBottom: '10px' }}>Recent Events</div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: '8px', overflow: 'hidden' }}>
          {recent.length === 0 ? (
            <div style={{ padding: '24px', textAlign: 'center', color: C.textMuted, fontSize: '13px' }}>
              No events yet. <button onClick={onNewEvent} style={{ color: C.accent, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit' }}>+ Create first event</button>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr>{['Date','Entity','Bank','Net Proceeds','Outstanding','Maturity','Status'].map((h,i) => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: i >= 3 ? 'right' : 'left', fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.05em', background: C.bg, borderBottom: `1px solid ${C.border}` }}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {recent.map((e, ri) => (
                  <tr key={e.id} style={{ background: ri%2===0 ? C.surface : '#faf6ed' }}>
                    <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}` }}>{fmtDate(e.discounting_date)}</td>
                    <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>{e.entity?.short_name || e.entity?.name}</td>
                    <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}` }}>{e.bank?.short_name || e.bank_name}</td>
                    <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, textAlign: 'right', fontWeight: 600 }}>{formatINR(e.net_proceeds)}</td>
                    <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, textAlign: 'right', color: e.outstanding_amount > 0 ? C.warning : C.success, fontWeight: 600 }}>{formatINR(e.outstanding_amount)}</td>
                    <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, textAlign: 'right', color: isOverdue(e) ? C.danger : C.text }}>{e.maturity_date ? fmtDate(e.maturity_date) : '—'}</td>
                    <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}` }}><Badge status={isOverdue(e) && e.status==='active' ? 'overdue' : e.status} label={e.status==='partially_repaid'?'Partial':undefined}/></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── BD Reports ───────────────────────────────────────────────────────────────

function BDReports({ events, banks }) {
  const [reportType, setReportType] = useState('bank')   // 'bank' | 'entity' | 'repayments'
  const [bankFilter, setBankFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')

  // ── Per-bank report ──
  function bankReport() {
    const map = {}
    events.forEach(e => {
      const key = e.bank_id || e.bank_name
      const name = e.bank?.name || e.bank_name
      if (!map[key]) map[key] = { name, events: [], total_financed: 0, total_outstanding: 0, total_repaid: 0, count: 0 }
      map[key].events.push(e)
      map[key].total_financed   += e.net_proceeds || 0
      map[key].total_outstanding += e.outstanding_amount || 0
      map[key].total_repaid     += e.repaid_amount || 0
      map[key].count++
    })
    return Object.values(map).sort((a,b) => b.total_financed - a.total_financed)
  }

  // ── Per-entity report ──
  function entityReport() {
    const map = {}
    events.forEach(e => {
      const key = e.entity_id
      const name = e.entity?.short_name || e.entity?.name || '—'
      if (!map[key]) map[key] = { name, total_financed: 0, total_outstanding: 0, count: 0 }
      map[key].total_financed   += e.net_proceeds || 0
      map[key].total_outstanding += e.outstanding_amount || 0
      map[key].count++
    })
    return Object.values(map).sort((a,b) => b.total_financed - a.total_financed)
  }

  // ── Filtered events for list ──
  const filteredEvents = events.filter(e => {
    const mb = bankFilter === 'all' || e.bank_id === bankFilter || e.bank_name === bankFilter
    const ms = statusFilter === 'all' || e.status === statusFilter
    return mb && ms
  })

  function exportEvents() {
    downloadCSV(`bd_events_${todayStr()}.csv`,
      ['discounting_date','entity','bank','invoice_amount','net_proceeds','discount_rate','processing_fee','reserve_amount','outstanding_amount','repaid_amount','maturity_date','tenure_days','status','financier_ref_no','notes'],
      filteredEvents.map(e => ({
        discounting_date: e.discounting_date || '',
        entity:           e.entity?.name || '',
        bank:             e.bank?.name || e.bank_name || '',
        invoice_amount:   Math.round((e.invoice_amount||0)/100),
        net_proceeds:     Math.round((e.net_proceeds||0)/100),
        discount_rate:    e.discount_rate || e.applied_rate || '',
        processing_fee:   Math.round((e.processing_fee||0)/100),
        reserve_amount:   Math.round((e.reserve_amount||0)/100),
        outstanding_amount: Math.round((e.outstanding_amount||0)/100),
        repaid_amount:    Math.round((e.repaid_amount||0)/100),
        maturity_date:    e.maturity_date || '',
        tenure_days:      e.tenure_days || '',
        status:           e.status || '',
        financier_ref_no: e.financier_ref_no || '',
        notes:            e.notes || '',
      }))
    )
  }

  const bkReport  = bankReport()
  const entReport = entityReport()
  const th = { padding: '8px 12px', textAlign: 'left', fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.05em', background: C.bg, borderBottom: `1px solid ${C.border}` }
  const td = (right) => ({ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, textAlign: right ? 'right' : 'left' })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Report type selector */}
      <div style={{ display: 'flex', gap: '4px', borderBottom: `1px solid ${C.border}`, paddingBottom: '0' }}>
        {[['bank','By Bank'],['entity','By Entity'],['events','All Events']].map(([k,l]) => (
          <button key={k} onClick={() => setReportType(k)} style={{ padding: '6px 16px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: reportType===k?700:500, fontSize: '13px', color: reportType===k?C.text:C.textSoft, background: 'transparent', borderBottom: reportType===k?`2px solid ${C.accent}`:'2px solid transparent', marginBottom: '-1px' }}>{l}</button>
        ))}
      </div>

      {/* ── By Bank ── */}
      {reportType === 'bank' && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: '8px', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr>{['Bank','Events','Total Financed','Total Repaid','Outstanding','Utilization'].map((h,i)=>(
                <th key={h} style={{ ...th, textAlign: i>=1?'right':'left' }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {bkReport.map((b, ri) => {
                const bm    = banks.find(bk => bk.name === b.name)
                const limit = bm?.sanctioned_limit || 0
                const pct   = limit > 0 ? Math.min(100, Math.round(b.total_outstanding / limit * 100)) : null
                return (
                  <tr key={b.name} style={{ background: ri%2===0?C.surface:'#faf6ed' }}>
                    <td style={td(false)}><span style={{ fontWeight: 600 }}>{b.name}</span></td>
                    <td style={td(true)}>{b.count}</td>
                    <td style={td(true)}>{formatINR(b.total_financed)}</td>
                    <td style={td(true)}>{formatINR(b.total_repaid)}</td>
                    <td style={{ ...td(true), fontWeight: 700, color: b.total_outstanding > 0 ? C.warning : C.success }}>{formatINR(b.total_outstanding)}</td>
                    <td style={td(true)}>
                      {pct !== null ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'flex-end' }}>
                          <span style={{ fontSize: '12px', fontWeight: 600, color: pct > 90 ? C.danger : pct > 70 ? C.warning : C.success }}>{pct}%</span>
                          <div style={{ width: 60, height: 6, background: C.border, borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${pct}%`, background: pct > 90 ? C.danger : pct > 70 ? C.warning : C.success, borderRadius: 3 }} />
                          </div>
                        </div>
                      ) : <span style={{ color: C.textMuted, fontSize: '12px' }}>No limit set</span>}
                    </td>
                  </tr>
                )
              })}
              {bkReport.length === 0 && <tr><td colSpan={6} style={{ padding: '32px', textAlign: 'center', color: C.textMuted }}>No data</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* ── By Entity ── */}
      {reportType === 'entity' && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: '8px', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr>{['Entity','Events','Total Financed','Outstanding'].map((h,i)=>(
                <th key={h} style={{ ...th, textAlign: i>=1?'right':'left' }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {entReport.map((e, ri) => (
                <tr key={e.name} style={{ background: ri%2===0?C.surface:'#faf6ed' }}>
                  <td style={td(false)}><span style={{ fontWeight: 600 }}>{e.name}</span></td>
                  <td style={td(true)}>{e.count}</td>
                  <td style={td(true)}>{formatINR(e.total_financed)}</td>
                  <td style={{ ...td(true), fontWeight: 700, color: e.total_outstanding > 0 ? C.warning : C.success }}>{formatINR(e.total_outstanding)}</td>
                </tr>
              ))}
              {entReport.length === 0 && <tr><td colSpan={4} style={{ padding: '32px', textAlign: 'center', color: C.textMuted }}>No data</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* ── All Events (filterable + exportable) ── */}
      {reportType === 'events' && (
        <>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={bankFilter} onChange={e => setBankFilter(e.target.value)} style={{ padding: '7px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', fontFamily: 'inherit', outline: 'none' }}>
              <option value='all'>All banks</option>
              {banks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ padding: '7px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', fontFamily: 'inherit', outline: 'none' }}>
              <option value='all'>All statuses</option>
              {['active','partially_repaid','repaid','overdue','recourse'].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <button onClick={exportEvents} style={{ padding: '7px 16px', borderRadius: '6px', border: `1px solid ${C.border}`, background: C.surface, fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', color: C.textMid }}>↓ Export CSV</button>
          </div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: '8px', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr>{['Date','Entity','Bank','Net Proceeds','Outstanding','Maturity','Rate','Status'].map((h,i)=>(
                  <th key={h} style={{ ...th, textAlign: i>=3?'right':'left' }}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {filteredEvents.map((e, ri) => (
                  <tr key={e.id} style={{ background: ri%2===0?C.surface:'#faf6ed' }}>
                    <td style={td(false)}>{fmtDate(e.discounting_date)}</td>
                    <td style={{ ...td(false), fontWeight: 600 }}>{e.entity?.short_name || e.entity?.name}</td>
                    <td style={td(false)}>{e.bank?.short_name || e.bank_name}</td>
                    <td style={td(true)}>{formatINR(e.net_proceeds)}</td>
                    <td style={{ ...td(true), fontWeight: 600, color: e.outstanding_amount > 0 ? C.warning : C.success }}>{formatINR(e.outstanding_amount)}</td>
                    <td style={{ ...td(true), color: isOverdue(e) ? C.danger : C.text }}>{e.maturity_date ? fmtDate(e.maturity_date) : '—'}</td>
                    <td style={td(true)}>{e.applied_rate || e.discount_rate ? `${e.applied_rate || e.discount_rate}%` : '—'}</td>
                    <td style={td(false)}><Badge status={isOverdue(e) && e.status==='active' ? 'overdue' : e.status} label={e.status==='partially_repaid'?'Partial':undefined}/></td>
                  </tr>
                ))}
                {filteredEvents.length === 0 && <tr><td colSpan={8} style={{ padding: '32px', textAlign: 'center', color: C.textMuted }}>No events</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Bill Discounting List ────────────────────────────────────────────────────

function BDList() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  // CHANGED: bulk + single delete, master-only, same convention as PI/PO/Invoices
  const canDelete = profile?.role === 'master'
  // CHANGED: bde_write is gated on has_entity_grant(entity_id) — a bill
  // discounting event belongs to one entity, no counterparty.
  const { entities: accessEntities, frozen: entityFrozen, defaultEntityId } = useEntityAccess()
  const [selected, setSelected] = useState(new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [view,setView]         = useState('list')      // 'list' | 'banks'
  const [tab,setTab]           = useState('dashboard') // 'dashboard' | 'events' | 'reports'
  const [events,setEvents]     = useState([])
  const [banks,setBanks]       = useState([])
  const [entities,setEntities] = useState([])
  const [invoices,setInvoices] = useState([])
  const [loading,setLoading]   = useState(true)
  const [sf,setSF]             = useState('all')
  const [modal,setModal]       = useState(false)
  const [form,setForm]         = useState({})
  const [selInv,setSelInv]     = useState([])
  const [saving,setSaving]     = useState(false)
  const [toast,setToast]       = useState(null)
  const csvRef                 = useRef(null)

  const EMPTY = { entity_id:'',bank_id:'',discounting_date:today(),tenure_days:'90',maturity_date:addDays(today(),'90'),discount_rate:'',processing_fee:'',reserve_amount:'0',financier_ref_no:'',notes:'' }

  // ── CSV Export ──
  function handleExport() {
    const rows = (sf === 'all' ? events : events.filter(e => sf === 'overdue' ? isOverdue(e) : e.status === sf))
    downloadCSV(`bill_discounting_${todayStr()}.csv`,
      ['discounting_date','entity','bank','invoice_amount','net_proceeds','discount_rate','processing_fee','reserve_amount','outstanding_amount','repaid_amount','maturity_date','tenure_days','status','financier_ref_no','notes'],
      rows.map(e => ({
        discounting_date:   e.discounting_date || '',
        entity:             e.entity?.name || '',
        bank:               e.bank?.name || e.bank_name || '',
        invoice_amount:     e.invoice_amount || 0,
        net_proceeds:       e.net_proceeds || 0,
        discount_rate:      e.applied_rate || e.discount_rate || '',
        processing_fee:     e.processing_fee || 0,
        reserve_amount:     e.reserve_amount || 0,
        outstanding_amount: e.outstanding_amount || 0,
        repaid_amount:      e.repaid_amount || 0,
        maturity_date:      e.maturity_date || '',
        tenure_days:        e.tenure_days || '',
        status:             e.status || '',
        financier_ref_no:   e.financier_ref_no || '',
        notes:              e.notes || '',
      }))
    )
  }

  // ── CSV Template ──
  function handleTemplate() {
    downloadCSV('bd_template.csv',
      ['discounting_date','entity_name','bank_name','invoice_amount','discount_rate','processing_fee','reserve_amount','maturity_date','tenure_days','notes'],
      [{ discounting_date:'2026-04-01', entity_name:'MVL', bank_name:'HDFC Bank', invoice_amount:500000, discount_rate:12.5, processing_fee:2500, reserve_amount:0, maturity_date:'2026-07-01', tenure_days:90, notes:'Sample event' }]
    )
  }

  // ── CSV Import ──
  async function handleImport(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const text = await file.text()
    const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    if (lines.length < 2) return setToast({ message: 'CSV is empty', type: 'error' })
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase())
    const rows    = lines.slice(1)
    let added = 0, errors = []
    const fy = await resolveFY()
    if (!fy) return setToast({ message: 'No financial year found', type: 'error' })
    for (let i = 0; i < rows.length; i++) {
      const cols = rows[i].split(',').map(c => c.trim())
      const row  = {}
      headers.forEach((h, j) => { row[h] = cols[j] || '' })
      const entity = entities.find(en => en.name.toLowerCase() === (row.entity_name||'').toLowerCase() || (en.short_name||'').toLowerCase() === (row.entity_name||'').toLowerCase())
      const bank   = banks.find(b => b.name.toLowerCase() === (row.bank_name||'').toLowerCase() || (b.short_name||'').toLowerCase() === (row.bank_name||'').toLowerCase())
      if (!entity) { errors.push(`Row ${i+2}: entity "${row.entity_name}" not found`); continue }
      if (!bank)   { errors.push(`Row ${i+2}: bank "${row.bank_name}" not found`); continue }
      if (!row.discounting_date || !row.maturity_date) { errors.push(`Row ${i+2}: dates required`); continue }
      const invAmt = Math.round(parseFloat(row.invoice_amount)||0)
      const procFee = Math.round(parseFloat(row.processing_fee)||0)
      const resAmt  = Math.round(parseFloat(row.reserve_amount)||0)
      const net     = Math.max(0, invAmt - procFee - resAmt)
      const { data:bdNo } = await supabase.rpc('next_bd_no', { ent_id: entity.id, fy_id: fy.id })
      const { error } = await supabase.from('bill_discounting_events').insert({
        entity_id: entity.id, bank_id: bank.id, bank_name: bank.name,
        discount_no: bdNo, financial_year_id: fy.id,
        invoice_amount: invAmt, discount_amount: procFee + resAmt,
        discount_rate: parseFloat(row.discount_rate)||null, applied_rate: parseFloat(row.discount_rate)||null,
        net_proceeds: net, outstanding_amount: net, processing_fee: procFee, reserve_amount: resAmt,
        discounting_date: row.discounting_date, maturity_date: row.maturity_date,
        tenure_days: parseInt(row.tenure_days)||null,
        notes: row.notes||null, status: 'active', is_deleted: false, repaid_amount: 0,
      })
      if (error) errors.push(`Row ${i+2}: ${error.message}`)
      else added++
    }
    setToast({ message: `Imported ${added} events${errors.length ? `, ${errors.length} errors` : ''}`, type: errors.length ? 'error' : 'success' })
    if (errors.length) console.warn('BD import errors:', errors)
    if (added) load()
  }

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data:evts },{ data:bs },{ data:es },{ data:invs }] = await Promise.all([
      supabase.from('bill_discounting_events').select('*, entity:entity_id(name,short_name), bank:bank_id(name,short_name,grace_period_days,recourse_type,account_no)').eq('is_deleted',false).order('discounting_date',{ascending:false}),
      supabase.from('banks').select('*').eq('is_active',true).order('name'),
      supabase.from('entities').select('id,name,short_name').eq('is_active',true).eq('is_deleted',false).order('name'),
      supabase.from('invoices').select('id,invoice_no,total_amount,outstanding_amount,seller_entity_id,seller:seller_entity_id(name,short_name)').eq('is_deleted',false).in('status',['submitted','partial']).order('invoice_date',{ascending:false}),
    ])
    setEvents(evts||[]); setBanks(bs||[]); setEntities(es||[]); setInvoices(invs||[])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function setF(k,v) {
    setForm(f => {
      const u={...f,[k]:v}
      if (k==='discounting_date'||k==='tenure_days') u.maturity_date=addDays(k==='discounting_date'?v:u.discounting_date, k==='tenure_days'?v:u.tenure_days)
      if (k==='bank_id'&&v) { const b=banks.find(x=>x.id===v); if(b){ u.discount_rate=((b.base_rate||0)+(b.spread||0)).toFixed(2); u.processing_fee=b.processing_fee_flat?String(b.processing_fee_flat):'' } }
      return u
    })
  }

  function toggleInv(inv) {
    setSelInv(p => p.find(r=>r.invoice_id===inv.id) ? p.filter(r=>r.invoice_id!==inv.id) : [...p,{invoice_id:inv.id,invoice_no:inv.invoice_no,amount:inv.outstanding_amount}])
  }

  const totalSel=selInv.reduce((s,r)=>s+(r.amount||0),0)
  const procFee=roundRupees(toNum(form.processing_fee))
  const resAmt=roundRupees(toNum(form.reserve_amount))
  const netProc=Math.max(0,totalSel-procFee-resAmt)

  async function handleSave() {
    if (!form.entity_id) return setToast({message:'Entity required',type:'error'})
    if (!form.bank_id)   return setToast({message:'Bank required',type:'error'})
    if (!selInv.length)  return setToast({message:'Select at least one invoice',type:'error'})
    if (!form.maturity_date) return setToast({message:'Maturity date required',type:'error'})

    // Credit limit check
    const bank=banks.find(b=>b.id===form.bank_id)
    if (bank?.sanctioned_limit>0) {
      const { data:active } = await supabase.from('bill_discounting_events').select('net_proceeds').eq('bank_id',form.bank_id).eq('is_deleted',false).in('status',['active','partially_repaid','overdue'])
      const used=(active||[]).reduce((s,e)=>s+(e.net_proceeds||0),0)
      if (netProc+used>bank.sanctioned_limit) return setToast({message:`Credit limit breach: would exceed ${formatINR(bank.sanctioned_limit)} sanctioned limit with ${bank.name}`,type:'error'})
    }

    // Anti-double-discounting
    for (const row of selInv) {
      const { data:linked } = await supabase.from('bill_discounting_invoices').select('event_id').eq('invoice_id',row.invoice_id)
      if (linked?.length) {
        const { data:active } = await supabase.from('bill_discounting_events').select('id').in('id',linked.map(l=>l.event_id)).eq('is_deleted',false).not('status','in','(repaid,recourse)')
        if (active?.length) return setToast({message:`Invoice ${row.invoice_no} is already in an active bill discounting event`,type:'error'})
      }
    }

    setSaving(true)
    const fy=await resolveFY()
    if (!fy) { setSaving(false); return setToast({message:'No financial year found',type:'error'}) }

    const payload = {
      entity_id:form.entity_id, bank_id:form.bank_id, bank_name:bank?.name||'',
      invoice_id:selInv.length===1?selInv[0].invoice_id:null,
      invoice_amount:totalSel, discount_amount:procFee+resAmt,
      discount_rate:toNum(form.discount_rate)||null, applied_rate:toNum(form.discount_rate)||null,
      net_proceeds:netProc, outstanding_amount:netProc,
      processing_fee:procFee, reserve_amount:resAmt,
      discounting_date:form.discounting_date, maturity_date:form.maturity_date,
      tenure_days:parseInt(form.tenure_days)||null,
      financier_ref_no:form.financier_ref_no||null,
      financial_year_id:fy.id, repaid_amount:0,
      status:'active', is_deleted:false, notes:form.notes||null,
    }

    const { data:bd,error } = await supabase.from('bill_discounting_events').insert(payload).select().single()
    if (error) { setSaving(false); return setToast({message:error.message,type:'error'}) }

    // Link all invoices
    await supabase.from('bill_discounting_invoices').insert(selInv.map(r=>({event_id:bd.id,invoice_id:r.invoice_id,invoice_amount:r.amount})))

    setSaving(false); setModal(false); setSelInv([])
    navigate(`/bill-discounting/${bd.id}`)
  }

  const entityInvoices=form.entity_id?invoices.filter(i=>i.seller_entity_id===form.entity_id):invoices

  if (view==='banks') return <BanksMaster onBack={()=>{setView('list');load()}}/>

  const filteredEvents = sf==='all' ? events : events.filter(e=>sf==='overdue'?isOverdue(e):e.status===sf)

  // CHANGED: multi-select + bulk soft-delete, same shape as PI/PO/Invoices
  function toggleSelect(id) {
    setSelected(s => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next })
  }
  function toggleSelectAll() {
    setSelected(s => s.size === filteredEvents.length ? new Set() : new Set(filteredEvents.map(e => e.id)))
  }
  async function handleBulkDelete() {
    setBulkDeleting(true)
    const { error } = await supabase.from('bill_discounting_events').update({ is_deleted: true }).in('id', [...selected])
    setBulkDeleting(false)
    setConfirmBulkDelete(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: `${selected.size} event(s) deleted`, type: 'success' })
    setSelected(new Set())
    load()
  }

  return (
    <div>
      <PageHeader title='Bill Discounting' subtitle='Invoice financing with banks and NBFCs'
        action={<div style={{display:'flex',gap:'8px',flexWrap:'wrap'}}>
          <Btn variant='ghost' onClick={handleTemplate}>↓ Template</Btn>
          <Btn variant='ghost' onClick={()=>csvRef.current?.click()}>↑ Import CSV</Btn>
          <input ref={csvRef} type='file' accept='.csv' style={{display:'none'}} onChange={handleImport}/>
          <Btn variant='ghost' onClick={handleExport}>↓ Export CSV</Btn>
          <Btn variant='ghost' onClick={()=>setView('banks')}>🏦 Banks</Btn>
          <Btn onClick={()=>{setForm({...EMPTY,entity_id:defaultEntityId});setSelInv([]);setModal(true)}}>+ New Event</Btn>
        </div>}
      />

      {/* Tabs */}
      <div style={{display:'flex',gap:'4px',marginBottom:'20px',borderBottom:`2px solid ${C.border}`}}>
        {[['dashboard','📊 Dashboard'],['events','📋 Events'],['reports','📈 Reports']].map(([k,l])=>(
          <button key={k} onClick={()=>setTab(k)} style={{padding:'7px 18px',border:'none',cursor:'pointer',fontFamily:'inherit',fontWeight:tab===k?700:500,fontSize:'13px',color:tab===k?C.text:C.textSoft,background:'transparent',borderBottom:tab===k?`2px solid ${C.accent}`:'2px solid transparent',marginBottom:'-2px'}}>{l}</button>
        ))}
      </div>

      {tab==='dashboard'&&(loading?<div style={{padding:'48px',textAlign:'center',color:C.textMuted}}>Loading…</div>:<BDDashboard events={events} banks={banks} onNewEvent={()=>{setForm({...EMPTY,entity_id:defaultEntityId});setSelInv([]);setModal(true)}}/>)}

      {tab==='events'&&(
        <>
          <div style={{display:'flex',gap:'4px',marginBottom:'16px',borderBottom:`1px solid ${C.border}`}}>
            {[['all','All'],['active','Active'],['overdue','Overdue'],['partially_repaid','Partial'],['repaid','Repaid'],['recourse','Recourse']].map(([k,l])=>(
              <button key={k} onClick={()=>setSF(k)} style={{padding:'6px 14px',border:'none',cursor:'pointer',fontFamily:'inherit',fontWeight:sf===k?700:500,fontSize:'13px',color:sf===k?C.text:C.textSoft,background:'transparent',borderBottom:sf===k?`2px solid ${C.accent}`:'2px solid transparent',marginBottom:'-1px'}}>{l}</button>
            ))}
          </div>
          {/* CHANGED: bulk-selection action bar, same pattern as PI/PO/Invoices */}
          {canDelete && selected.size > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fff3cc', border: '1px solid #e8d89a', borderRadius: '6px', padding: '8px 14px', marginBottom: '12px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600 }}>{selected.size} event{selected.size > 1 ? 's' : ''} selected</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <Btn size='sm' variant='ghost' onClick={() => setSelected(new Set())}>Clear</Btn>
                <Btn size='sm' variant='danger' onClick={() => setConfirmBulkDelete(true)} disabled={bulkDeleting}>{bulkDeleting ? 'Deleting…' : 'Delete Selected'}</Btn>
              </div>
            </div>
          )}
          <Card>
            {loading?<div style={{padding:'48px',textAlign:'center',color:C.textMuted}}>Loading…</div>:(
              <Table
                columns={[
                  ...(canDelete ? [{
                    label: <input type='checkbox' checked={filteredEvents.length>0 && selected.size===filteredEvents.length}
                      onChange={toggleSelectAll} onClick={e=>e.stopPropagation()} style={{width:'14px',height:'14px',cursor:'pointer'}}/>,
                    render: e => <input type='checkbox' checked={selected.has(e.id)}
                      onChange={()=>toggleSelect(e.id)} onClick={ev=>ev.stopPropagation()} style={{width:'14px',height:'14px',cursor:'pointer'}}/>,
                  }] : []),
                  {label:'S.No.', render:(row,idx)=><span style={{color:C.textMuted}}>{idx+1}</span>},
                  {label:'Date',   render:e=><span style={{fontSize:'12px'}}>{fmtDate(e.discounting_date)}</span>},
                  {label:'Entity', render:e=><span style={{fontSize:'12px',fontWeight:600}}>{e.entity?.short_name||e.entity?.name}</span>},
                  {label:'Bank',   render:e=><span style={{fontSize:'12px'}}>{e.bank?.short_name||e.bank_name}</span>},
                  {label:'Inv Amt',right:true,render:e=>formatINR(e.invoice_amount)},
                  {label:'Net Proceeds',right:true,render:e=><span style={{fontWeight:600}}>{formatINR(e.net_proceeds)}</span>},
                  {label:'Outstanding',right:true,render:e=><span style={{fontWeight:600,color:e.outstanding_amount>0?C.warning:C.success}}>{formatINR(e.outstanding_amount)}</span>},
                  {label:'Maturity',render:e=>{
                    const over=isOverdue(e),gl=over&&e.bank?graceDaysLeft(e,e.bank):null
                    return <div>
                      <div style={{fontSize:'12px',color:over?C.danger:C.text,fontWeight:over?700:400}}>{e.maturity_date?fmtDate(e.maturity_date):'—'}{over?' ⚠️':''}</div>
                      {gl!==null&&<div style={{fontSize:'10px',color:gl<0?C.danger:C.warning,fontWeight:700}}>{gl<0?'Grace expired!':`${gl}d grace left`}</div>}
                    </div>
                  }},
                  {label:'Rate',render:e=><span style={{fontSize:'12px',color:C.textSoft}}>{e.applied_rate||e.discount_rate?`${e.applied_rate||e.discount_rate}%`:'—'}</span>},
                  {label:'Status',render:e=><Badge status={isOverdue(e)&&e.status==='active'?'overdue':e.status} label={e.status==='partially_repaid'?'Partial':undefined}/>},
                  {label:'',render:e=><Btn size='sm' variant='ghost' onClick={()=>navigate(`/bill-discounting/${e.id}`)}>Open →</Btn>},
                ]}
                rows={filteredEvents}
                emptyState={<EmptyState icon='🏦' title='No events' action={<Btn onClick={()=>setModal(true)}>+ New Event</Btn>}/>}
              />
            )}
          </Card>
        </>
      )}

      {tab==='reports'&&(loading?<div style={{padding:'48px',textAlign:'center',color:C.textMuted}}>Loading…</div>:<BDReports events={events} banks={banks}/>)}

      <Modal open={modal} onClose={()=>setModal(false)} title='New Bill Discounting Event' width={700}>
        <div style={{display:'flex',flexDirection:'column',gap:'14px'}}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px'}}>
            <FormRow label='Entity' required hint={entityFrozen ? 'Locked to the only entity you have access to' : undefined}>
              <Select value={form.entity_id||''} onChange={e=>setF('entity_id',e.target.value)} disabled={entityFrozen}>
                <option value=''>Select entity…</option>
                {accessEntities.map(e=><option key={e.id} value={e.id}>{e.short_name||e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Bank / Financier' required>
              <Select value={form.bank_id||''} onChange={e=>setF('bank_id',e.target.value)}>
                <option value=''>Select bank…</option>
                {banks.map(b=><option key={b.id} value={b.id}>{b.name} — {((b.base_rate||0)+(b.spread||0)).toFixed(2)}% p.a.</option>)}
              </Select>
            </FormRow>
            <FormRow label='Discounting Date' required>
              <Input type='date' value={form.discounting_date||''} onChange={e=>setF('discounting_date',e.target.value)}/>
            </FormRow>
            <FormRow label='Tenure'>
              <Select value={form.tenure_days||'90'} onChange={e=>setF('tenure_days',e.target.value)}>
                {['30','45','60','75','90','120','180'].map(d=><option key={d} value={d}>{d} days</option>)}
              </Select>
            </FormRow>
            <FormRow label='Maturity Date (auto)'>
              <Input type='date' value={form.maturity_date||''} onChange={e=>setF('maturity_date',e.target.value)}/>
            </FormRow>
            <FormRow label='Rate % p.a.'>
              <Input type='number' step='0.01' value={form.discount_rate||''} onChange={e=>setF('discount_rate',e.target.value)} placeholder='Auto from bank'/>
            </FormRow>
            <FormRow label='Processing Fee (₹)'>
              <Input type='number' value={form.processing_fee||''} onChange={e=>setF('processing_fee',e.target.value)} placeholder='0'/>
            </FormRow>
            <FormRow label='Reserve Withheld (₹)'>
              <Input type='number' value={form.reserve_amount||''} onChange={e=>setF('reserve_amount',e.target.value)} placeholder='0'/>
            </FormRow>
            <FormRow label='Financier Reference No' style={{gridColumn:'1/-1'}}>
              <Input value={form.financier_ref_no||''} onChange={e=>setF('financier_ref_no',e.target.value)} placeholder="Bank's reference / transaction number"/>
            </FormRow>
          </div>

          <SectionDivider label='Select Invoices to Discount'/>
          {!form.entity_id ? <div style={{fontSize:'12px',color:C.textMuted,padding:'8px 0'}}>Select an entity first to see eligible invoices.</div>
          : entityInvoices.length===0 ? <div style={{fontSize:'12px',color:C.textMuted,padding:'8px 0'}}>No submitted invoices found for this entity.</div>
          : <div style={{maxHeight:200,overflowY:'auto',border:`1px solid ${C.border}`,borderRadius:'6px'}}>
              {entityInvoices.map(inv=>{
                const checked=!!selInv.find(r=>r.invoice_id===inv.id)
                return (
                  <div key={inv.id} onClick={()=>toggleInv(inv)} style={{display:'flex',alignItems:'center',gap:'12px',padding:'9px 14px',borderBottom:`1px solid ${C.border}`,cursor:'pointer',background:checked?'#e8f3fd':'transparent'}}>
                    <input type='checkbox' checked={checked} readOnly style={{flexShrink:0}}/>
                    <span style={{fontFamily:'monospace',fontSize:'12px',fontWeight:600,flex:1}}>{inv.invoice_no}</span>
                    <span style={{fontSize:'12px',color:C.textSoft}}>{inv.seller?.short_name||inv.seller?.name}</span>
                    <span style={{fontSize:'12px',fontWeight:600}}>{formatINR(inv.outstanding_amount)}</span>
                  </div>
                )
              })}
            </div>
          }

          {totalSel>0&&(
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:'10px',background:C.bg,border:`1px solid ${C.border}`,borderRadius:'6px',padding:'12px 14px'}}>
              {[['Invoice Total',formatINR(totalSel),C.text],['− Processing Fee',formatINR(procFee),C.warning],['− Reserve',formatINR(resAmt),C.warning],['Net Proceeds',formatINR(netProc),C.success]].map(([l,v,c])=>(
                <div key={l}><div style={{fontSize:'10px',color:C.textMuted,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.05em',marginBottom:'3px'}}>{l}</div><div style={{fontSize:l==='Net Proceeds'?'15px':'13px',fontWeight:l==='Net Proceeds'?800:600,color:c}}>{v}</div></div>
              ))}
            </div>
          )}

          <FormRow label='Notes'><Textarea value={form.notes||''} onChange={e=>setF('notes',e.target.value)} rows={2}/></FormRow>
          <div style={{display:'flex',justifyContent:'flex-end',gap:'10px',paddingTop:'8px',borderTop:`1px solid ${C.border}`}}>
            <Btn variant='ghost' onClick={()=>setModal(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving||!selInv.length}>{saving?'Creating…':'Create BD Event'}</Btn>
          </div>
        </div>
      </Modal>
      {/* CHANGED: bulk delete confirmation */}
      <ConfirmModal open={confirmBulkDelete} onClose={()=>setConfirmBulkDelete(false)} onConfirm={handleBulkDelete}
        title='Delete Events' message={`Delete ${selected.size} selected event(s)? This cannot be undone.`} danger/>
      {toast&&<Toast message={toast.message} type={toast.type} onClose={()=>setToast(null)}/>}
    </div>
  )
}

// ─── Bill Discounting Detail ──────────────────────────────────────────────────

function BDDetail() {
  const { id }=useParams(), navigate=useNavigate()
  const { profile } = useAuth()
  // CHANGED: master-only delete, same convention as PI/PO/Invoices detail pages
  const canDelete = profile?.role === 'master'
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [event,setEvent]     = useState(null)
  const [repays,setRepays]   = useState([])
  const [bdInvs,setBdInvs]   = useState([])
  const [loading,setLoading] = useState(true)
  const [repayM,setRepayM]   = useState(false)
  const [statM,setStatM]     = useState(false)
  const [rf,setRF_]          = useState({repayment_date:today(),amount:'',interest_amount:'0',payment_mode:'bank_transfer',reference_no:'',notes:''})
  const [saving,setSaving]   = useState(false)
  const [toast,setToast]     = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data:ev },{ data:rps },{ data:bdi }] = await Promise.all([
      supabase.from('bill_discounting_events').select('*, entity:entity_id(name,short_name), bank:bank_id(*)').eq('id',id).single(),
      supabase.from('bill_discounting_repayments').select('*').eq('event_id',id).order('repayment_date',{ascending:false}),
      supabase.from('bill_discounting_invoices').select('*, invoice:invoice_id(invoice_no,total_amount,outstanding_amount,status)').eq('event_id',id),
    ])
    setEvent(ev); setRepays(rps||[]); setBdInvs(bdi||[])
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  function srf(k,v) { setRF_(f=>({...f,[k]:v})) }

  async function handleRepayment() {
    const principal=roundRupees(toNum(rf.amount))
    if (!principal) return setToast({message:'Amount required',type:'error'})
    setSaving(true)
    const interest=roundRupees(toNum(rf.interest_amount))
    const { error } = await supabase.from('bill_discounting_repayments').insert({
      event_id:id, repayment_date:rf.repayment_date, amount:principal,
      interest_amount:interest, total_payment:principal+interest,
      payment_mode:rf.payment_mode, reference_no:rf.reference_no||null, notes:rf.notes||null,
    })
    if (error) { setSaving(false); return setToast({message:error.message,type:'error'}) }
    const newOut=Math.max(0,(event.outstanding_amount||0)-principal)
    const repaid=(event.repaid_amount||0)+principal
    const newStat=newOut===0?'repaid':repaid>0?'partially_repaid':'active'
    await supabase.from('bill_discounting_events').update({outstanding_amount:newOut,repaid_amount:repaid,status:newStat,updated_at:new Date()}).eq('id',id)
    setSaving(false); setToast({message:'Repayment recorded',type:'success'}); setRepayM(false)
    setRF_({repayment_date:today(),amount:'',interest_amount:'0',payment_mode:'bank_transfer',reference_no:'',notes:''})
    load()
  }

  async function updateStatus(s) {
    await supabase.from('bill_discounting_events').update({status:s,updated_at:new Date()}).eq('id',id)
    setToast({message:`Status → ${s}`,type:'success'}); setStatM(false); load()
  }
  // CHANGED: single-event soft delete
  async function handleDeleteEvent() {
    setDeleting(true)
    const { error } = await supabase.from('bill_discounting_events').update({ is_deleted: true }).eq('id', id)
    setDeleting(false); setConfirmDelete(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    navigate('/bill-discounting')
  }

  if (loading) return <div style={{padding:'48px',textAlign:'center',color:C.textMuted}}>Loading…</div>
  if (!event)  return <div style={{padding:'48px',textAlign:'center',color:C.danger}}>Event not found.</div>

  const over=isOverdue(event), gl=over?graceDaysLeft(event,event.bank):null
  const dtm=event.maturity_date?daysBetween(todayStr(),event.maturity_date):null
  const effSt=over&&event.status==='active'?'overdue':event.status

  return (
    <div>
      <button onClick={()=>navigate('/bill-discounting')} style={{background:'none',border:'none',color:C.textMuted,fontSize:'13px',cursor:'pointer',padding:0,fontFamily:'inherit',marginBottom:'4px'}}>← Bill Discounting</button>
      <PageHeader
        title={`${event.entity?.short_name||event.entity?.name} — ${event.bank?.name||event.bank_name}`}
        subtitle={`Discounted ${fmtDate(event.discounting_date)} · Matures ${fmtDate(event.maturity_date)}`}
        action={<div style={{display:'flex',gap:'8px',alignItems:'center'}}>
          {!['repaid','recourse'].includes(event.status)&&<Btn onClick={()=>{setRF_({repayment_date:today(),amount:'',interest_amount:'0',payment_mode:'bank_transfer',reference_no:'',notes:''});setRepayM(true)}}>+ Repayment</Btn>}
          {event.status!=='repaid'&&<Btn variant='ghost' onClick={()=>setStatM(true)}>Change Status</Btn>}
          {/* CHANGED: master-only event delete */}
          {canDelete&&<Btn variant='danger' onClick={()=>setConfirmDelete(true)} disabled={deleting}>{deleting?'Deleting…':'Delete'}</Btn>}
          <Badge status={effSt} label={effSt==='partially_repaid'?'Partial':undefined}/>
        </div>}
      />

      {over&&(
        <div style={{marginBottom:'16px',padding:'12px 16px',borderRadius:'6px',background:gl===null||gl>3?'#fff3cd':'#fde8e8',border:`1px solid ${gl===null||gl>3?'#f0d890':C.danger}`}}>
          <div style={{fontWeight:700,color:gl===null||gl>3?C.warning:C.danger,fontSize:'13px'}}>
            {gl===null?'⚠️ Overdue — no grace period configured with this bank'
            :gl<0    ?`🚨 Grace period expired — immediate recourse risk with ${event.bank?.name||event.bank_name}! Contact treasury now.`
            :gl===0  ?'🚨 Grace period ends today — contact bank immediately!'
            :         `⚠️ Overdue — ${gl} grace day${gl!==1?'s':''} remaining (${event.bank?.name||event.bank_name})`}
          </div>
          {event.bank?.recourse_type==='with_recourse'&&<div style={{fontSize:'12px',color:C.textSoft,marginTop:'4px'}}>With-Recourse facility: bank may auto-debit your account after grace period.</div>}
        </div>
      )}

      {!over&&dtm!==null&&dtm<=10&&!['repaid','recourse'].includes(event.status)&&(
        <div style={{marginBottom:'16px',padding:'12px 16px',borderRadius:'6px',background:'#fef6e4',border:'1px solid #f0d890'}}>
          <div style={{fontWeight:700,color:C.warning,fontSize:'13px'}}>
            ⏰ Matures in {dtm} day{dtm!==1?'s':''} — ensure buyer routes payment to {event.bank?.name||event.bank_name}{event.bank?.account_no&&<span style={{fontFamily:'monospace',marginLeft:6}}>A/C: {event.bank.account_no}</span>}
          </div>
        </div>
      )}

      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(130px,1fr))',gap:'12px',marginBottom:'24px'}}>
        <StatCard label='Invoice Amount'  value={formatINR(event.invoice_amount)}/>
        <StatCard label='Discount / Fees' value={formatINR(event.discount_amount||0)} color={C.warning}/>
        <StatCard label='Net Proceeds'    value={formatINR(event.net_proceeds)} color={C.success}/>
        <StatCard label='Repaid'          value={formatINR(event.repaid_amount||0)} color={C.info}/>
        <StatCard label='Outstanding'     value={formatINR(event.outstanding_amount)} color={event.outstanding_amount>0?C.danger:C.success}/>
        {(event.applied_rate||event.discount_rate)&&<StatCard label='Rate p.a.' value={`${event.applied_rate||event.discount_rate}%`}/>}
        {event.tenure_days&&<StatCard label='Tenure' value={`${event.tenure_days}d`}/>}
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'16px',marginBottom:'20px'}}>
        <Card>
          <div style={{padding:'12px 14px',borderBottom:`1px solid ${C.border}`,fontWeight:700,fontSize:'13px',color:C.textMid}}>Bank Details</div>
          <div style={{padding:'14px',fontSize:'13px',display:'flex',flexDirection:'column',gap:'6px'}}>
            <div><span style={{color:C.textMuted}}>Bank: </span><strong>{event.bank?.name||event.bank_name}</strong></div>
            {event.bank?.bank_branch&&<div><span style={{color:C.textMuted}}>Branch: </span>{event.bank.bank_branch}</div>}
            {event.bank?.account_no&&<div><span style={{color:C.textMuted}}>A/C No: </span><span style={{fontFamily:'monospace',fontWeight:600}}>{event.bank.account_no}</span></div>}
            {event.bank?.ifsc_code&&<div><span style={{color:C.textMuted}}>IFSC: </span><span style={{fontFamily:'monospace'}}>{event.bank.ifsc_code}</span></div>}
            {event.bank?.contact_name&&<div><span style={{color:C.textMuted}}>Contact: </span>{event.bank.contact_name}{event.bank.contact_phone&&` · ${event.bank.contact_phone}`}</div>}
            {event.bank?.recourse_type&&<div><span style={{color:C.textMuted}}>Recourse: </span><Badge status={event.bank.recourse_type==='with_recourse'?'pending':'domestic'} label={event.bank.recourse_type==='with_recourse'?'With Recourse':'Non-Recourse'}/></div>}
            {event.bank?.grace_period_days>0&&<div><span style={{color:C.textMuted}}>Grace Period: </span>{event.bank.grace_period_days} days</div>}
            {event.financier_ref_no&&<div><span style={{color:C.textMuted}}>Financier Ref: </span><span style={{fontFamily:'monospace'}}>{event.financier_ref_no}</span></div>}
          </div>
        </Card>
        <Card>
          <div style={{padding:'12px 14px',borderBottom:`1px solid ${C.border}`,fontWeight:700,fontSize:'13px',color:C.textMid}}>Event Info</div>
          <div style={{padding:'14px',fontSize:'13px',display:'flex',flexDirection:'column',gap:'6px'}}>
            <div><span style={{color:C.textMuted}}>Entity: </span><strong>{event.entity?.short_name||event.entity?.name}</strong></div>
            <div><span style={{color:C.textMuted}}>Discounting Date: </span>{fmtDate(event.discounting_date)}</div>
            <div><span style={{color:C.textMuted}}>Maturity Date: </span><strong style={{color:over?C.danger:C.text}}>{fmtDate(event.maturity_date)}</strong></div>
            {event.tenure_days&&<div><span style={{color:C.textMuted}}>Tenure: </span>{event.tenure_days} days</div>}
            {event.notes&&<div style={{color:C.textSoft,fontStyle:'italic'}}>{event.notes}</div>}
          </div>
        </Card>
      </div>

      {bdInvs.length>0&&(
        <div style={{marginBottom:'20px'}}>
          <div style={{fontWeight:700,fontSize:'14px',marginBottom:'10px'}}>Discounted Invoices ({bdInvs.length})</div>
          <Card>
            <Table columns={[
              {label:'S.No.', render:(row,idx)=><span style={{color:C.textMuted}}>{idx+1}</span>},
              {label:'Invoice No',  render:r=><span style={{fontFamily:'monospace',fontWeight:600}}>{r.invoice?.invoice_no||'—'}</span>},
              {label:'Total Amt',   right:true,render:r=>formatINR(r.invoice?.total_amount)},
              {label:'Discounted',  right:true,render:r=><strong>{formatINR(r.invoice_amount)}</strong>},
              {label:'Inv Status',  render:r=><Badge status={r.invoice?.status}/>},
            ]} rows={bdInvs}/>
          </Card>
        </div>
      )}

      <div style={{marginBottom:'20px'}}>
        <div style={{fontWeight:700,fontSize:'14px',marginBottom:'10px'}}>Repayments ({repays.length})</div>
        <Card>
          {repays.length===0
            ? <EmptyState icon='💰' title='No repayments yet' action={!['repaid','recourse'].includes(event.status)?<Btn onClick={()=>setRepayM(true)}>+ Repayment</Btn>:undefined}/>
            : <Table columns={[
                {label:'S.No.',     render:(row,idx)=><span style={{color:C.textMuted}}>{idx+1}</span>},
                {label:'Date',      render:r=><span style={{fontSize:'12px'}}>{fmtDate(r.repayment_date)}</span>},
                {label:'Principal', right:true,render:r=>formatINR(r.amount)},
                {label:'Interest',  right:true,render:r=>formatINR(r.interest_amount||0)},
                {label:'Total',     right:true,render:r=><strong>{formatINR(r.total_payment||r.amount)}</strong>},
                {label:'Mode',      render:r=><span style={{fontSize:'12px',textTransform:'capitalize'}}>{(r.payment_mode||'').replace(/_/g,' ')}</span>},
                {label:'Ref No',    render:r=><span style={{fontSize:'11px',fontFamily:'monospace',color:C.textSoft}}>{r.reference_no||'—'}</span>},
              ]} rows={repays}/>
          }
        </Card>
      </div>

      <div style={{marginBottom:'20px'}}>
        <div style={{fontWeight:700,fontSize:'14px',marginBottom:'10px'}}>Documents</div>
        <DocumentAttachments sourceType='bill_discounting_events' sourceId={event.id} entityId={event.entity_id} entityName={event.entity?.name||'General'}/>
      </div>

      <Modal open={repayM} onClose={()=>setRepayM(false)} title='Record Repayment' width={500}>
        <div style={{display:'flex',flexDirection:'column',gap:'14px'}}>
          <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:'6px',padding:'10px 14px',fontSize:'13px',display:'flex',gap:'24px'}}>
            <span><span style={{color:C.textMuted}}>Outstanding: </span><strong>{formatINR(event.outstanding_amount)}</strong></span>
            <span><span style={{color:C.textMuted}}>Due: </span><strong style={{color:over?C.danger:C.text}}>{fmtDate(event.maturity_date)}</strong></span>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px'}}>
            <FormRow label='Date' required><Input type='date' value={rf.repayment_date} onChange={e=>srf('repayment_date',e.target.value)}/></FormRow>
            <FormRow label='Principal (₹)' required><Input type='number' value={rf.amount} onChange={e=>srf('amount',e.target.value)}/></FormRow>
            <FormRow label='Interest (₹)'><Input type='number' value={rf.interest_amount} onChange={e=>srf('interest_amount',e.target.value)}/></FormRow>
            <FormRow label='Payment Mode'>
              <Select value={rf.payment_mode} onChange={e=>srf('payment_mode',e.target.value)}>
                {['bank_transfer','rtgs','neft','cash','cheque','upi'].map(m=><option key={m} value={m}>{m.replace(/_/g,' ').toUpperCase()}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Reference No' style={{gridColumn:'1/-1'}}><Input value={rf.reference_no} onChange={e=>srf('reference_no',e.target.value)}/></FormRow>
          </div>
          {(toNum(rf.amount)>0||toNum(rf.interest_amount)>0)&&(
            <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:'6px',padding:'10px 14px',fontSize:'13px',display:'flex',justifyContent:'space-between'}}>
              <span style={{color:C.textMuted}}>Total Payment</span>
              <strong>{formatINR(roundRupees(toNum(rf.amount))+roundRupees(toNum(rf.interest_amount)))}</strong>
            </div>
          )}
          <FormRow label='Notes'><Textarea value={rf.notes} onChange={e=>srf('notes',e.target.value)} rows={2}/></FormRow>
          <div style={{display:'flex',justifyContent:'flex-end',gap:'10px',paddingTop:'8px',borderTop:`1px solid ${C.border}`}}>
            <Btn variant='ghost' onClick={()=>setRepayM(false)}>Cancel</Btn>
            <Btn onClick={handleRepayment} disabled={saving}>{saving?'Saving…':'Record Repayment'}</Btn>
          </div>
        </div>
      </Modal>

      <Modal open={statM} onClose={()=>setStatM(false)} title='Change Status' width={380}>
        <div style={{display:'flex',flexDirection:'column',gap:'8px',padding:'4px 0'}}>
          <div style={{fontSize:'13px',color:C.textSoft,marginBottom:'8px'}}>Current: <Badge status={effSt}/></div>
          {[['active','Mark Active',C.accent],['partially_repaid','Mark Partially Repaid',C.warning],['repaid','Mark Fully Repaid',C.success],['overdue','Mark Overdue',C.danger],['recourse','Mark Recourse Triggered',C.danger]]
            .filter(([s])=>s!==event.status)
            .map(([s,l,c])=>(
              <button key={s} onClick={()=>updateStatus(s)} style={{padding:'10px 16px',borderRadius:'6px',border:`1px solid ${C.border}`,background:C.surface,color:c,fontSize:'13px',fontWeight:600,cursor:'pointer',textAlign:'left',fontFamily:'inherit'}}>{l}</button>
            ))}
          <Btn variant='ghost' onClick={()=>setStatM(false)}>Cancel</Btn>
        </div>
      </Modal>
      {/* CHANGED: delete confirmation */}
      <ConfirmModal open={confirmDelete} onClose={()=>setConfirmDelete(false)} onConfirm={handleDeleteEvent}
        title='Delete Event' message='Delete this bill discounting event? This cannot be undone.' danger/>
      {toast&&<Toast message={toast.message} type={toast.type} onClose={()=>setToast(null)}/>}
    </div>
  )
}

// ─── Router ───────────────────────────────────────────────────────────────────
export default function BillDiscounting() {
  return (
    <Routes>
      <Route index      element={<BDList/>}/>
      <Route path=':id' element={<BDDetail/>}/>
    </Routes>
  )
}
