import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, SectionDivider, CsvFileDrop,
} from '../../components/UI/index'
import LineItemsEditor, { computeLine, computeTotals } from '../../components/LineItemsEditor'
import { formatINR, toNum } from '../../utils/money'
import { fmtDate, today, currentFYLabel } from '../../utils/dates'
import { buildHSNMap, resolveGSTRate } from '../../utils/hsn'
import DocumentAttachments from '../../components/DocumentAttachments'
import { calcSellRate } from '../../utils/margin'
import { downloadTemplate, downloadCSV, detectDelimiter } from '../../utils/csvTemplate'

const PI_STATUSES = ['draft', 'sent', 'accepted', 'converted', 'cancelled']

const EMPTY_FORM = {
  pi_date: today(), valid_upto: '', status: 'draft',
  from_entity_id: '', to_entity_id: '',
  order_id: '', order_leg_id: '',
  is_interstate: false, notes: '',
  bill_from: '', bill_to: '', ship_from: '', ship_to: '',
}


// Resolve current FY from DB
async function resolveFY() {
  const label = currentFYLabel()
  const { data } = await supabase.from('financial_years').select('id,name,code').order('start_date',{ascending:false}).limit(5)
  return (data||[]).find(f=>f.name===label)||data?.[0]
}

// Write planned stock movements on PI create
async function writeStockMovementsForPI(pi, lines) {
  if (!lines?.length) return
  const entries = []
  for (const l of lines) {
    if (!l.product_id||!Number(l.qty)) continue
    const date = pi.pi_date || today()
    entries.push({entity_id:pi.from_entity_id,product_id:l.product_id,posting_date:date,qty_in:0,qty_out:Number(l.qty),rate:Number(l.rate),voucher_type:'pi',voucher_id:pi.id,voucher_no:pi.pi_no||pi.id,notes:`PI outgoing — ${pi.pi_no||''}`})
    entries.push({entity_id:pi.to_entity_id,product_id:l.product_id,posting_date:date,qty_in:Number(l.qty),qty_out:0,rate:Number(l.rate),voucher_type:'pi',voucher_id:pi.id,voucher_no:pi.pi_no||pi.id,notes:`PI incoming — ${pi.pi_no||''}`})
  }
  if (entries.length) await supabase.from('stock_movements').insert(entries)
}

// ─── PI List ──────────────────────────────────────────────────────────────────
function PIList() {
  const navigate = useNavigate()
  const [pis, setPIs]           = useState([])
  const [entities, setEntities] = useState([])
  const [orders, setOrders]     = useState([])
  const [hsnMap, setHsnMap]     = useState(new Map())
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [statusFilter, setStatus] = useState('all')
  const [entityFilter, setEntityF] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm]         = useState(EMPTY_FORM)
  const [legs, setLegs]         = useState([])
  const [saving, setSaving]     = useState(false)
  const [toast, setToast]       = useState(null)
  const [csvModal, setCsvModal] = useState(false)
  const [csvText, setCsvText]   = useState('')
  const [csvResult, setCsvResult] = useState(null)
  const [csvSaving, setCsvSaving] = useState(false)
  const [stockMap, setStockMap] = useState({})
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [copyModal, setCopyModal]         = useState(false)
  const [prevPIs, setPrevPIs]             = useState([])
  const [copyPiId, setCopyPiId]           = useState('')
  const [copyMarginPct, setCopyMarginPct] = useState('5')

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: ps }, { data: es }, { data: os }, { data: hsnRows }, { data: stockRows }] = await Promise.all([
      supabase.from('proforma_invoices')
        .select('*, from_entity:from_entity_id(name,short_name), to_entity:to_entity_id(name,short_name), orders(name)')
        .eq('is_deleted', false).order('pi_date', { ascending: false }),
      supabase.from('entities').select('id,name,short_name,gstin,state_code').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('orders').select('id,name').eq('is_deleted', false).order('name'),
      supabase.from('hsn_master').select('*').eq('is_active', true),
      supabase.from('stock_opening_balance').select('product_id,qty'),
    ])
    setPIs(ps||[]); setEntities(es||[]); setOrders(os||[]); setHsnMap(buildHSNMap(hsnRows||[]))
    const sMap={}
    for (const r of (stockRows||[])) sMap[r.product_id]=(sMap[r.product_id]||0)+Number(r.qty)
    setStockMap(sMap)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function setF(k, v) {
    setForm(f => {
      const updated = { ...f, [k]: v }
      // auto-detect interstate when both entities set
      if (k === 'from_entity_id' || k === 'to_entity_id') {
        const fromId = k === 'from_entity_id' ? v : f.from_entity_id
        const toId   = k === 'to_entity_id'   ? v : f.to_entity_id
        const fromE  = entities.find(e => e.id === fromId)
        const toE    = entities.find(e => e.id === toId)
        if (fromE?.state_code && toE?.state_code)
          updated.is_interstate = fromE.state_code !== toE.state_code
      }
      return updated
    })
  }

  async function loadLegs(orderId) {
    if (!orderId) { setLegs([]); return }
    const { data } = await supabase.from('order_legs')
      .select('id, leg_no, from_entity:from_entity_id(name,short_name), to_entity:to_entity_id(name,short_name)')
      .eq('order_id', orderId).order('leg_no')
    setLegs(data || [])
  }

  const [piLines, setPILines] = useState([])

  async function handleSave() {
    if (!form.from_entity_id || !form.to_entity_id) return setToast({ message: 'From and To entity are required', type: 'error' })
    const totals = computeTotals(piLines.map(l => computeLine(l, form.is_interstate)))
    setSaving(true)
    const fy = await resolveFY()
    if (!fy) { setSaving(false); return setToast({ message: 'No financial year found', type: 'error' }) }
    const { data: piNo, error: noErr } = await supabase.rpc('next_pi_no', { ent_id: form.from_entity_id, fy_id: fy.id })
    if (noErr) { setSaving(false); return setToast({ message: 'Could not generate PI number: '+noErr.message, type: 'error' }) }
    const payload = { ...form, ...totals, pi_no: piNo, financial_year_id: fy.id }
    if (!payload.order_id)     delete payload.order_id
    if (!payload.order_leg_id) delete payload.order_leg_id
    if (!payload.valid_upto)   delete payload.valid_upto
    const { data: pi, error: piErr } = await supabase.from('proforma_invoices').insert(payload).select().single()
    if (piErr) { setSaving(false); return setToast({ message: piErr.message, type: 'error' }) }
    if (piLines.length > 0) {
      const linesPayload = piLines.map((l, i) => {
        const cl = computeLine(l, form.is_interstate)
        const { _id, _cost_rate, _margin_pct, _hsn_resolved_rate, _hsn_override, _hsn_manually_set, _hsn_source, ...rest } = cl
        return { ...rest, pi_id: pi.id, line_no: i + 1 }
      })
      const { error: lErr } = await supabase.from('proforma_invoice_lines').insert(linesPayload)
      if (lErr) { setSaving(false); return setToast({ message: lErr.message, type: 'error' }) }
      await writeStockMovementsForPI(pi, linesPayload)
    }
    setSaving(false)
    setToast({ message: 'PI created', type: 'success' })
    setModalOpen(false); setPILines([])
    navigate(`/pi/${pi.id}`)
  }


  async function openCopyModal() {
    let q = supabase.from('proforma_invoices').select('id,pi_no,pi_date,total_amount,from_entity:from_entity_id(name,short_name),to_entity:to_entity_id(name,short_name)').eq('is_deleted',false).order('pi_date',{ascending:false}).limit(60)
    if (form.order_id) q = q.eq('order_id', form.order_id)
    const { data } = await q
    setPrevPIs(data||[]); setCopyPiId(data?.[0]?.id||''); setCopyModal(true)
  }

  async function handleCopyLines() {
    if (!copyPiId) return
    const { data: srcLines } = await supabase.from('proforma_invoice_lines').select('*').eq('pi_id',copyPiId).order('line_no')
    if (!srcLines?.length) return setToast({message:'Source PI has no lines',type:'error'})
    const pct = parseFloat(copyMarginPct)||0
    const newLines = srcLines.map((l,i) => {
      const costRate = Number(l.rate)
      const newRate  = pct !== 0 ? calcSellRate(costRate, pct) : costRate
      let gstRate=l.gst_rate, hsnRes=null, hsnSrc='default'
      if (hsnMap && l.hsn_code) {
        const res = resolveGSTRate(l.hsn_code, newRate, hsnMap)
        if (res.gst_rate!==null){ gstRate=res.gst_rate; hsnRes=res.gst_rate; hsnSrc=res.source }
      }
      return computeLine({_id:Date.now()+i,line_no:i+1,product_id:l.product_id||'',description:l.description||'',hsn_code:l.hsn_code||'',qty:l.qty,unit:l.unit||'Nos',rate:newRate,gst_rate:gstRate,_cost_rate:costRate,_margin_pct:String(pct),_hsn_resolved_rate:hsnRes,_hsn_source:hsnSrc,_hsn_override:false,_hsn_manually_set:false}, form.is_interstate)
    })
    setPILines(newLines); setCopyModal(false)
    setToast({message:`${newLines.length} lines copied with ${pct}% margin. HSN re-evaluated.`,type:'success'})
  }

  const filtered = pis.filter(p => {
    const mdf = !dateFrom || p.pi_date >= dateFrom
    const mdt = !dateTo   || p.pi_date <= dateTo
    const ms  = !search || (p.pi_no || '').toLowerCase().includes(search.toLowerCase()) ||
      p.from_entity?.name?.toLowerCase().includes(search.toLowerCase()) ||
      p.to_entity?.name?.toLowerCase().includes(search.toLowerCase())
    const mst = statusFilter === 'all' || p.status === statusFilter
    const me  = !entityFilter || p.from_entity_id === entityFilter || p.to_entity_id === entityFilter
    return ms && mst && me && mdf && mdt
  })

  // ── CSV bulk upload ──────────────────────────────────────────────────────────
  // Format: pi_date,from_entity,to_entity,is_interstate,description,hsn_code,qty,unit,rate,gst_rate,valid_upto,notes
  // Multiple rows with same pi_date+from+to = grouped into one PI
  async function handleCSV() {
    setCsvSaving(true)
    const lines = csvText.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) { setCsvSaving(false); return setToast({ message: 'Need header + data rows', type: 'error' }) }
    const delim = detectDelimiter(lines[0])
    const header = lines[0].split(delim).map(h => h.trim().toLowerCase())
    let created = 0, errors = []

    // Group rows by pi_date+from_entity+to_entity
    const groups = {}
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(delim).map(c => c.trim())
      const row  = {}
      header.forEach((h, j) => { row[h] = cols[j] || '' })
      const key = `${row.pi_date}__${row.from_entity}__${row.to_entity}`
      if (!groups[key]) groups[key] = { meta: row, lines: [] }
      groups[key].lines.push(row)
    }

    for (const [key, group] of Object.entries(groups)) {
      const { meta, lines: gLines } = group
      const fromE = entities.find(e => e.short_name?.toLowerCase() === meta.from_entity?.toLowerCase() || e.name?.toLowerCase() === meta.from_entity?.toLowerCase())
      const toE   = entities.find(e => e.short_name?.toLowerCase() === meta.to_entity?.toLowerCase()   || e.name?.toLowerCase() === meta.to_entity?.toLowerCase())
      if (!fromE) { errors.push(`Row group ${meta.from_entity}: entity not found`); continue }
      if (!toE)   { errors.push(`Row group ${meta.to_entity}: entity not found`);   continue }

      const interstate = meta.is_interstate === 'true' || (fromE.state_code && toE.state_code && fromE.state_code !== toE.state_code)

      const piLines = gLines.map((r, i) => {
        const rate    = toNum(r.rate)
        const qty     = toNum(r.qty)
        const taxable = Math.round(qty * rate)
        const gstRate = toNum(r.gst_rate) || 18
        const half    = gstRate / 2
        const igst    = interstate ? Math.round(taxable * gstRate / 100) : 0
        const cgst    = !interstate ? Math.round(taxable * half / 100) : 0
        const sgst    = cgst
        return {
          line_no: i + 1, description: r.description, hsn_code: r.hsn_code,
          qty, unit: r.unit || 'Nos', rate, gst_rate: gstRate,
          taxable_amount: taxable,
          cgst_rate: half, cgst_amount: cgst,
          sgst_rate: half, sgst_amount: sgst,
          igst_rate: interstate ? gstRate : 0, igst_amount: igst,
          total_amount: taxable + igst + cgst + sgst,
        }
      })

      const totals = piLines.reduce((acc, l) => ({
        taxable_amount: acc.taxable_amount + l.taxable_amount,
        cgst_amount:    acc.cgst_amount    + l.cgst_amount,
        sgst_amount:    acc.sgst_amount    + l.sgst_amount,
        igst_amount:    acc.igst_amount    + l.igst_amount,
        total_amount:   acc.total_amount   + l.total_amount,
      }), { taxable_amount: 0, cgst_amount: 0, sgst_amount: 0, igst_amount: 0, total_amount: 0 })

      const { data: pi, error: piErr } = await supabase.from('proforma_invoices').insert({
        pi_date: meta.pi_date, from_entity_id: fromE.id, to_entity_id: toE.id,
        is_interstate: interstate, valid_upto: meta.valid_upto || null,
        notes: meta.notes || null, status: 'draft', ...totals,
      }).select().single()

      if (piErr) { errors.push(`PI ${meta.pi_date} ${meta.from_entity}→${meta.to_entity}: ${piErr.message}`); continue }

      const { error: lErr } = await supabase.from('proforma_invoice_lines')
        .insert(piLines.map(l => ({ ...l, pi_id: pi.id })))
      if (lErr) errors.push(`Lines for PI ${pi.id}: ${lErr.message}`)
      else created++
    }

    setCsvSaving(false)
    setCsvResult({ created, errors })
    load()
  }

  const columns = [
    { label: 'PI No', render: p => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{p.pi_no || '—'}</span> },
    { label: 'From → To', render: p => <span style={{ fontSize: '12px' }}>{p.from_entity?.short_name || p.from_entity?.name} → {p.to_entity?.short_name || p.to_entity?.name}</span> },
    { label: 'Date',   render: p => <span style={{ fontSize: '12px' }}>{fmtDate(p.pi_date)}</span> },
    { label: 'Order',  render: p => <span style={{ fontSize: '12px', color: C.textSoft }}>{p.orders?.name || '—'}</span> },
    { label: 'Tax',    render: p => <Badge status={p.is_interstate ? 'export' : 'domestic'} label={p.is_interstate ? 'Interstate (IGST)' : 'Local (CGST+SGST)'} /> },
    { label: 'Amount', right: true, render: p => <span style={{ fontWeight: 600 }}>{formatINR(p.total_amount)}</span> },
    { label: 'Status', render: p => <Badge status={p.status} /> },
  ]


  function handleExportCSV() {
    downloadCSV(`pi_export_${today()}.csv`,
      ['pi_no','pi_date','from_entity','to_entity','tax_type','status','taxable_amount','total_amount','order'],
      filtered.map(p=>({pi_no:p.pi_no||'',pi_date:p.pi_date,from_entity:p.from_entity?.name||'',to_entity:p.to_entity?.name||'',tax_type:p.is_interstate?'Interstate':'Local',status:p.status,taxable_amount:p.taxable_amount||0,total_amount:p.total_amount||0,order:p.orders?.name||''}))
    )
  }

  return (
    <div>
      <PageHeader
        title='Proforma Invoices'
        subtitle='Draft invoices raised before goods move'
        action={
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn variant='ghost' onClick={handleExportCSV}>↓ Export CSV</Btn>
            <Btn variant='ghost' onClick={() => { setCsvText(''); setCsvResult(null); setCsvModal(true) }}>↑ CSV Upload</Btn>
            <Btn onClick={() => { setForm(EMPTY_FORM); setPILines([]); setModalOpen(true) }}>+ New PI</Btn>
          </div>
        }
      />

      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder='Search PI no, entity…'
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', flex: 1, minWidth: '180px', fontFamily: 'inherit' }} />
        <select value={statusFilter} onChange={e => setStatus(e.target.value)}
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value='all'>All statuses</option>
          {PI_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={entityFilter} onChange={e => setEntityF(e.target.value)}
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value=''>All entities</option>
          {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
        </select>
        <input type='date' value={dateFrom} onChange={e=>setDateFrom(e.target.value)} style={{padding:'8px 10px',border:`1.5px solid ${C.border}`,borderRadius:'6px',background:C.surface,fontSize:'13px',outline:'none',fontFamily:'inherit'}} title='From date'/>
        <input type='date' value={dateTo} onChange={e=>setDateTo(e.target.value)} style={{padding:'8px 10px',border:`1.5px solid ${C.border}`,borderRadius:'6px',background:C.surface,fontSize:'13px',outline:'none',fontFamily:'inherit'}} title='To date'/>
        {(dateFrom||dateTo)&&<Btn size='sm' variant='ghost' onClick={()=>{setDateFrom('');setDateTo('')}}>Clear</Btn>}
      </div>

      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={filtered} onRowClick={p => navigate(`/pi/${p.id}`)}
              emptyState={<EmptyState icon='📄' title='No PIs yet' action={<Btn onClick={() => setModalOpen(true)}>+ New PI</Btn>} />} />
        }
      </Card>

      {/* CSV Upload Modal */}
      <Modal open={csvModal} onClose={() => setCsvModal(false)} title='Bulk Upload Proforma Invoices' width={680}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 14px', fontSize: '12px', color: C.textMid, lineHeight: 1.7 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
              <strong>CSV Format — one row per line item:</strong>
              <Btn size='sm' variant='ghost' onClick={() => downloadTemplate('pi')}>↓ Download Template</Btn>
            </div>
            <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>pi_date,from_entity,to_entity,is_interstate,description,hsn_code,qty,unit,rate,gst_rate,valid_upto,notes</code><br /><br />
            Multiple rows with the same <strong>pi_date + from_entity + to_entity</strong> are grouped into one PI automatically.
          </div>
          <FormRow label='Upload or Paste CSV'>
            <CsvFileDrop onText={setCsvText} />
          </FormRow>
          <textarea value={csvText} onChange={e => setCsvText(e.target.value)} rows={10} placeholder='Paste CSV data here…'
              style={{ padding: '8px 11px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: '#fffdf6', fontSize: '12px', fontFamily: 'monospace', width: '100%', boxSizing: 'border-box', resize: 'vertical', outline: 'none' }} />
          {csvResult && (
            <div style={{ background: csvResult.errors.length > 0 ? '#fff3cc' : '#e8f3ec', border: `1px solid ${csvResult.errors.length > 0 ? '#e6c040' : '#b8dfc8'}`, borderRadius: '6px', padding: '10px 14px', fontSize: '12px' }}>
              <strong>{csvResult.created} PIs created.</strong>
              {csvResult.errors.map((e, i) => <div key={i} style={{ color: '#7a5000', marginTop: '4px' }}>• {e}</div>)}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setCsvModal(false)}>Close</Btn>
            <Btn onClick={handleCSV} disabled={csvSaving || !csvText.trim()}>{csvSaving ? 'Uploading…' : 'Upload'}</Btn>
          </div>
        </div>
      </Modal>


      {/* Copy from previous leg PI */}
      <Modal open={copyModal} onClose={()=>setCopyModal(false)} title='Copy Lines from Previous Leg PI' width={640}>
        <div style={{display:'flex',flexDirection:'column',gap:'14px'}}>
          <div style={{background:'#fffbf0',border:`1px solid #e6c040`,borderRadius:'6px',padding:'10px 14px',fontSize:'12px',color:C.textMid}}>
            Lines are copied with the margin you specify. HSN rates are re-evaluated from the current master.
          </div>
          <FormRow label='Source PI'>
            <Select value={copyPiId} onChange={e=>setCopyPiId(e.target.value)}>
              <option value=''>Select a PI to copy from</option>
              {prevPIs.map(p=><option key={p.id} value={p.id}>{p.pi_no||p.id.slice(0,8)} — {p.from_entity?.short_name||p.from_entity?.name} → {p.to_entity?.short_name||p.to_entity?.name} · {fmtDate(p.pi_date)} · {formatINR(p.total_amount)}</option>)}
            </Select>
          </FormRow>
          <FormRow label='Margin %' hint='Positive or negative. Use 0 to copy at same rate.'>
            <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
              <Input type='text' inputMode='decimal' value={copyMarginPct} onChange={e=>setCopyMarginPct(e.target.value)} style={{width:'100px'}}/>
              <span style={{fontSize:'13px',color:C.textSoft}}>%</span>
            </div>
          </FormRow>
          <div style={{display:'flex',justifyContent:'flex-end',gap:'10px',paddingTop:'8px',borderTop:`1px solid ${C.border}`}}>
            <Btn variant='ghost' onClick={()=>setCopyModal(false)}>Cancel</Btn>
            <Btn onClick={handleCopyLines} disabled={!copyPiId}>Copy & Apply Margin</Btn>
          </div>
        </div>
      </Modal>

      {/* New PI Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title='New Proforma Invoice' width={900}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <SectionDivider label='Details' />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
            <FormRow label='PI Date' required>
              <Input type='date' value={form.pi_date} onChange={e => setF('pi_date', e.target.value)} />
            </FormRow>
            <FormRow label='Valid Upto'>
              <Input type='date' value={form.valid_upto} onChange={e => setF('valid_upto', e.target.value)} />
            </FormRow>
            <FormRow label='Status'>
              <Select value={form.status} onChange={e => setF('status', e.target.value)}>
                {PI_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </Select>
            </FormRow>
            <FormRow label='From Entity' required>
              <Select value={form.from_entity_id} onChange={e => setF('from_entity_id', e.target.value)}>
                <option value=''>Select entity</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='To Entity' required>
              <Select value={form.to_entity_id} onChange={e => setF('to_entity_id', e.target.value)}>
                <option value=''>Select entity</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Tax Type' hint='Auto-detected from entity state codes'>
              <Select value={form.is_interstate ? '1' : '0'} onChange={e => setF('is_interstate', e.target.value === '1')}>
                <option value='0'>Local — Same State (CGST + SGST)</option>
                <option value='1'>Interstate — Different State (IGST)</option>
              </Select>
            </FormRow>
            <FormRow label='Order'>
              <Select value={form.order_id} onChange={e => { setF('order_id', e.target.value); loadLegs(e.target.value) }}>
                <option value=''>No order</option>
                {orders.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Order Leg'>
              <Select value={form.order_leg_id} onChange={e => setF('order_leg_id', e.target.value)} disabled={!form.order_id || !legs.length}>
                <option value=''>Select leg</option>
                {legs.map(l => <option key={l.id} value={l.id}>Leg {l.leg_no}: {l.from_entity?.short_name || l.from_entity?.name} → {l.to_entity?.short_name || l.to_entity?.name}</option>)}
              </Select>
            </FormRow>
          </div>

          <SectionDivider label='Line Items' />
          <div style={{display:'flex',justifyContent:'flex-end',marginBottom:'-4px'}}>
            <Btn size='sm' variant='ghost' onClick={openCopyModal}>📋 Copy from previous leg PI…</Btn>
          </div>
          <LineItemsEditor lines={piLines} setLines={setPILines} interstate={form.is_interstate} hsnMap={hsnMap} showMargin={true} stockMap={stockMap}/>

          <SectionDivider label='Billing & Shipping (optional)' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Bill From' hint='Billing address of sender (if different from entity address)'>
              <Input value={form.bill_from} onChange={e => setF('bill_from', e.target.value)} placeholder='e.g. VVGTL, Panvel' />
            </FormRow>
            <FormRow label='Bill To' hint='Billing address of receiver'>
              <Input value={form.bill_to} onChange={e => setF('bill_to', e.target.value)} placeholder='e.g. Transworld Commercial Enterprises' />
            </FormRow>
            <FormRow label='Ship From'>
              <Input value={form.ship_from} onChange={e => setF('ship_from', e.target.value)} placeholder='Dispatch location' />
            </FormRow>
            <FormRow label='Ship To'>
              <Input value={form.ship_to} onChange={e => setF('ship_to', e.target.value)} placeholder='e.g. DHL Panvel (C/o Transworld)' />
            </FormRow>
          </div>
          <FormRow label='Notes'>
            <Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} />
          </FormRow>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Create PI'}</Btn>
          </div>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── PI Detail ────────────────────────────────────────────────────────────────
function PIDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [pi, setPI]         = useState(null)
  const [lines, setLines]   = useState([])
  const [editLines, setEditLines] = useState([])
  const [editing, setEditing]     = useState(false)
  const [editForm, setEditForm]   = useState({})
  const [hsnMap, setHsnMap]       = useState(new Map())
  const [loading, setLoading]     = useState(true)
  const [saving, setSaving]       = useState(false)
  const [toast, setToast]         = useState(null)
  const [confirmCancel, setConfirmCancel] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: p }, { data: ls }, { data: hsnRows }] = await Promise.all([
      supabase.from('proforma_invoices').select('*, from_entity:from_entity_id(name,short_name,gstin,state_code,address,city), to_entity:to_entity_id(name,short_name,gstin,state_code,address,city), orders(name), order_legs(leg_no)').eq('id',id).single(),
      supabase.from('proforma_invoice_lines').select('*').eq('pi_id',id).order('line_no'),
      supabase.from('hsn_master').select('*').eq('is_active',true),
    ])
    setPI(p); setLines(ls||[]); setHsnMap(buildHSNMap(hsnRows||[])); setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  function startEdit() {
    setEditForm({pi_date:pi.pi_date||'',valid_upto:pi.valid_upto||'',status:pi.status||'draft',notes:pi.notes||'',is_interstate:pi.is_interstate,bill_from:pi.bill_from||'',bill_to:pi.bill_to||'',ship_from:pi.ship_from||'',ship_to:pi.ship_to||''})
    setEditLines(lines.map(l=>({...l,_id:l.id,_hsn_resolved_rate:null,_hsn_override:false,_hsn_manually_set:false,_cost_rate:null,_margin_pct:''})))
    setEditing(true)
  }

  async function handleSaveEdit() {
    setSaving(true)
    const computedLines = editLines.map(l => computeLine(l, editForm.is_interstate))
    const totals = computeTotals(computedLines)
    const { error: piErr } = await supabase.from('proforma_invoices').update({...editForm,...totals,updated_at:new Date()}).eq('id',id)
    if (piErr) { setSaving(false); return setToast({message:piErr.message,type:'error'}) }
    await supabase.from('proforma_invoice_lines').delete().eq('pi_id',id)
    const linesPayload = computedLines.map((l,i)=>{
      const {_id,_cost_rate,_margin_pct,_hsn_resolved_rate,_hsn_override,_hsn_manually_set,_hsn_source,...rest}=l
      return {...rest,pi_id:id,line_no:i+1}
    })
    if (linesPayload.length) {
      const { error: lErr } = await supabase.from('proforma_invoice_lines').insert(linesPayload)
      if (lErr) { setSaving(false); return setToast({message:lErr.message,type:'error'}) }
    }
    setSaving(false); setEditing(false)
    setToast({message:'PI updated',type:'success'}); load()
  }

  function handleExportLines() {
    if (!pi||!lines.length) return
    downloadCSV(`${pi.pi_no||'pi'}_lines_${today()}.csv`,['line_no','description','hsn_code','qty','unit','rate','gst_rate','taxable_amount','cgst_amount','sgst_amount','igst_amount','total_amount'],lines)
  }

  async function updateStatus(status) {
    await supabase.from('proforma_invoices').update({status,updated_at:new Date()}).eq('id',id)
    setToast({message:`PI marked as ${status}`,type:'success'}); load()
  }

  if (loading) return <div style={{padding:'48px',textAlign:'center',color:C.textMuted}}>Loading…</div>
  if (!pi)     return <div style={{padding:'48px',textAlign:'center',color:C.danger}}>PI not found.</div>

  const canConvert = ['accepted','sent','draft'].includes(pi.status) && !editing
  const isLocked   = ['converted','cancelled'].includes(pi.status)

  return (
    <div>
      <button onClick={()=>navigate('/pi')} style={{background:'none',border:'none',color:C.textMuted,fontSize:'13px',cursor:'pointer',padding:0,fontFamily:'inherit',marginBottom:'4px'}}>← Proforma Invoices</button>

      <PageHeader
        title={pi.pi_no||`PI — ${fmtDate(pi.pi_date)}`}
        subtitle={`${pi.from_entity?.name} → ${pi.to_entity?.name} · ${fmtDate(pi.pi_date)}`}
        action={
          <div style={{display:'flex',gap:'8px',flexWrap:'wrap',alignItems:'center'}}>
            <Btn size='sm' variant='ghost' onClick={handleExportLines}>↓ CSV</Btn>
            {!editing&&!isLocked&&<Btn size='sm' variant='ghost' onClick={startEdit}>✏ Edit</Btn>}
            {editing&&<Btn size='sm' variant='ghost' onClick={()=>setEditing(false)}>Discard</Btn>}
            {editing&&<Btn size='sm' onClick={handleSaveEdit} disabled={saving}>{saving?'Saving…':'Save Changes'}</Btn>}
            {!editing&&pi.status==='draft'&&<Btn size='sm' variant='ghost' onClick={()=>updateStatus('sent')}>Mark Sent</Btn>}
            {!editing&&pi.status==='sent'&&<Btn size='sm' variant='ghost' onClick={()=>updateStatus('accepted')}>Mark Accepted</Btn>}
            {canConvert&&<Btn size='sm' onClick={()=>navigate(`/invoices/new?from_pi=${id}`)}>Convert to Invoice</Btn>}
            {!editing&&!isLocked&&<Btn size='sm' variant='ghost' onClick={()=>setConfirmCancel(true)} style={{color:C.danger}}>Cancel PI</Btn>}
            <Badge status={pi.status}/>
          </div>
        }
      />
      {editing&&<div style={{background:'#fffbf0',border:`1px solid #e6c040`,borderRadius:'6px',padding:'8px 14px',fontSize:'12px',color:'#7a5000',marginBottom:'16px'}}>✏ Editing mode — click "Save Changes" to confirm</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
        <Card style={{ padding: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>From</div>
          <div style={{ fontWeight: 700, fontSize: '14px' }}>{pi.from_entity?.name}</div>
          {pi.from_entity?.gstin && <div style={{ fontSize: '12px', color: C.textSoft, fontFamily: 'monospace', marginTop: '2px' }}>GSTIN: {pi.from_entity.gstin}</div>}
          {pi.from_entity?.city  && <div style={{ fontSize: '12px', color: C.textSoft }}>{pi.from_entity.city}</div>}
        </Card>
        <Card style={{ padding: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>To</div>
          <div style={{ fontWeight: 700, fontSize: '14px' }}>{pi.to_entity?.name}</div>
          {pi.to_entity?.gstin && <div style={{ fontSize: '12px', color: C.textSoft, fontFamily: 'monospace', marginTop: '2px' }}>GSTIN: {pi.to_entity.gstin}</div>}
          {pi.to_entity?.city  && <div style={{ fontSize: '12px', color: C.textSoft }}>{pi.to_entity.city}</div>}
        </Card>
      </div>

      <div style={{ display: 'flex', gap: '16px', marginBottom: '24px', flexWrap: 'wrap', fontSize: '13px' }}>
        <div><span style={{ color: C.textMuted }}>Date:</span> <strong>{fmtDate(pi.pi_date)}</strong></div>
        {pi.valid_upto && <div><span style={{ color: C.textMuted }}>Valid until:</span> <strong>{fmtDate(pi.valid_upto)}</strong></div>}
        <div><span style={{ color: C.textMuted }}>Tax:</span> <Badge status={pi.is_interstate ? 'export' : 'domestic'} label={pi.is_interstate ? 'Interstate (IGST)' : 'Local (CGST+SGST)'} /></div>
        {pi.orders?.name && <div><span style={{ color: C.textMuted }}>Order:</span> <strong>{pi.orders.name}</strong></div>}
      </div>

      {editing&&(
        <Card style={{marginBottom:'16px',padding:'16px'}}>
          <SectionDivider label='Edit Details'/>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:'12px',marginTop:'12px'}}>
            <FormRow label='PI Date' required><Input type='date' value={editForm.pi_date} onChange={e=>setEditForm(f=>({...f,pi_date:e.target.value}))}/></FormRow>
            <FormRow label='Valid Upto'><Input type='date' value={editForm.valid_upto} onChange={e=>setEditForm(f=>({...f,valid_upto:e.target.value}))}/></FormRow>
            <FormRow label='Status'><Select value={editForm.status} onChange={e=>setEditForm(f=>({...f,status:e.target.value}))}>{PI_STATUSES.map(s=><option key={s} value={s}>{s}</option>)}</Select></FormRow>
            <FormRow label='Tax Type'><Select value={editForm.is_interstate?'1':'0'} onChange={e=>setEditForm(f=>({...f,is_interstate:e.target.value==='1'}))}><option value='0'>Local — CGST+SGST</option><option value='1'>Interstate — IGST</option></Select></FormRow>
            <FormRow label='Bill From'><Input value={editForm.bill_from} onChange={e=>setEditForm(f=>({...f,bill_from:e.target.value}))}/></FormRow>
            <FormRow label='Bill To'><Input value={editForm.bill_to} onChange={e=>setEditForm(f=>({...f,bill_to:e.target.value}))}/></FormRow>
          </div>
          <div style={{marginTop:'8px'}}><FormRow label='Notes'><Textarea value={editForm.notes} onChange={e=>setEditForm(f=>({...f,notes:e.target.value}))} rows={2}/></FormRow></div>
        </Card>
      )}
      <Card style={{marginBottom:'16px'}}>
        <LineItemsEditor
          lines={editing?editLines:lines.map(l=>({...l,_id:l.id}))}
          setLines={editing?setEditLines:()=>{}}
          interstate={editing?editForm.is_interstate:pi.is_interstate}
          hsnMap={hsnMap}
          readOnly={!editing}
          showMargin={true}
        />
      </Card>

      {pi.notes && (
        <div style={{ fontSize: '13px', color: C.textSoft, marginTop: '8px' }}>
          <strong>Notes:</strong> {pi.notes}
        </div>
      )}

      <div style={{ marginTop: '20px' }}>
        <div style={{ fontWeight: 700, fontSize: '14px', marginBottom: '10px' }}>Documents</div>
        <DocumentAttachments
          sourceType='proforma_invoices'
          sourceId={pi.id}
          entityId={pi.from_entity_id} // CHANGED: required for documents.entity_id NOT NULL
          entityName={pi.from_entity?.name || 'General'}
        />
      </div>

      <ConfirmModal open={confirmCancel} onClose={() => setConfirmCancel(false)} onConfirm={() => { updateStatus('cancelled'); setConfirmCancel(false) }}
        title='Cancel PI' message='Cancel this proforma invoice? This action cannot be undone.' danger />

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

export default function PI() {
  return (
    <Routes>
      <Route index       element={<PIList />} />
      <Route path=':id'  element={<PIDetail />} />
    </Routes>
  )
}
