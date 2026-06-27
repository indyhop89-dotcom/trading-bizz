import { useState, useEffect } from 'react'
import { supabase } from '../../supabaseClient'
import { C, Card, FormRow, Select, Spinner, StatCard, Badge } from '../../components/UI/index'
import { formatINR } from '../../utils/money'
import { fmtDate, fyOptions } from '../../utils/dates'

const TABS = ['P&L', 'GST Summary', 'Ledger']

// ─── P&L Report ───────────────────────────────────────────────────────────────
function PLReport({ entities, fys }) {
  const [entityId, setEntityId] = useState('')
  const [fyId, setFyId]         = useState('')
  const [data, setData]         = useState(null)
  const [loading, setLoading]   = useState(false)

  async function runReport() {
    if (!entityId) return
    setLoading(true)

    // For selected entity, get:
    // Sales: invoices where seller_entity_id = entityId
    // Purchases: invoices where buyer_entity_id = entityId
    // Expenses: expenses where entity_id = entityId
    const fyFilter = fys.find(f => f.id === fyId)

    let salesQ = supabase.from('invoices')
      .select('id,total_amount,taxable_amount,cgst_amount,sgst_amount,igst_amount,invoice_date')
      .eq('seller_entity_id', entityId).eq('is_deleted', false)
      .neq('status', 'cancelled')

    let purchasesQ = supabase.from('invoices')
      .select('id,total_amount,taxable_amount,cgst_amount,sgst_amount,igst_amount,invoice_date')
      .eq('buyer_entity_id', entityId).eq('is_deleted', false)
      .neq('status', 'cancelled')

    let expensesQ = supabase.from('expenses')
      .select('id,total_amount,amount,gst_amount,expense_type,expense_date')
      .eq('entity_id', entityId).eq('is_deleted', false)

    if (fyFilter) {
      salesQ     = salesQ.gte('invoice_date', fyFilter.start_date).lte('invoice_date', fyFilter.end_date)
      purchasesQ = purchasesQ.gte('invoice_date', fyFilter.start_date).lte('invoice_date', fyFilter.end_date)
      expensesQ  = expensesQ.gte('expense_date', fyFilter.start_date).lte('expense_date', fyFilter.end_date)
    }

    const [{ data: sales }, { data: purchases }, { data: expenses }] = await Promise.all([salesQ, purchasesQ, expensesQ])

    const totalSales     = (sales || []).reduce((s, i) => s + i.taxable_amount, 0)
    const totalPurchases = (purchases || []).reduce((s, i) => s + i.taxable_amount, 0)
    const totalExpenses  = (expenses || []).reduce((s, e) => s + e.amount, 0)
    const grossProfit    = totalSales - totalPurchases
    const netProfit      = grossProfit - totalExpenses

    // Expense breakdown by type
    const expenseByType = {}
    ;(expenses || []).forEach(e => {
      expenseByType[e.expense_type] = (expenseByType[e.expense_type] || 0) + e.amount
    })

    setData({ totalSales, totalPurchases, grossProfit, totalExpenses, netProfit, expenseByType, salesCount: (sales || []).length, purchasesCount: (purchases || []).length })
    setLoading(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <FormRow label='Entity'>
          <Select value={entityId} onChange={e => setEntityId(e.target.value)} style={{ minWidth: '200px' }}>
            <option value=''>Select entity</option>
            {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
          </Select>
        </FormRow>
        <FormRow label='Financial Year'>
          <Select value={fyId} onChange={e => setFyId(e.target.value)} style={{ minWidth: '160px' }}>
            <option value=''>All time</option>
            {fys.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </FormRow>
        <button onClick={runReport} disabled={!entityId || loading}
          style={{ padding: '8px 18px', background: C.accent, color: '#f5f0e8', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: !entityId ? 'not-allowed' : 'pointer', opacity: !entityId ? 0.5 : 1, fontFamily: 'inherit' }}>
          {loading ? 'Running…' : 'Run Report'}
        </button>
      </div>

      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '12px' }}>
            <StatCard label='Sales (Taxable)' value={formatINR(data.totalSales)} sub={`${data.salesCount} invoices`} />
            <StatCard label='Purchases (Taxable)' value={formatINR(data.totalPurchases)} sub={`${data.purchasesCount} invoices`} />
            <StatCard label='Gross Profit' value={formatINR(data.grossProfit)} color={data.grossProfit >= 0 ? C.success : C.danger} />
            <StatCard label='Expenses' value={formatINR(data.totalExpenses)} color={C.warning} />
            <StatCard label='Net Profit' value={formatINR(data.netProfit)} color={data.netProfit >= 0 ? C.success : C.danger} sub={data.totalSales > 0 ? `${((data.netProfit / data.totalSales) * 100).toFixed(1)}% margin` : undefined} />
          </div>

          {Object.keys(data.expenseByType).length > 0 && (
            <Card style={{ padding: '16px' }}>
              <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '12px' }}>Expense Breakdown</div>
              {Object.entries(data.expenseByType).map(([type, amount]) => (
                <div key={type} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${C.border}`, fontSize: '13px' }}>
                  <span style={{ textTransform: 'capitalize', color: C.textMid }}>{type}</span>
                  <span style={{ fontWeight: 600 }}>{formatINR(amount)}</span>
                </div>
              ))}
            </Card>
          )}
        </>
      )}
    </div>
  )
}

// ─── GST Summary ─────────────────────────────────────────────────────────────
function GSTSummary({ entities, fys }) {
  const [entityId, setEntityId] = useState('')
  const [fyId, setFyId]         = useState('')
  const [data, setData]         = useState(null)
  const [loading, setLoading]   = useState(false)

  async function runReport() {
    if (!entityId) return
    setLoading(true)
    const fyFilter = fys.find(f => f.id === fyId)

    let salesQ = supabase.from('invoices')
      .select('id,total_amount,taxable_amount,cgst_amount,sgst_amount,igst_amount,is_interstate,invoice_date,buyer:buyer_entity_id(gstin,name)')
      .eq('seller_entity_id', entityId).eq('is_deleted', false).neq('status', 'cancelled')

    let purchasesQ = supabase.from('invoices')
      .select('id,total_amount,taxable_amount,cgst_amount,sgst_amount,igst_amount,is_interstate,invoice_date,seller:seller_entity_id(gstin,name)')
      .eq('buyer_entity_id', entityId).eq('is_deleted', false).neq('status', 'cancelled')

    if (fyFilter) {
      salesQ     = salesQ.gte('invoice_date', fyFilter.start_date).lte('invoice_date', fyFilter.end_date)
      purchasesQ = purchasesQ.gte('invoice_date', fyFilter.start_date).lte('invoice_date', fyFilter.end_date)
    }

    const [{ data: sales }, { data: purchases }] = await Promise.all([salesQ, purchasesQ])

    // Output tax
    const outputTaxable = (sales || []).reduce((s, i) => s + i.taxable_amount, 0)
    const outputCGST    = (sales || []).reduce((s, i) => s + i.cgst_amount, 0)
    const outputSGST    = (sales || []).reduce((s, i) => s + i.sgst_amount, 0)
    const outputIGST    = (sales || []).reduce((s, i) => s + i.igst_amount, 0)

    // Input tax
    const inputTaxable  = (purchases || []).reduce((s, i) => s + i.taxable_amount, 0)
    const inputCGST     = (purchases || []).reduce((s, i) => s + i.cgst_amount, 0)
    const inputSGST     = (purchases || []).reduce((s, i) => s + i.sgst_amount, 0)
    const inputIGST     = (purchases || []).reduce((s, i) => s + i.igst_amount, 0)

    const payableCGST = Math.max(0, outputCGST - inputCGST)
    const payableSGST = Math.max(0, outputSGST - inputSGST)
    const payableIGST = Math.max(0, outputIGST - inputIGST)

    setData({ outputTaxable, outputCGST, outputSGST, outputIGST, inputTaxable, inputCGST, inputSGST, inputIGST, payableCGST, payableSGST, payableIGST })
    setLoading(false)
  }

  const TaxRow = ({ label, taxable, cgst, sgst, igst }) => (
    <tr>
      <td style={{ padding: '10px 14px', fontWeight: 600 }}>{label}</td>
      <td style={{ padding: '10px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatINR(taxable)}</td>
      <td style={{ padding: '10px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatINR(cgst)}</td>
      <td style={{ padding: '10px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatINR(sgst)}</td>
      <td style={{ padding: '10px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatINR(igst)}</td>
      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatINR(cgst + sgst + igst)}</td>
    </tr>
  )

  const thStyle = { padding: '10px 14px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em', textAlign: 'right' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <FormRow label='Entity'>
          <Select value={entityId} onChange={e => setEntityId(e.target.value)} style={{ minWidth: '200px' }}>
            <option value=''>Select entity</option>
            {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
          </Select>
        </FormRow>
        <FormRow label='Financial Year'>
          <Select value={fyId} onChange={e => setFyId(e.target.value)} style={{ minWidth: '160px' }}>
            <option value=''>All time</option>
            {fys.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </FormRow>
        <button onClick={runReport} disabled={!entityId || loading}
          style={{ padding: '8px 18px', background: C.accent, color: '#f5f0e8', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: !entityId ? 'not-allowed' : 'pointer', opacity: !entityId ? 0.5 : 1, fontFamily: 'inherit' }}>
          {loading ? 'Running…' : 'Run Report'}
        </button>
      </div>

      {data && (
        <Card>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr>
                  <th style={{ ...thStyle, textAlign: 'left' }}>Section</th>
                  <th style={thStyle}>Taxable</th>
                  <th style={thStyle}>CGST</th>
                  <th style={thStyle}>SGST</th>
                  <th style={thStyle}>IGST</th>
                  <th style={thStyle}>Total Tax</th>
                </tr>
              </thead>
              <tbody>
                <TaxRow label='Output Tax (Sales)' taxable={data.outputTaxable} cgst={data.outputCGST} sgst={data.outputSGST} igst={data.outputIGST} />
                <TaxRow label='Input Tax Credit (Purchases)' taxable={data.inputTaxable} cgst={data.inputCGST} sgst={data.inputSGST} igst={data.inputIGST} />
                <tr style={{ background: '#f0ebe0' }}>
                  <td style={{ padding: '10px 14px', fontWeight: 700, color: C.danger }}>Net Payable</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' }}>—</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: C.danger, fontVariantNumeric: 'tabular-nums' }}>{formatINR(data.payableCGST)}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: C.danger, fontVariantNumeric: 'tabular-nums' }}>{formatINR(data.payableSGST)}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: C.danger, fontVariantNumeric: 'tabular-nums' }}>{formatINR(data.payableIGST)}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontSize: '15px', color: C.danger, fontVariantNumeric: 'tabular-nums' }}>{formatINR(data.payableCGST + data.payableSGST + data.payableIGST)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

// ─── Ledger ───────────────────────────────────────────────────────────────────
function Ledger({ entities, fys }) {
  const [ourEntityId, setOurEntity] = useState('')
  const [partyId, setPartyId]       = useState('all')
  const [fyId, setFyId]             = useState('')
  const [rows, setRows]             = useState([])
  const [loading, setLoading]       = useState(false)

  async function runReport() {
    if (!ourEntityId) return
    setLoading(true)
    const fyFilter = fys.find(f => f.id === fyId)
    const dateFilter = (q) => fyFilter ? q.gte('date', fyFilter.start_date).lte('date', fyFilter.end_date) : q

    // Sales invoices (Dr for our entity)
    let salesQ = supabase.from('invoices')
      .select('id,invoice_no,invoice_date,total_amount,buyer_entity_id,buyer:buyer_entity_id(name,short_name)')
      .eq('seller_entity_id', ourEntityId).eq('is_deleted', false).neq('status', 'cancelled')
    if (partyId !== 'all') salesQ = salesQ.eq('buyer_entity_id', partyId)
    if (fyFilter) salesQ = salesQ.gte('invoice_date', fyFilter.start_date).lte('invoice_date', fyFilter.end_date)

    // Purchase invoices (Cr for our entity)
    let purchasesQ = supabase.from('invoices')
      .select('id,invoice_no,invoice_date,total_amount,seller_entity_id,seller:seller_entity_id(name,short_name)')
      .eq('buyer_entity_id', ourEntityId).eq('is_deleted', false).neq('status', 'cancelled')
    if (partyId !== 'all') purchasesQ = purchasesQ.eq('seller_entity_id', partyId)
    if (fyFilter) purchasesQ = purchasesQ.gte('invoice_date', fyFilter.start_date).lte('invoice_date', fyFilter.end_date)

    // Receipts (Cr for our entity)
    let receiptsQ = supabase.from('payments')
      .select('id,payment_no,payment_date,net_amount,party_entity_id,party:party_entity_id(name,short_name),party_name')
      .eq('entity_id', ourEntityId).eq('payment_type', 'receipt').eq('is_deleted', false)
    if (partyId !== 'all') receiptsQ = receiptsQ.eq('party_entity_id', partyId)
    if (fyFilter) receiptsQ = receiptsQ.gte('payment_date', fyFilter.start_date).lte('payment_date', fyFilter.end_date)

    // Payments sent (Dr for our entity)
    let paymentsQ = supabase.from('payments')
      .select('id,payment_no,payment_date,net_amount,party_entity_id,party:party_entity_id(name,short_name),party_name')
      .eq('entity_id', ourEntityId).eq('payment_type', 'payment').eq('is_deleted', false)
    if (partyId !== 'all') paymentsQ = paymentsQ.eq('party_entity_id', partyId)
    if (fyFilter) paymentsQ = paymentsQ.gte('payment_date', fyFilter.start_date).lte('payment_date', fyFilter.end_date)

    const [{ data: sales }, { data: purchases }, { data: receipts }, { data: paymentsMade }] = await Promise.all([salesQ, purchasesQ, receiptsQ, paymentsQ])

    // Bill Discounting — disbursements (Dr: money received from bank) and repayments (Cr: money sent back)
    let bdEventsQ = supabase.from('bill_discounting_events')
      .select('id,discounting_date,net_proceeds,bank_name,bank:bank_id(name,short_name)')
      .eq('entity_id', ourEntityId).eq('is_deleted', false)
    if (fyFilter) bdEventsQ = bdEventsQ.gte('discounting_date', fyFilter.start_date).lte('discounting_date', fyFilter.end_date)

    let bdRepaysQ = supabase.from('bill_discounting_repayments')
      .select('id,repayment_date,amount,interest_amount,total_payment,event_id, event:event_id(entity_id,bank_name,bank:bank_id(name,short_name))')
      .order('repayment_date')
    if (fyFilter) bdRepaysQ = bdRepaysQ.gte('repayment_date', fyFilter.start_date).lte('repayment_date', fyFilter.end_date)

    const [{ data: bdEvents }, { data: bdRepays }] = await Promise.all([bdEventsQ, bdRepaysQ])

    // Filter repayments to this entity
    const myRepays = (bdRepays || []).filter(r => r.event?.entity_id === ourEntityId)

    const ledgerRows = [
      ...(sales || []).map(i => ({ date: i.invoice_date, doc: i.invoice_no, party: i.buyer?.short_name || i.buyer?.name, type: 'Sales Invoice', dr: i.total_amount, cr: 0, _raw: i })),
      ...(paymentsMade || []).map(p => ({ date: p.payment_date, doc: p.payment_no, party: p.party?.short_name || p.party?.name || p.party_name, type: 'Payment Out', dr: p.net_amount, cr: 0, _raw: p })),
      ...(purchases || []).map(i => ({ date: i.invoice_date, doc: i.invoice_no, party: i.seller?.short_name || i.seller?.name, type: 'Purchase Invoice', dr: 0, cr: i.total_amount, _raw: i })),
      ...(receipts || []).map(p => ({ date: p.payment_date, doc: p.payment_no, party: p.party?.short_name || p.party?.name || p.party_name, type: 'Receipt', dr: 0, cr: p.net_amount, _raw: p })),
      // Bill Discounting — disbursement is Dr (cash in), repayment is Cr (cash out)
      ...(bdEvents || []).map(e => ({ date: e.discounting_date, doc: '—', party: e.bank?.name || e.bank_name, type: 'BD Disbursement', dr: e.net_proceeds || 0, cr: 0, _raw: e })),
      ...myRepays.map(r => ({ date: r.repayment_date, doc: '—', party: r.event?.bank?.name || r.event?.bank_name, type: 'BD Repayment', dr: 0, cr: (r.total_payment || r.amount) || 0, _raw: r })),
    ].sort((a, b) => new Date(a.date) - new Date(b.date))

    // Add running balance
    let balance = 0
    const withBalance = ledgerRows.map(r => {
      balance += r.dr - r.cr
      return { ...r, balance }
    })

    setRows(withBalance)
    setLoading(false)
  }

  const totalDr = rows.reduce((s, r) => s + r.dr, 0)
  const totalCr = rows.reduce((s, r) => s + r.cr, 0)
  const netBalance = totalDr - totalCr

  const th = { padding: '9px 12px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <FormRow label='Our Entity'>
          <Select value={ourEntityId} onChange={e => setOurEntity(e.target.value)} style={{ minWidth: '180px' }}>
            <option value=''>Select entity</option>
            {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
          </Select>
        </FormRow>
        <FormRow label='Party'>
          <Select value={partyId} onChange={e => setPartyId(e.target.value)} style={{ minWidth: '180px' }}>
            <option value='all'>All parties</option>
            {entities.filter(e => e.id !== ourEntityId).map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
          </Select>
        </FormRow>
        <FormRow label='Financial Year'>
          <Select value={fyId} onChange={e => setFyId(e.target.value)} style={{ minWidth: '160px' }}>
            <option value=''>All time</option>
            {fys.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </FormRow>
        <button onClick={runReport} disabled={!ourEntityId || loading}
          style={{ padding: '8px 18px', background: C.accent, color: '#f5f0e8', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: !ourEntityId ? 'not-allowed' : 'pointer', opacity: !ourEntityId ? 0.5 : 1, fontFamily: 'inherit' }}>
          {loading ? 'Running…' : 'Run Report'}
        </button>
      </div>

      {rows.length > 0 && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px' }}>
            <StatCard label='Total Debit'  value={formatINR(totalDr)} />
            <StatCard label='Total Credit' value={formatINR(totalCr)} />
            <StatCard label='Net Balance'  value={formatINR(Math.abs(netBalance))} sub={netBalance >= 0 ? 'Debit balance (owed to us)' : 'Credit balance (we owe)'} color={netBalance >= 0 ? C.success : C.danger} />
          </div>

          <Card>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: 'left' }}>Date</th>
                    <th style={{ ...th, textAlign: 'left' }}>Document</th>
                    <th style={{ ...th, textAlign: 'left' }}>Party</th>
                    <th style={{ ...th, textAlign: 'left' }}>Type</th>
                    <th style={{ ...th, textAlign: 'right' }}>Debit (Dr)</th>
                    <th style={{ ...th, textAlign: 'right' }}>Credit (Cr)</th>
                    <th style={{ ...th, textAlign: 'right' }}>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? C.surface : '#faf6ed' }}>
                      <td style={{ padding: '9px 12px', borderBottom: `1px solid #f0e8d8` }}>{fmtDate(r.date)}</td>
                      <td style={{ padding: '9px 12px', borderBottom: `1px solid #f0e8d8`, fontFamily: 'monospace', fontSize: '12px' }}>{r.doc || '—'}</td>
                      <td style={{ padding: '9px 12px', borderBottom: `1px solid #f0e8d8`, color: C.textSoft }}>{r.party || '—'}</td>
                      <td style={{ padding: '9px 12px', borderBottom: `1px solid #f0e8d8` }}>
                        <span style={{ fontSize: '11px', background: r.type==='BD Disbursement'?'#e8f0f3':r.type==='BD Repayment'?'#f3e8f0':r.dr > 0 ? '#e8f3ec' : '#f3ede8', color: r.type==='BD Disbursement'?'#1a4a6a':r.type==='BD Repayment'?'#6a1a4a':r.dr > 0 ? C.success : C.warning, padding: '2px 7px', borderRadius: '4px', fontWeight: 600 }}>{r.type}</span>
                      </td>
                      <td style={{ padding: '9px 12px', borderBottom: `1px solid #f0e8d8`, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: r.dr > 0 ? C.success : C.textMuted }}>{r.dr > 0 ? formatINR(r.dr) : '—'}</td>
                      <td style={{ padding: '9px 12px', borderBottom: `1px solid #f0e8d8`, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: r.cr > 0 ? C.warning : C.textMuted }}>{r.cr > 0 ? formatINR(r.cr) : '—'}</td>
                      <td style={{ padding: '9px 12px', borderBottom: `1px solid #f0e8d8`, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: r.balance >= 0 ? C.text : C.danger }}>{formatINR(Math.abs(r.balance))} {r.balance < 0 ? 'Cr' : 'Dr'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ background: '#f0ebe0' }}>
                    <td colSpan={4} style={{ padding: '10px 12px', fontWeight: 700 }}>Closing Balance</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: C.success }}>{formatINR(totalDr)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: C.warning }}>{formatINR(totalCr)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', fontSize: '14px', color: netBalance >= 0 ? C.success : C.danger }}>
                      {formatINR(Math.abs(netBalance))} {netBalance < 0 ? 'Cr' : 'Dr'}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        </>
      )}

      {!loading && rows.length === 0 && ourEntityId && (
        <div style={{ textAlign: 'center', padding: '48px', color: C.textMuted, fontSize: '13px' }}>
          Click "Run Report" to generate the ledger.
        </div>
      )}
    </div>
  )
}

// ─── Reports Shell ────────────────────────────────────────────────────────────
export default function Reports() {
  const [tab, setTab]           = useState('P&L')
  const [entities, setEntities] = useState([])
  const [fys, setFys]           = useState([])

  useEffect(() => {
    Promise.all([
      supabase.from('entities').select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('financial_years').select('*').order('start_date', { ascending: false }),
    ]).then(([{ data: es }, { data: fyData }]) => {
      setEntities(es || [])
      setFys(fyData || [])
    })
  }, [])

  return (
    <div>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: '20px', fontWeight: 700, color: C.text, margin: 0 }}>Reports</h1>
        <p style={{ fontSize: '13px', color: C.textMuted, margin: '4px 0 0' }}>Financial and operational reports</p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '24px', borderBottom: `2px solid ${C.border}`, paddingBottom: '0' }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              padding: '8px 20px', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              fontWeight: tab === t ? 700 : 500, fontSize: '13px',
              color: tab === t ? C.text : C.textSoft,
              background: 'transparent',
              borderBottom: tab === t ? `2px solid ${C.accent}` : '2px solid transparent',
              marginBottom: '-2px', transition: 'all 0.15s',
            }}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'P&L'         && <PLReport entities={entities} fys={fys} />}
      {tab === 'GST Summary' && <GSTSummary entities={entities} fys={fys} />}
      {tab === 'Ledger'      && <Ledger entities={entities} fys={fys} />}
    </div>
  )
}
