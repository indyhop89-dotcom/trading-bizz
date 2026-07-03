import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, SectionDivider, StatCard,
} from '../../components/UI/index'
import LineItemsEditor, { computeLine, computeTotals } from '../../components/LineItemsEditor'
import { formatINR, toNum } from '../../utils/money'
import { fmtDate, today, currentFYLabel, parseFlexibleDate } from '../../utils/dates'
import { buildHSNMap } from '../../utils/hsn'
import DocumentAttachments from '../../components/DocumentAttachments'
import { downloadTemplate, downloadCSV } from '../../utils/csvTemplate'

const INV_STATUSES = ['draft', 'submitted', 'partial', 'paid', 'cancelled']
const TDS_SECTIONS = ['194C', '194H', '194I', '194J', '194Q', '206C']
const TDS_SECTION_LABELS = {
  '194C': 'Payment to Contractors',
  '194H': 'Commission or Brokerage',
  '194I': 'Rent',
  '194J': 'Professional/Technical Services',
  '194Q': 'Purchase of Goods',
  '206C': 'TCS on Sale of Goods',
}

const EMPTY_FORM = {
  invoice_date: today(), due_date: '', invoice_type: 'sales', status: 'draft',
  seller_entity_id: '', buyer_entity_id: '',
  order_id: '', order_leg_id: '', pi_id: '', po_id: '',
  is_interstate: false,
  bill_from: '', bill_to: '', ship_from: '', ship_to: '',
  eway_bill_no: '', eway_bill_date: '',
  einvoice_irn: '', einvoice_ack_no: '', einvoice_ack_date: '',
  tds_amount: 0, tcs_amount: 0,
  notes: '',
  invoice_no: '', // CHANGED: optional manual invoice number — blank auto-generates via next_inv_no()
}


// Resolve current FY — next_inv_no takes (ent_id, fy_id)
async function resolveFY() {
  const label = currentFYLabel()
  const { data } = await supabase.from('financial_years').select('id,name,code').order('start_date',{ascending:false}).limit(5)
  return (data||[]).find(f=>f.name===label)||data?.[0]
}

async function writeStockMovements(invoice, lines) {
  if (!lines?.length) return
  const entries = []
  for (const l of lines) {
    if (!l.product_id||!Number(l.qty)) continue
    const qty=Number(l.qty), rate=Number(l.rate), date=invoice.invoice_date
    entries.push({entity_id:invoice.seller_entity_id,product_id:l.product_id,posting_date:date,qty_in:0,qty_out:qty,rate,voucher_type:'sales_invoice',voucher_id:invoice.id,voucher_no:invoice.invoice_no||invoice.id,notes:`Invoice outgoing — ${invoice.invoice_no||''}`})
    entries.push({entity_id:invoice.buyer_entity_id,product_id:l.product_id,posting_date:date,qty_in:qty,qty_out:0,rate,voucher_type:'sales_invoice',voucher_id:invoice.id,voucher_no:invoice.invoice_no||invoice.id,notes:`Invoice incoming — ${invoice.invoice_no||''}`})
  }
  if (entries.length) await supabase.from('stock_movements').insert(entries)
}

// ─── Invoice List ─────────────────────────────────────────────────────────────
function InvoiceList() {
  const navigate = useNavigate()
  const [invoices, setInvoices] = useState([])
  const [entities, setEntities] = useState([])
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [statusFilter, setStatus] = useState('all')
  const [typeFilter, setType]   = useState('all')
  const [entityFilter, setEntityF] = useState('')
  const [toast, setToast]       = useState(null)
  const [csvModal, setCsvModal]   = useState(false)
  const [csvText, setCsvText]     = useState('')
  const [csvResult, setCsvResult] = useState(null)
  const [csvSaving, setCsvSaving] = useState(false)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: invs }, { data: es }] = await Promise.all([
      supabase.from('invoices')
        .select('*, seller:seller_entity_id(name,short_name), buyer:buyer_entity_id(name,short_name)')
        .eq('is_deleted', false).neq('invoice_type', 'intercompany')
        .order('invoice_date', { ascending: false }),
      supabase.from('entities').select('id,name,short_name,state_code').eq('is_active', true).eq('is_deleted', false).order('name'),
    ])
    setInvoices(invs || [])
    setEntities(es || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Format: invoice_date,invoice_type,seller_entity,buyer_entity,is_interstate,description,hsn_code,qty,unit,rate,gst_rate,due_date,notes,invoice_no
  // CHANGED: invoice_no and financial_year_id were previously never set on CSV-created
  // invoices at all — invoices.invoice_no and financial_year_id are NOT NULL with no
  // DB default, so every CSV upload here would have failed outright. This adds the
  // same FY-resolve + next_inv_no() generation the other modules use, plus lets you
  // supply your own invoice_no per row (optional — blank auto-generates).
  async function handleCSV() {
    setCsvSaving(true)
    const lines = csvText.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) { setCsvSaving(false); return setToast({ message: 'Need header + data rows', type: 'error' }) }
    const header = lines[0].split(',').map(h => h.trim().toLowerCase())
    let created = 0, errors = []
    const usedInvoiceNos = new Set(invoices.map(i => i.invoice_no?.toLowerCase()).filter(Boolean))
    const groups = {}
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim())
      const row  = {}
      header.forEach((h, j) => { row[h] = cols[j] || '' })
      const key = `${row.invoice_date}__${row.seller_entity}__${row.buyer_entity}`
      if (!groups[key]) groups[key] = { meta: row, lines: [] }
      groups[key].lines.push(row)
    }
    for (const [key, group] of Object.entries(groups)) {
      const { meta, lines: gLines } = group
      const sellerE = entities.find(e => e.short_name?.toLowerCase() === meta.seller_entity?.toLowerCase() || e.name?.toLowerCase() === meta.seller_entity?.toLowerCase())
      const buyerE  = entities.find(e => e.short_name?.toLowerCase() === meta.buyer_entity?.toLowerCase()  || e.name?.toLowerCase() === meta.buyer_entity?.toLowerCase())
      if (!sellerE) { errors.push(`Seller "${meta.seller_entity}" not found`); continue }
      if (!buyerE)  { errors.push(`Buyer "${meta.buyer_entity}" not found`); continue }

      // CHANGED: normalize date (YYYY-MM-DD or DD-MM-YYYY) — same fix as PI/PO,
      // a raw DD-MM-YYYY value fails Postgres with "date/time field value out
      // of range" once the day exceeds 12.
      const invoiceDate = parseFlexibleDate(meta.invoice_date)
      if (!invoiceDate) { errors.push(`Invoice ${meta.invoice_date} ${meta.seller_entity}→${meta.buyer_entity}: invoice_date "${meta.invoice_date}" is not a valid date — use YYYY-MM-DD or DD-MM-YYYY`); continue }
      const dueDate = meta.due_date ? parseFlexibleDate(meta.due_date) : null
      if (meta.due_date && !dueDate) { errors.push(`Invoice ${meta.invoice_date} ${meta.seller_entity}→${meta.buyer_entity}: due_date "${meta.due_date}" is not a valid date`); continue }

      // CHANGED: financial_year_id always resolved; invoice_no taken from the
      // CSV if supplied, else generated via next_inv_no() keyed to the seller
      // (the entity issuing the invoice — mirrors PI's use of from_entity).
      const fy = await resolveFY()
      if (!fy) { errors.push(`Invoice ${meta.invoice_date} ${meta.seller_entity}→${meta.buyer_entity}: no financial year found`); continue }
      let invoiceNo = (meta.invoice_no || '').trim()
      if (invoiceNo) {
        if (usedInvoiceNos.has(invoiceNo.toLowerCase())) { errors.push(`Invoice ${meta.invoice_date} ${meta.seller_entity}→${meta.buyer_entity}: invoice number "${invoiceNo}" is already in use`); continue }
      } else {
        const { data: generated, error: noErr } = await supabase.rpc('next_inv_no', { ent_id: sellerE.id, fy_id: fy.id })
        if (noErr) { errors.push(`Invoice ${meta.invoice_date} ${meta.seller_entity}→${meta.buyer_entity}: could not generate invoice number — ${noErr.message}`); continue }
        invoiceNo = generated
      }
      usedInvoiceNos.add(invoiceNo.toLowerCase())

      const interstate = meta.is_interstate === 'true' || (sellerE.state_code && buyerE.state_code && sellerE.state_code !== buyerE.state_code)
      const invLines = gLines.map((r, i) => {
        const rate = toNum(r.rate); const qty = toNum(r.qty); const taxable = Math.round(qty * rate)
        const gstRate = toNum(r.gst_rate) || 18; const half = gstRate / 2
        const igst = interstate ? Math.round(taxable * gstRate / 100) : 0
        const cgst = !interstate ? Math.round(taxable * half / 100) : 0
        return { line_no: i+1, description: r.description, hsn_code: r.hsn_code, qty, unit: r.unit||'Nos', rate, gst_rate: gstRate, taxable_amount: taxable, cgst_rate: half, cgst_amount: cgst, sgst_rate: half, sgst_amount: cgst, igst_rate: interstate?gstRate:0, igst_amount: igst, total_amount: taxable+igst+cgst+cgst }
      })
      const totals = invLines.reduce((acc, l) => ({ taxable_amount: acc.taxable_amount+l.taxable_amount, cgst_amount: acc.cgst_amount+l.cgst_amount, sgst_amount: acc.sgst_amount+l.sgst_amount, igst_amount: acc.igst_amount+l.igst_amount, total_amount: acc.total_amount+l.total_amount }), { taxable_amount:0,cgst_amount:0,sgst_amount:0,igst_amount:0,total_amount:0 })
      const { data: inv, error: invErr } = await supabase.from('invoices').insert({ invoice_no: invoiceNo, financial_year_id: fy.id, invoice_date: invoiceDate, invoice_type: meta.invoice_type||'sales', seller_entity_id: sellerE.id, buyer_entity_id: buyerE.id, is_interstate: interstate, due_date: dueDate, notes: meta.notes||null, status: 'draft', outstanding_amount: totals.total_amount, paid_amount: 0, ...totals }).select().single()
      if (invErr) { errors.push(`Invoice ${meta.invoice_date} ${meta.seller_entity}→${meta.buyer_entity}: ${invErr.message}`); continue }
      await supabase.from('invoice_lines').insert(invLines.map(l => ({ ...l, invoice_id: inv.id })))
      created++
    }
    setCsvSaving(false); setCsvResult({ created, errors }); load()
  }

  function handleExportCSV() {
    downloadCSV(`invoices_export_${today()}.csv`,['invoice_no','invoice_date','invoice_type','seller','buyer','tax_type','status','taxable_amount','total_amount','outstanding_amount'],filtered.map(i=>({invoice_no:i.invoice_no||'',invoice_date:i.invoice_date,invoice_type:i.invoice_type,seller:i.seller?.name||'',buyer:i.buyer?.name||'',tax_type:i.is_interstate?'Interstate':'Local',status:i.status,taxable_amount:i.taxable_amount||0,total_amount:i.total_amount||0,outstanding_amount:i.outstanding_amount||0})))
  }

  const filtered = invoices.filter(i => {
    const ms  = !search || (i.invoice_no || '').toLowerCase().includes(search.toLowerCase()) ||
      i.seller?.name?.toLowerCase().includes(search.toLowerCase()) ||
      i.buyer?.name?.toLowerCase().includes(search.toLowerCase())
    const mst = statusFilter === 'all' || i.status === statusFilter
    const mt  = typeFilter === 'all' || i.invoice_type === typeFilter
    const me  = !entityFilter || i.seller_entity_id === entityFilter || i.buyer_entity_id === entityFilter
    return ms && mst && mt && me
  })

  // summary totals
  const totalOutstanding = filtered.reduce((s, i) => s + (i.outstanding_amount || 0), 0)
  const totalAmount      = filtered.reduce((s, i) => s + (i.total_amount || 0), 0)

  const columns = [
    { label: 'S.No.',      render: (row, idx) => <span style={{ color: C.textMuted }}>{idx + 1}</span> },
    { label: 'Invoice No', render: i => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{i.invoice_no || '—'}</span> },
    { label: 'Type',    render: i => <Badge status={i.invoice_type} label={i.invoice_type === 'sales' ? 'Sales' : 'Purchase'} /> },
    { label: 'Seller',  render: i => <span style={{ fontSize: '12px' }}>{i.seller?.short_name || i.seller?.name}</span> },
    { label: 'Buyer',   render: i => <span style={{ fontSize: '12px' }}>{i.buyer?.short_name || i.buyer?.name}</span> },
    { label: 'Date',    render: i => <span style={{ fontSize: '12px' }}>{fmtDate(i.invoice_date)}</span> },
    { label: 'Due',     render: i => {
      if (!i.due_date) return <span style={{ color: C.textMuted }}>—</span>
      const overdue = new Date(i.due_date) < new Date() && i.status !== 'paid'
      return <span style={{ fontSize: '12px', color: overdue ? C.danger : C.text, fontWeight: overdue ? 700 : 400 }}>{fmtDate(i.due_date)}{overdue ? ' ⚠️' : ''}</span>
    }},
    { label: 'Amount',  right: true, render: i => <span style={{ fontWeight: 600 }}>{formatINR(i.total_amount)}</span> },
    { label: 'Outstanding', right: true, render: i => <span style={{ fontWeight: 600, color: i.outstanding_amount > 0 ? C.warning : C.success }}>{formatINR(i.outstanding_amount)}</span> },
    { label: 'Status',  render: i => <Badge status={i.status} /> },
  ]

  return (
    <div>
      <PageHeader
        title='Invoices'
        subtitle='Tax invoices — sales and purchases'
        action={
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn variant='ghost' onClick={handleExportCSV}>↓ Export CSV</Btn>
            <Btn variant='ghost' onClick={() => { setCsvText(''); setCsvResult(null); setCsvModal(true) }}>↑ CSV Upload</Btn>
            <Btn onClick={() => navigate('/invoices/new')}>+ New Invoice</Btn>
          </div>
        }
      />

      {/* summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px,1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label='Total Invoiced' value={formatINR(totalAmount)} />
        <StatCard label='Outstanding' value={formatINR(totalOutstanding)} color={totalOutstanding > 0 ? C.warning : C.success} />
        <StatCard label='Invoices' value={filtered.length} />
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder='Search invoice no, entity…'
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', flex: 1, minWidth: '180px', fontFamily: 'inherit' }} />
        <select value={typeFilter} onChange={e => setType(e.target.value)}
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value='all'>All types</option>
          <option value='sales'>Sales</option>
          <option value='purchase'>Purchase</option>
        </select>
        <select value={statusFilter} onChange={e => setStatus(e.target.value)}
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value='all'>All statuses</option>
          {INV_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
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
          : <Table columns={columns} rows={filtered} onRowClick={i => navigate(`/invoices/${i.id}`)}
              emptyState={<EmptyState icon='🧾' title='No invoices' action={<Btn onClick={() => navigate('/invoices/new')}>+ New Invoice</Btn>} />} />
        }
      </Card>

      {/* CSV Upload Modal */}
      <Modal open={csvModal} onClose={() => setCsvModal(false)} title='Bulk Upload Invoices' width={680}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 14px', fontSize: '12px', color: C.textMid, lineHeight: 1.7 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
              <strong>CSV Format — one row per line item:</strong>
              <Btn size='sm' variant='ghost' onClick={() => downloadTemplate('invoices')}>↓ Download Template</Btn>
            </div>
            <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>invoice_date,invoice_type,seller_entity,buyer_entity,is_interstate,description,hsn_code,qty,unit,rate,gst_rate,due_date,notes,invoice_no</code><br /><br />
            Multiple rows with same <strong>invoice_date + seller + buyer</strong> are grouped into one Invoice. <code>invoice_no</code> is optional — leave it blank to auto-generate, or supply your own (checked against existing invoices and other rows in this file).
          </div>
          <FormRow label='Paste CSV'>
            <textarea value={csvText} onChange={e => setCsvText(e.target.value)} rows={10} placeholder='Paste CSV data here…'
              style={{ padding: '8px 11px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: '#fffdf6', fontSize: '12px', fontFamily: 'monospace', width: '100%', boxSizing: 'border-box', resize: 'vertical', outline: 'none' }} />
          </FormRow>
          {csvResult && (
            <div style={{ background: csvResult.errors.length > 0 ? '#fff3cc' : '#e8f3ec', border: `1px solid ${csvResult.errors.length > 0 ? '#e6c040' : '#b8dfc8'}`, borderRadius: '6px', padding: '10px 14px', fontSize: '12px' }}>
              <strong>{csvResult.created} invoices created.</strong>
              {csvResult.errors.map((e, i) => <div key={i} style={{ color: '#7a5000', marginTop: '4px' }}>• {e}</div>)}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setCsvModal(false)}>Close</Btn>
            <Btn onClick={handleCSV} disabled={csvSaving || !csvText.trim()}>{csvSaving ? 'Uploading…' : 'Upload'}</Btn>
          </div>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── New Invoice Form ─────────────────────────────────────────────────────────
function NewInvoice() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const fromPiId = searchParams.get('from_pi')

  const [entities, setEntities] = useState([])
  const [orders, setOrders]     = useState([])
  const [pis, setPIs]           = useState([])
  const [pos, setPOs]           = useState([])
  const [legs, setLegs]         = useState([])
  const [lines, setLines]       = useState([])
  const [hsnMap, setHsnMap]     = useState(new Map())
  const [form, setForm]         = useState({ ...EMPTY_FORM, pi_id: fromPiId || '' })
  const [saving, setSaving]     = useState(false)
  const [toast, setToast]       = useState(null)
  // CHANGED: TDS/TCS entries
  const [tdsEntries, setTdsEntries] = useState([])  // [{type,section,rate,base_amount}]

  function addTdsRow(type) {
    setTdsEntries(rows => [...rows, { _id: Date.now(), type, section: type === 'tcs' ? '206C' : '194C', rate: type === 'tcs' ? 0.1 : 1, base_amount: '' }])
  }
  function updateTdsRow(id, key, val) {
    setTdsEntries(rows => rows.map(r => r._id === id ? { ...r, [key]: val } : r))
  }
  function removeTdsRow(id) {
    setTdsEntries(rows => rows.filter(r => r._id !== id))
  }

  useEffect(() => {
    Promise.all([
      supabase.from('entities').select('id,name,short_name,gstin,state_code').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('orders').select('id,name').eq('is_deleted', false).order('name'),
      supabase.from('proforma_invoices').select('id,pi_no,from_entity_id,to_entity_id,total_amount').eq('is_deleted', false).order('pi_date', { ascending: false }),
      supabase.from('purchase_orders').select('id,po_no,buyer_entity_id,seller_entity_id').eq('is_deleted', false).order('po_date', { ascending: false }),
      supabase.from('hsn_master').select('*').eq('is_active', true),
    ]).then(([{ data: es }, { data: os }, { data: piData }, { data: poData }, { data: hsnRows }]) => {
      setEntities(es || [])
      setOrders(os || [])
      setPIs(piData || [])
      setPOs(poData || [])
      setHsnMap(buildHSNMap(hsnRows || []))
    })
  }, [])

  // Pre-fill from PI if coming from convert button
  useEffect(() => {
    if (!fromPiId || !pis.length) return
    const pi = pis.find(p => p.id === fromPiId)
    if (!pi) return
    setF('seller_entity_id', pi.from_entity_id)
    setF('buyer_entity_id',  pi.to_entity_id)
    // Load PI lines
    supabase.from('proforma_invoice_lines').select('*').eq('pi_id', fromPiId).order('line_no').then(({ data }) => {
      if (data) setLines(data.map(l => ({ ...l, _id: l.id })))
    })
  }, [fromPiId, pis])

  function setF(k, v) {
    setForm(f => {
      const updated = { ...f, [k]: v }
      if (k === 'seller_entity_id' || k === 'buyer_entity_id') {
        const sid = k === 'seller_entity_id' ? v : f.seller_entity_id
        const bid = k === 'buyer_entity_id'  ? v : f.buyer_entity_id
        const se  = entities.find(e => e.id === sid)
        const be  = entities.find(e => e.id === bid)
        if (se?.state_code && be?.state_code)
          updated.is_interstate = se.state_code !== be.state_code
      }
      return updated
    })
  }

  async function loadLegs(orderId) {
    if (!orderId) { setLegs([]); return }
    const { data } = await supabase.from('order_legs')
      .select('id,leg_no,from_entity:from_entity_id(name,short_name),to_entity:to_entity_id(name,short_name)')
      .eq('order_id', orderId).order('leg_no')
    setLegs(data || [])
  }

  async function handleSave() {
    if (!form.seller_entity_id || !form.buyer_entity_id) return setToast({ message: 'Seller and Buyer are required', type: 'error' })
    if (lines.length === 0) return setToast({ message: 'At least one line item is required', type: 'error' })

    const computedLines = lines.map(l => computeLine(l, form.is_interstate))
    const totals = computeTotals(computedLines)
    setSaving(true)

    // CHANGED: invoice_no and financial_year_id are NOT NULL columns with no
    // DB default — this insert previously omitted both entirely, so every
    // manually-created invoice would have failed on that constraint. This
    // mirrors PI/PO: resolve FY, then use the typed invoice_no or generate one.
    const fy = await resolveFY()
    if (!fy) { setSaving(false); return setToast({ message: 'No financial year found', type: 'error' }) }
    let invoiceNo = (form.invoice_no || '').trim()
    if (invoiceNo) {
      const { data: dup } = await supabase.from('invoices').select('id').ilike('invoice_no', invoiceNo).limit(1)
      if (dup?.length) { setSaving(false); return setToast({ message: `Invoice number "${invoiceNo}" is already in use`, type: 'error' }) }
    } else {
      const { data: generated, error: noErr } = await supabase.rpc('next_inv_no', { ent_id: form.seller_entity_id, fy_id: fy.id })
      if (noErr) { setSaving(false); return setToast({ message: 'Could not generate invoice number: '+noErr.message, type: 'error' }) }
      invoiceNo = generated
    }

    const payload = {
      ...form,
      ...totals,
      invoice_no: invoiceNo,
      financial_year_id: fy.id,
      outstanding_amount: totals.total_amount,
      paid_amount: 0,
    }
    if (!payload.order_id)      delete payload.order_id
    if (!payload.order_leg_id)  delete payload.order_leg_id
    if (!payload.pi_id)         delete payload.pi_id
    if (!payload.po_id)         delete payload.po_id
    if (!payload.due_date)      delete payload.due_date
    if (!payload.einvoice_ack_date) delete payload.einvoice_ack_date
    if (!payload.tds_amount)    delete payload.tds_amount
    if (!payload.tcs_amount)    delete payload.tcs_amount

    const { data: inv, error } = await supabase.from('invoices').insert(payload).select().single()
    if (error) { setSaving(false); return setToast({ message: error.message, type: 'error' }) }

    // Insert lines
    const linesPayload = computedLines.map((l, i) => ({
      ...l, invoice_id: inv.id, line_no: i + 1,
      _id: undefined,
    }))
    await supabase.from('invoice_lines').insert(linesPayload)

    // CHANGED: Insert TDS/TCS entries
    if (tdsEntries.length > 0) {
      const tdsPayload = tdsEntries
        .filter(r => r.base_amount && parseFloat(r.base_amount) > 0)
        .map(r => {
          const base   = Math.round(parseFloat(r.base_amount))
          const amount = Math.round(base * parseFloat(r.rate) / 100)
          return {
            invoice_id:            inv.id,
            entry_type:            r.type,
            section_code:          r.section,
            section_desc:          TDS_SECTION_LABELS[r.section] || r.section,
            deducted_by_entity_id: r.type === 'tds' ? form.buyer_entity_id  : form.seller_entity_id,
            deductee_entity_id:    r.type === 'tds' ? form.seller_entity_id : form.buyer_entity_id,
            base_amount:           base,
            rate:                  parseFloat(r.rate),
            amount,
          }
        })
      if (tdsPayload.length > 0) await supabase.from('tds_tcs_entries').insert(tdsPayload)
    }

    // Mark PI as converted if applicable
    if (form.pi_id) {
      await supabase.from('proforma_invoices').update({ status: 'converted', converted_to_invoice_id: inv.id }).eq('id', form.pi_id)
    }

    // CHANGED: auto-create a draft purchase invoice for the buyer when this
    // sales invoice is linked to a PO. Mirrors the same lines/totals so the
    // buyer can review, edit (add/remove lines), and confirm it themselves —
    // it does not post as final on its own. Applies to any entity pair with
    // a linked PO, not just specific entities.
    if (form.po_id) {
      const { data: purchaseInv, error: purchaseErr } = await supabase.from('invoices').insert({
        invoice_date: form.invoice_date,
        due_date: form.due_date || null,
        invoice_type: 'purchase',
        status: 'draft',
        seller_entity_id: form.seller_entity_id,
        buyer_entity_id: form.buyer_entity_id,
        source_invoice_id: inv.id,
        pi_id: form.pi_id || null,
        po_id: form.po_id || null,
        is_interstate: form.is_interstate,
        outstanding_amount: totals.total_amount,
        paid_amount: 0,
        notes: `Auto-created from ${inv.invoice_no || 'linked sales invoice'} — pending buyer confirmation`,
        ...totals,
      }).select().single()

      if (purchaseErr) {
        // Don't fail the whole save over this — the sales invoice is already
        // committed. Surface it so it doesn't silently go missing.
        setToast({ message: `Invoice created, but the auto purchase entry failed: ${purchaseErr.message}`, type: 'error' })
      } else {
        const purchaseLines = computedLines.map((l, i) => ({
          ...l, invoice_id: purchaseInv.id, line_no: i + 1,
          _id: undefined,
        }))
        await supabase.from('invoice_lines').insert(purchaseLines)
      }
    }

    setSaving(false)
    navigate(`/invoices/${inv.id}`)
  }

  return (
    <div>
      <button onClick={() => navigate('/invoices')} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: '13px', cursor: 'pointer', padding: 0, fontFamily: 'inherit', marginBottom: '4px' }}>← Invoices</button>
      <PageHeader title={fromPiId ? 'Convert PI to Invoice' : 'New Invoice'} />
      <div style={{background:'#e8f3ec',border:'1px solid #b8dfca',borderRadius:'6px',padding:'8px 12px',fontSize:'12px',color:'#1a5c30',marginBottom:'16px'}}>📅 Will be created under <strong>{currentFYLabel()}</strong> — stock movements recorded automatically. Internal buyers get an auto-created purchase entry.</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '100%' }}>
        <Card style={{ padding: '20px' }}>
          <SectionDivider label='Invoice Details' />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginTop: '12px' }}>
            <FormRow label='Invoice Date' required>
              <Input type='date' value={form.invoice_date} onChange={e => setF('invoice_date', e.target.value)} />
            </FormRow>
            <FormRow label='Invoice Number' hint='Leave blank to auto-generate'>
              <Input value={form.invoice_no} onChange={e => setF('invoice_no', e.target.value)} placeholder='Auto-generated if blank' />
            </FormRow>
            <FormRow label='Due Date'>
              <Input type='date' value={form.due_date} onChange={e => setF('due_date', e.target.value)} />
            </FormRow>
            <FormRow label='Type'>
              <Select value={form.invoice_type} onChange={e => setF('invoice_type', e.target.value)}>
                <option value='sales'>Sales Invoice</option>
                <option value='purchase'>Purchase Invoice</option>
              </Select>
            </FormRow>
            <FormRow label='Seller Entity' required>
              <Select value={form.seller_entity_id} onChange={e => setF('seller_entity_id', e.target.value)}>
                <option value=''>Select seller</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Buyer Entity' required>
              <Select value={form.buyer_entity_id} onChange={e => setF('buyer_entity_id', e.target.value)}>
                <option value=''>Select buyer</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Tax Type' hint='Auto-detected from state codes'>
              <Select value={form.is_interstate ? '1' : '0'} onChange={e => setF('is_interstate', e.target.value === '1')}>
                <option value='0'>Local — Same State (CGST + SGST)</option>
                <option value='1'>Interstate — Different State (IGST)</option>
              </Select>
            </FormRow>
            <FormRow label='Linked PI'>
              <Select value={form.pi_id} onChange={e => setF('pi_id', e.target.value)}>
                <option value=''>No PI</option>
                {pis.map(p => <option key={p.id} value={p.id}>{p.pi_no || p.id.slice(0,8)}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Linked PO'>
              <Select value={form.po_id} onChange={e => setF('po_id', e.target.value)}>
                <option value=''>No PO</option>
                {pos.map(p => <option key={p.id} value={p.id}>{p.po_no || p.id.slice(0,8)}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Order'>
              <Select value={form.order_id} onChange={e => { setF('order_id', e.target.value); loadLegs(e.target.value) }}>
                <option value=''>No order</option>
                {orders.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </Select>
            </FormRow>
          </div>
        </Card>

        <Card style={{ padding: '20px' }}>
          <SectionDivider label='Line Items' />
          <div style={{ marginTop: '12px' }}>
            <LineItemsEditor lines={lines} setLines={setLines} interstate={form.is_interstate} hsnMap={hsnMap} />
          </div>
        </Card>

        <Card style={{ padding: '20px' }}>
          <SectionDivider label='E-Invoice (GST Portal)' />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginTop: '12px' }}>
            <FormRow label='IRN'>
              <Input value={form.einvoice_irn} onChange={e => setF('einvoice_irn', e.target.value)} placeholder='Invoice Reference Number' />
            </FormRow>
            <FormRow label='Ack No'>
              <Input value={form.einvoice_ack_no} onChange={e => setF('einvoice_ack_no', e.target.value)} />
            </FormRow>
            <FormRow label='Ack Date'>
              <Input type='date' value={form.einvoice_ack_date} onChange={e => setF('einvoice_ack_date', e.target.value)} />
            </FormRow>
          </div>
        </Card>

        <Card style={{ padding: '20px' }}>
          <SectionDivider label='Billing, Shipping & E-way Bill' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '12px' }}>
            <FormRow label='Bill From'>
              <Input value={form.bill_from} onChange={e => setF('bill_from', e.target.value)} placeholder='Billing address of seller' />
            </FormRow>
            <FormRow label='Bill To'>
              <Input value={form.bill_to} onChange={e => setF('bill_to', e.target.value)} placeholder='Billing address of buyer' />
            </FormRow>
            <FormRow label='Ship From'>
              <Input value={form.ship_from} onChange={e => setF('ship_from', e.target.value)} placeholder='Dispatch location' />
            </FormRow>
            <FormRow label='Ship To'>
              <Input value={form.ship_to} onChange={e => setF('ship_to', e.target.value)} placeholder='Delivery location' />
            </FormRow>
            <FormRow label='E-way Bill No'>
              <Input value={form.eway_bill_no} onChange={e => setF('eway_bill_no', e.target.value)} placeholder='EWB number' />
            </FormRow>
            <FormRow label='E-way Bill Date' hint='Can differ from invoice date'>
              <Input type='date' value={form.eway_bill_date} onChange={e => setF('eway_bill_date', e.target.value)} />
            </FormRow>
          </div>
        </Card>

        {/* CHANGED: TDS/TCS section */}
        <Card style={{ padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <SectionDivider label='TDS / TCS (optional)' />
            <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
              <Btn size='sm' variant='ghost' onClick={() => addTdsRow('tds')}>+ TDS</Btn>
              <Btn size='sm' variant='ghost' onClick={() => addTdsRow('tcs')}>+ TCS</Btn>
            </div>
          </div>
          {tdsEntries.length === 0 ? (
            <div style={{ fontSize: '12px', color: C.textMuted, padding: '8px 0' }}>No TDS/TCS entries. Click + TDS or + TCS to add.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {tdsEntries.map(row => {
                const base   = parseFloat(row.base_amount) || 0
                const amount = Math.round(base * parseFloat(row.rate) / 100)
                return (
                  <div key={row._id} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr 1fr auto', gap: '10px', alignItems: 'center', padding: '10px 12px', background: C.bg, borderRadius: '6px', border: `1px solid ${C.border}` }}>
                    <Badge status={row.type === 'tcs' ? 'export' : 'domestic'} label={row.type.toUpperCase()} />
                    <Select value={row.section} onChange={e => updateTdsRow(row._id, 'section', e.target.value)}>
                      {TDS_SECTIONS.map(s => <option key={s} value={s}>{s} — {TDS_SECTION_LABELS[s]}</option>)}
                    </Select>
                    <FormRow label='Base Amount (₹)'>
                      <Input type='number' value={row.base_amount} onChange={e => updateTdsRow(row._id, 'base_amount', e.target.value)} placeholder='0' />
                    </FormRow>
                    <FormRow label={`Rate % → ₹${amount.toLocaleString('en-IN')}`}>
                      <Input type='number' step='0.01' value={row.rate} onChange={e => updateTdsRow(row._id, 'rate', e.target.value)} />
                    </FormRow>
                    <button onClick={() => removeTdsRow(row._id)} style={{ background: 'none', border: 'none', color: C.danger, cursor: 'pointer', fontSize: '18px', padding: '0 4px' }}>×</button>
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        <Card style={{ padding: '20px' }}>
          <SectionDivider label='Notes' />
          <div style={{ marginTop: '12px' }}>
            <Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} />
          </div>
        </Card>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <Btn variant='ghost' onClick={() => navigate('/invoices')}>Cancel</Btn>
          <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Create Invoice'}</Btn>
        </div>
      </div>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Invoice Detail ───────────────────────────────────────────────────────────
function InvoiceDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [inv, setInv]     = useState(null)
  const [lines, setLines] = useState([])
  const [tdsRows, setTdsRows] = useState([])  // CHANGED: TDS/TCS entries
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  // CHANGED: inline edit state for EWB/Challan and IRN sections
  const [ewbEdit, setEwbEdit]   = useState(false)
  const [ewbForm, setEwbForm]   = useState({})
  const [irnEdit, setIrnEdit]   = useState(false)
  const [irnForm, setIrnForm]   = useState({})
  const [sectSaving, setSectSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: i }, { data: ls }, { data: tds }] = await Promise.all([
      supabase.from('invoices')
        .select('*, seller:seller_entity_id(name,short_name,gstin,state_code,address,city), buyer:buyer_entity_id(name,short_name,gstin,state_code,address,city), orders(name)')
        .eq('id', id).single(),
      supabase.from('invoice_lines').select('*').eq('invoice_id', id).order('line_no'),
      supabase.from('tds_tcs_entries').select('*').eq('invoice_id', id),  // CHANGED
    ])
    setInv(i)
    setLines(ls || [])
    setTdsRows(tds || [])  // CHANGED
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  async function updateStatus(status) {
    await supabase.from('invoices').update({ status, updated_at: new Date() }).eq('id', id)
    setToast({ message: `Invoice ${status}`, type: 'success' })
    load()
  }

  // CHANGED: save EWB + Challan fields
  function openEwbEdit() {
    setEwbForm({
      eway_bill_no:     inv.eway_bill_no     || '',
      eway_bill_date:   inv.eway_bill_date   || '',
      challan_no:       inv.challan_no       || '',
      vehicle_no:       inv.vehicle_no       || '',
      transporter_name: inv.transporter_name || '',
    })
    setEwbEdit(true)
  }
  async function saveEwbForm() {
    setSectSaving(true)
    const { error } = await supabase.from('invoices').update({
      eway_bill_no:     ewbForm.eway_bill_no     || null,
      eway_bill_date:   ewbForm.eway_bill_date   || null,
      challan_no:       ewbForm.challan_no       || null,
      vehicle_no:       ewbForm.vehicle_no       || null,
      transporter_name: ewbForm.transporter_name || null,
      updated_at:       new Date(),
    }).eq('id', id)
    setSectSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setEwbEdit(false)
    setToast({ message: 'E-way Bill & Challan saved', type: 'success' })
    load()
  }

  // CHANGED: save IRN fields
  function openIrnEdit() {
    setIrnForm({
      einvoice_irn:      inv.einvoice_irn      || '',
      einvoice_ack_no:   inv.einvoice_ack_no   || '',
      einvoice_ack_date: inv.einvoice_ack_date || '',
      einvoice_qr_code:  inv.einvoice_qr_code  || '',
    })
    setIrnEdit(true)
  }
  async function saveIrnForm() {
    setSectSaving(true)
    const { error } = await supabase.from('invoices').update({
      einvoice_irn:      irnForm.einvoice_irn      || null,
      einvoice_ack_no:   irnForm.einvoice_ack_no   || null,
      einvoice_ack_date: irnForm.einvoice_ack_date || null,
      einvoice_qr_code:  irnForm.einvoice_qr_code  || null,
      updated_at:        new Date(),
    }).eq('id', id)
    setSectSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setIrnEdit(false)
    setToast({ message: 'E-Invoice IRN saved', type: 'success' })
    load()
  }

  if (loading) return <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
  if (!inv)    return <div style={{ padding: '48px', textAlign: 'center', color: C.danger }}>Invoice not found.</div>

  return (
    <div>
      <button onClick={() => navigate('/invoices')} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: '13px', cursor: 'pointer', padding: 0, fontFamily: 'inherit', marginBottom: '4px' }}>← Invoices</button>
      <PageHeader
        title={inv.invoice_no || `Invoice — ${fmtDate(inv.invoice_date)}`}
        subtitle={`${inv.seller?.name} → ${inv.buyer?.name} · ${fmtDate(inv.invoice_date)}`}
        action={
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            {inv.status === 'draft' && <Btn size='sm' onClick={() => updateStatus('submitted')}>Submit</Btn>}
            {inv.status === 'submitted' && <Btn size='sm' variant='ghost' onClick={() => updateStatus('paid')}>Mark Paid</Btn>}
            {!['cancelled','paid'].includes(inv.status) && <Btn size='sm' variant='ghost' onClick={() => setConfirmCancel(true)} style={{ color: C.danger }}>Cancel</Btn>}
            <Badge status={inv.invoice_type} label={inv.invoice_type === 'sales' ? 'Sales Invoice' : 'Purchase Invoice'} />
            <Badge status={inv.status} />
          </div>
        }
      />

      {/* Seller / Buyer */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
        <Card style={{ padding: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>Seller</div>
          <div style={{ fontWeight: 700, fontSize: '14px' }}>{inv.seller?.name}</div>
          {inv.seller?.gstin && <div style={{ fontSize: '12px', color: C.textSoft, fontFamily: 'monospace' }}>GSTIN: {inv.seller.gstin}</div>}
          {inv.seller?.city  && <div style={{ fontSize: '12px', color: C.textSoft }}>{inv.seller.city}</div>}
        </Card>
        <Card style={{ padding: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>Buyer</div>
          <div style={{ fontWeight: 700, fontSize: '14px' }}>{inv.buyer?.name}</div>
          {inv.buyer?.gstin && <div style={{ fontSize: '12px', color: C.textSoft, fontFamily: 'monospace' }}>GSTIN: {inv.buyer.gstin}</div>}
          {inv.buyer?.city  && <div style={{ fontSize: '12px', color: C.textSoft }}>{inv.buyer.city}</div>}
        </Card>
      </div>

      {/* Details strip */}
      <div style={{ display: 'flex', gap: '20px', marginBottom: '20px', flexWrap: 'wrap', fontSize: '13px' }}>
        <div><span style={{ color: C.textMuted }}>Date:</span> <strong>{fmtDate(inv.invoice_date)}</strong></div>
        {inv.due_date && <div>
          <span style={{ color: C.textMuted }}>Due:</span>{' '}
          <strong style={{ color: inv.due_date < new Date().toISOString().slice(0,10) && inv.status !== 'paid' ? C.danger : C.text }}>
            {fmtDate(inv.due_date)}
          </strong>
        </div>}
        <div><span style={{ color: C.textMuted }}>Tax:</span> <Badge status={inv.is_interstate ? 'export' : 'domestic'} label={inv.is_interstate ? 'Interstate (IGST)' : 'Local (CGST+SGST)'} /></div>
        {inv.einvoice_irn && <div><span style={{ color: C.textMuted }}>IRN:</span> <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>{inv.einvoice_irn}</span></div>}
        {inv.orders?.name && <div><span style={{ color: C.textMuted }}>Order:</span> <strong>{inv.orders.name}</strong></div>}
      </div>

      {/* Outstanding */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px,1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label='Invoice Total' value={formatINR(inv.total_amount)} />
        <StatCard label='Paid' value={formatINR(inv.paid_amount)} color={C.success} />
        <StatCard label='Outstanding' value={formatINR(inv.outstanding_amount)} color={inv.outstanding_amount > 0 ? C.warning : C.success} />
      </div>

      <Card>
        <LineItemsEditor lines={lines.map(l => ({ ...l, _id: l.id }))} setLines={() => {}} interstate={inv.is_interstate} readOnly />
      </Card>

      {(inv.bill_from || inv.bill_to || inv.ship_from || inv.ship_to || inv.eway_bill_no) && (
        <div style={{ marginTop: '12px', padding: '12px 14px', background: '#f8f4ee', borderRadius: '6px', border: `1px solid ${C.border}`, fontSize: '13px' }}>
          <div style={{ fontWeight: 700, marginBottom: '8px', color: C.textMid }}>Billing & Shipping</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 20px' }}>
            {inv.bill_from && <div><span style={{ color: C.textMuted }}>Bill From:</span> {inv.bill_from}</div>}
            {inv.bill_to   && <div><span style={{ color: C.textMuted }}>Bill To:</span> {inv.bill_to}</div>}
            {inv.ship_from && <div><span style={{ color: C.textMuted }}>Ship From:</span> {inv.ship_from}</div>}
            {inv.ship_to   && <div><span style={{ color: C.textMuted }}>Ship To:</span> {inv.ship_to}</div>}
          </div>
        </div>
      )}

      {/* CHANGED: E-way Bill & Challan section */}
      <div style={{ marginTop: '12px', border: `1px solid ${C.border}`, borderRadius: '6px', overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 700, fontSize: '13px', color: C.textMid }}>
            🚛 E-way Bill & Challan
            {(inv.eway_bill_no || inv.challan_no) && (
              <span style={{ marginLeft: 8, fontSize: '11px', fontWeight: 400, color: C.success }}>✓ Filled</span>
            )}
          </div>
          {!ewbEdit && (
            <Btn size='sm' variant='ghost' onClick={openEwbEdit}>
              {(inv.eway_bill_no || inv.challan_no) ? 'Edit' : '+ Add'}
            </Btn>
          )}
        </div>
        {ewbEdit ? (
          <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <FormRow label='EWB Number'>
                <Input value={ewbForm.eway_bill_no} onChange={e => setEwbForm(f => ({...f, eway_bill_no: e.target.value}))} placeholder='e.g. 421234567890' />
              </FormRow>
              <FormRow label='EWB Date'>
                <Input type='date' value={ewbForm.eway_bill_date} onChange={e => setEwbForm(f => ({...f, eway_bill_date: e.target.value}))} />
              </FormRow>
              <FormRow label='Challan No'>
                <Input value={ewbForm.challan_no} onChange={e => setEwbForm(f => ({...f, challan_no: e.target.value}))} placeholder='Transporter challan number' />
              </FormRow>
              <FormRow label='Vehicle No'>
                <Input value={ewbForm.vehicle_no} onChange={e => setEwbForm(f => ({...f, vehicle_no: e.target.value}))} placeholder='e.g. KA01AB1234' />
              </FormRow>
              <FormRow label='Transporter Name' style={{ gridColumn: '1 / -1' }}>
                <Input value={ewbForm.transporter_name} onChange={e => setEwbForm(f => ({...f, transporter_name: e.target.value}))} />
              </FormRow>
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <Btn variant='ghost' onClick={() => setEwbEdit(false)}>Cancel</Btn>
              <Btn onClick={saveEwbForm} disabled={sectSaving}>{sectSaving ? 'Saving…' : 'Save'}</Btn>
            </div>
          </div>
        ) : (inv.eway_bill_no || inv.challan_no || inv.vehicle_no || inv.transporter_name) ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0', fontSize: '13px' }}>
            {[
              ['EWB No',       inv.eway_bill_no],
              ['EWB Date',     fmtDate(inv.eway_bill_date)],
              ['Challan No',   inv.challan_no],
              ['Vehicle No',   inv.vehicle_no],
              ['Transporter',  inv.transporter_name],
            ].filter(([, v]) => v).map(([label, val]) => (
              <div key={label} style={{ padding: '8px 14px', borderTop: `1px solid ${C.border}` }}>
                <span style={{ color: C.textMuted }}>{label}: </span>
                <strong>{val}</strong>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ padding: '12px 14px', fontSize: '12px', color: C.textMuted }}>
            No E-way Bill or Challan details entered. Click <strong>+ Add</strong> to fill in.
          </div>
        )}
      </div>

      {/* CHANGED: E-Invoice IRN section */}
      <div style={{ marginTop: '12px', border: `1px solid ${C.border}`, borderRadius: '6px', overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 700, fontSize: '13px', color: C.textMid }}>
            📄 E-Invoice IRN
            {inv.einvoice_irn && inv.einvoice_ack_no && (
              <span style={{ marginLeft: 8, fontSize: '11px', fontWeight: 400, color: C.success }}>✓ Filled</span>
            )}
          </div>
          {!irnEdit && (
            <Btn size='sm' variant='ghost' onClick={openIrnEdit}>
              {(inv.einvoice_irn || inv.einvoice_ack_no) ? 'Edit' : '+ Add'}
            </Btn>
          )}
        </div>
        {irnEdit ? (
          <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <FormRow label='IRN (Invoice Reference Number)'>
              <Input
                value={irnForm.einvoice_irn}
                onChange={e => setIrnForm(f => ({...f, einvoice_irn: e.target.value}))}
                placeholder='64-character hash from GST portal'
                style={{ fontFamily: 'monospace', fontSize: '12px' }}
              />
            </FormRow>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <FormRow label='Acknowledgement No'>
                <Input
                  value={irnForm.einvoice_ack_no}
                  onChange={e => setIrnForm(f => ({...f, einvoice_ack_no: e.target.value}))}
                  placeholder='Ack number'
                  style={{ fontFamily: 'monospace' }}
                />
              </FormRow>
              <FormRow label='Acknowledgement Date'>
                <Input type='date' value={irnForm.einvoice_ack_date} onChange={e => setIrnForm(f => ({...f, einvoice_ack_date: e.target.value}))} />
              </FormRow>
            </div>
            <FormRow label='QR Code Data'>
              <Textarea
                value={irnForm.einvoice_qr_code}
                onChange={e => setIrnForm(f => ({...f, einvoice_qr_code: e.target.value}))}
                rows={3}
                placeholder='Paste QR code data from signed e-invoice PDF'
                style={{ fontFamily: 'monospace', fontSize: '11px' }}
              />
            </FormRow>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <Btn variant='ghost' onClick={() => setIrnEdit(false)}>Cancel</Btn>
              <Btn onClick={saveIrnForm} disabled={sectSaving}>{sectSaving ? 'Saving…' : 'Save'}</Btn>
            </div>
          </div>
        ) : (inv.einvoice_irn || inv.einvoice_ack_no) ? (
          <div style={{ fontSize: '13px' }}>
            {inv.einvoice_irn && (
              <div style={{ padding: '8px 14px', borderTop: `1px solid ${C.border}` }}>
                <div style={{ fontSize: '10px', color: C.textMuted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>IRN</div>
                <div style={{ fontFamily: 'monospace', fontSize: '11px', wordBreak: 'break-all', color: C.text }}>{inv.einvoice_irn}</div>
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
              {inv.einvoice_ack_no && (
                <div style={{ padding: '8px 14px', borderTop: `1px solid ${C.border}` }}>
                  <span style={{ color: C.textMuted }}>Ack No: </span><strong style={{ fontFamily: 'monospace' }}>{inv.einvoice_ack_no}</strong>
                </div>
              )}
              {inv.einvoice_ack_date && (
                <div style={{ padding: '8px 14px', borderTop: `1px solid ${C.border}` }}>
                  <span style={{ color: C.textMuted }}>Ack Date: </span><strong>{fmtDate(inv.einvoice_ack_date)}</strong>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ padding: '12px 14px', fontSize: '12px', color: C.textMuted }}>
            No IRN entered yet. Click <strong>+ Add</strong> after generating from GST portal.
          </div>
        )}
      </div>
      {inv.notes && <div style={{ marginTop: '12px', fontSize: '13px', color: C.textSoft }}><strong>Notes:</strong> {inv.notes}</div>}

      <div style={{marginTop:'12px',marginBottom:'16px'}}>
        <Btn size='sm' variant='ghost' onClick={()=>downloadCSV(`${inv.invoice_no||'invoice'}_lines_${today()}.csv`,['line_no','description','hsn_code','qty','unit','rate','gst_rate','taxable_amount','cgst_amount','sgst_amount','igst_amount','total_amount'],lines)}>↓ Export Lines CSV</Btn>
      </div>

      {/* CHANGED: TDS/TCS display */}
      {tdsRows.length > 0 && (
        <div style={{ marginTop: '12px', border: `1px solid ${C.border}`, borderRadius: '6px', overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', background: C.bg, fontWeight: 700, fontSize: '13px', color: C.textMid }}>TDS / TCS Entries</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr>{['Type','Section','Description','Base Amount','Rate %','Amount','Paid'].map(h => (
                <th key={h} style={{ padding: '7px 12px', textAlign: h==='Base Amount'||h==='Rate %'||h==='Amount'?'right':'left', fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.05em', background: C.bg, borderBottom: `1px solid ${C.border}` }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {tdsRows.map((r,i) => (
                <tr key={r.id} style={{ background: i%2===0?C.surface:'#faf6ed' }}>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}` }}><Badge status={r.entry_type==='tcs'?'export':'domestic'} label={r.entry_type.toUpperCase()} /></td>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}`, fontFamily: 'monospace', fontWeight: 600 }}>{r.section_code}</td>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}`, color: C.textSoft }}>{r.section_desc || '—'}</td>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}`, textAlign: 'right' }}>{formatINR(r.base_amount)}</td>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}`, textAlign: 'right' }}>{r.rate}%</td>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}`, textAlign: 'right', fontWeight: 700 }}>{formatINR(r.amount)}</td>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}` }}><Badge status={r.is_paid?'paid':'pending'} label={r.is_paid?'Paid':'Pending'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ marginTop: '20px' }}>
        <div style={{ fontWeight: 700, fontSize: '14px', marginBottom: '10px' }}>Documents</div>
        <DocumentAttachments
          sourceType='invoices'
          sourceId={inv.id}
          entityId={inv.seller_entity_id}
          entityName={inv.seller?.name || 'General'}
        />
      </div>

      <ConfirmModal open={confirmCancel} onClose={() => setConfirmCancel(false)} onConfirm={() => { updateStatus('cancelled'); setConfirmCancel(false) }}
        title='Cancel Invoice' message='Cancel this invoice? All GL entries will be reversed.' danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

export default function Invoices() {
  return (
    <Routes>
      <Route index         element={<InvoiceList />} />
      <Route path='new'    element={<NewInvoice />} />
      <Route path=':id'    element={<InvoiceDetail />} />
    </Routes>
  )
}
