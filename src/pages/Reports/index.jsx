import { useState, useEffect } from 'react'
import { supabase } from '../../supabaseClient'
import { fetchAllPages } from '../../utils/query'
import { C, Card, FormRow, Select, Spinner, StatCard, Badge } from '../../components/UI/index'
import { formatINR } from '../../utils/money'
import { fmtDate, fyOptions, today } from '../../utils/dates'
import { useEntityAccess } from '../../hooks/useEntityAccess'
import { fetchStockMovementData, buildActualStockMap } from '../../utils/stock'
import { computeInvoiceOutstanding, groupTranchesByInvoice } from '../../utils/payments'

const TABS = ['P&L', 'GST Summary', 'Ledger', 'Profitability', 'Actual Stock', 'Stock Movements', 'Missing Products', 'Ageing']

// ─── P&L Report ───────────────────────────────────────────────────────────────
function PLReport({ entities, fys, defaultEntityId }) {
  const [entityId, setEntityId] = useState('')
  useEffect(() => { if (defaultEntityId && !entityId) setEntityId(defaultEntityId) }, [defaultEntityId]) // eslint-disable-line react-hooks/exhaustive-deps
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
function GSTSummary({ entities, fys, defaultEntityId }) {
  const [entityId, setEntityId] = useState('')
  useEffect(() => { if (defaultEntityId && !entityId) setEntityId(defaultEntityId) }, [defaultEntityId]) // eslint-disable-line react-hooks/exhaustive-deps
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

    // CHANGED: TDS/TCS summary — deducted_by_entity_id is a liability (we owe
    // this to the government), deductee_entity_id is a credit (someone else
    // already deducted it on our behalf, we claim it against our own tax).
    const { data: tdsEntries } = await supabase
      .from('tds_tcs_entries')
      .select('id, entry_type, base_amount, amount, deducted_by_entity_id, deductee_entity_id, invoice:invoice_id(invoice_date)')
      .or(`deducted_by_entity_id.eq.${entityId},deductee_entity_id.eq.${entityId}`)

    const tdsFiltered = (tdsEntries || []).filter(t => !fyFilter || !t.invoice?.invoice_date ||
      (t.invoice.invoice_date >= fyFilter.start_date && t.invoice.invoice_date <= fyFilter.end_date))

    const sumWhere = (type, side) => tdsFiltered
      .filter(t => t.entry_type === type && t[side] === entityId)
      .reduce((s, t) => s + (Number(t.amount) || 0), 0)

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

    setData({
      outputTaxable, outputCGST, outputSGST, outputIGST, inputTaxable, inputCGST, inputSGST, inputIGST, payableCGST, payableSGST, payableIGST,
      tdsDeducted: sumWhere('tds', 'deducted_by_entity_id'), // liability — pay to govt
      tdsCredit:   sumWhere('tds', 'deductee_entity_id'),    // credit — claim against our own tax
      tcsCollected: sumWhere('tcs', 'deducted_by_entity_id'),
      tcsCredit:    sumWhere('tcs', 'deductee_entity_id'),
    })
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

      {data && (
        <Card>
          <div style={{ padding: '12px 16px', fontWeight: 700, fontSize: '14px', borderBottom: `1px solid ${C.border}` }}>TDS / TCS Summary</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', gap: '12px', padding: '14px 16px' }}>
            <StatCard label='TDS Deducted (payable to govt)' value={formatINR(data.tdsDeducted)} color={data.tdsDeducted > 0 ? C.danger : C.textMuted} />
            <StatCard label='TDS Credit (deducted by others)' value={formatINR(data.tdsCredit)} color={data.tdsCredit > 0 ? C.success : C.textMuted} />
            <StatCard label='TCS Collected (payable to govt)' value={formatINR(data.tcsCollected)} color={data.tcsCollected > 0 ? C.danger : C.textMuted} />
            <StatCard label='TCS Credit (collected by others)' value={formatINR(data.tcsCredit)} color={data.tcsCredit > 0 ? C.success : C.textMuted} />
          </div>
        </Card>
      )}
    </div>
  )
}

// ─── Ledger ───────────────────────────────────────────────────────────────────
function Ledger({ entities, fys, defaultEntityId }) {
  const [ourEntityId, setOurEntity] = useState('')
  useEffect(() => { if (defaultEntityId && !ourEntityId) setOurEntity(defaultEntityId) }, [defaultEntityId]) // eslint-disable-line react-hooks/exhaustive-deps
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

// ─── Entity-wise Profitability ──────────────────────────────────────────────────
// Same underlying math as the single-entity P&L tab, but computed for every
// entity at once so entities can be compared side by side rather than
// checked one at a time.
function ProfitabilityReport({ entities, fys }) {
  const [fyId, setFyId]       = useState('')
  const [rows, setRows]       = useState(null)
  const [loading, setLoading] = useState(false)

  async function runReport() {
    setLoading(true)
    const fyFilter = fys.find(f => f.id === fyId)
    let salesQ     = supabase.from('invoices').select('seller_entity_id, taxable_amount, invoice_date').eq('is_deleted', false).neq('status', 'cancelled')
    let purchasesQ = supabase.from('invoices').select('buyer_entity_id, taxable_amount, invoice_date').eq('is_deleted', false).neq('status', 'cancelled')
    let expensesQ  = supabase.from('expenses').select('entity_id, amount, expense_date').eq('is_deleted', false)
    if (fyFilter) {
      salesQ     = salesQ.gte('invoice_date', fyFilter.start_date).lte('invoice_date', fyFilter.end_date)
      purchasesQ = purchasesQ.gte('invoice_date', fyFilter.start_date).lte('invoice_date', fyFilter.end_date)
      expensesQ  = expensesQ.gte('expense_date', fyFilter.start_date).lte('expense_date', fyFilter.end_date)
    }
    const [{ data: sales }, { data: purchases }, { data: expenses }] = await Promise.all([salesQ, purchasesQ, expensesQ])

    const byEntity = new Map()
    function ensure(id) {
      if (!id) return null
      if (!byEntity.has(id)) byEntity.set(id, { sales: 0, purchases: 0, expenses: 0 })
      return byEntity.get(id)
    }
    for (const s of (sales || []))     { const r = ensure(s.seller_entity_id); if (r) r.sales += s.taxable_amount }
    for (const p of (purchases || [])) { const r = ensure(p.buyer_entity_id);  if (r) r.purchases += p.taxable_amount }
    for (const e of (expenses || []))  { const r = ensure(e.entity_id);       if (r) r.expenses += e.amount }

    const entityById = Object.fromEntries(entities.map(e => [e.id, e]))
    const result = [...byEntity.entries()]
      .map(([id, v]) => {
        const grossProfit = v.sales - v.purchases
        const netProfit    = grossProfit - v.expenses
        return { entity: entityById[id], ...v, grossProfit, netProfit, margin: v.sales > 0 ? (netProfit / v.sales * 100) : null }
      })
      .sort((a, b) => b.netProfit - a.netProfit)
    setRows(result)
    setLoading(false)
  }

  const th = { padding: '9px 12px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <FormRow label='Financial Year'>
          <Select value={fyId} onChange={e => setFyId(e.target.value)} style={{ minWidth: '160px' }}>
            <option value=''>All time</option>
            {fys.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </FormRow>
        <button onClick={runReport} disabled={loading}
          style={{ padding: '8px 18px', background: C.accent, color: '#f5f0e8', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit' }}>
          {loading ? 'Running…' : 'Run Report'}
        </button>
      </div>
      {rows && (
        <Card>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead><tr>
                <th style={{ ...th, textAlign: 'left' }}>Entity</th>
                <th style={{ ...th, textAlign: 'right' }}>Sales</th>
                <th style={{ ...th, textAlign: 'right' }}>Purchases</th>
                <th style={{ ...th, textAlign: 'right' }}>Gross Profit</th>
                <th style={{ ...th, textAlign: 'right' }}>Expenses</th>
                <th style={{ ...th, textAlign: 'right' }}>Net Profit</th>
                <th style={{ ...th, textAlign: 'right' }}>Margin</th>
              </tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? C.surface : '#faf6ed' }}>
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', fontWeight: 600 }}>{r.entity?.short_name || r.entity?.name || '—'}</td>
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right' }}>{formatINR(r.sales)}</td>
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right' }}>{formatINR(r.purchases)}</td>
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right' }}>{formatINR(r.grossProfit)}</td>
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right', color: C.warning }}>{formatINR(r.expenses)}</td>
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right', fontWeight: 700, color: r.netProfit >= 0 ? C.success : C.danger }}>{formatINR(r.netProfit)}</td>
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right' }}>{r.margin === null ? '—' : `${r.margin >= 0 ? '+' : ''}${r.margin.toFixed(1)}%`}</td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={7} style={{ padding: '24px', textAlign: 'center', color: C.textMuted }}>No data for this selection.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

// ─── Entity-wise Actual Stock ─────────────────────────────────────────────────
// Reuses the exact same calc that powers the Stock page and LineItemsEditor's
// availability check — one source of truth, never a second stock report that
// could drift from what Stock Position shows.
function ActualStockReport({ entities, defaultEntityId }) {
  const [entityId, setEntityId] = useState('')
  useEffect(() => { if (defaultEntityId && !entityId) setEntityId(defaultEntityId) }, [defaultEntityId]) // eslint-disable-line react-hooks/exhaustive-deps
  const [rows, setRows]     = useState(null)
  const [loading, setLoading] = useState(false)

  async function runReport() {
    setLoading(true)
    const [raw, { data: products }] = await Promise.all([
      fetchStockMovementData(),
      fetchAllPages(() => supabase.from('products').select('id,name,hsn_code,unit,category')),
    ])
    const map = buildActualStockMap(raw)
    const productById = Object.fromEntries((products || []).map(p => [p.id, p]))
    const entityById  = Object.fromEntries(entities.map(e => [e.id, e]))
    let result = Object.values(map).filter(r => r.product_id) // unmapped lines covered by the Missing Products report instead
    if (entityId) result = result.filter(r => r.entity_id === entityId)
    result = result
      .map(r => ({ ...r, entity: entityById[r.entity_id], product: productById[r.product_id] }))
      .sort((a, b) => (a.entity?.name || '').localeCompare(b.entity?.name || '') || (a.product?.name || '').localeCompare(b.product?.name || ''))
    setRows(result)
    setLoading(false)
  }

  const th = { padding: '9px 12px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em' }
  const totalQty = (rows || []).reduce((s, r) => s + r.actual_qty, 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <FormRow label='Entity'>
          <Select value={entityId} onChange={e => setEntityId(e.target.value)} style={{ minWidth: '200px' }}>
            <option value=''>All entities</option>
            {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
          </Select>
        </FormRow>
        <button onClick={runReport} disabled={loading}
          style={{ padding: '8px 18px', background: C.accent, color: '#f5f0e8', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit' }}>
          {loading ? 'Running…' : 'Run Report'}
        </button>
      </div>

      {rows && (
        <>
          <StatCard label='Rows' value={rows.length} sub={`${totalQty.toLocaleString('en-IN')} total units across shown rows`} />
          <Card>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead><tr>
                  <th style={{ ...th, textAlign: 'left' }}>Entity</th>
                  <th style={{ ...th, textAlign: 'left' }}>Product</th>
                  <th style={{ ...th, textAlign: 'left' }}>Category</th>
                  <th style={{ ...th, textAlign: 'right' }}>Opening</th>
                  <th style={{ ...th, textAlign: 'right' }}>Invoiced In</th>
                  <th style={{ ...th, textAlign: 'right' }}>Invoiced Out</th>
                  <th style={{ ...th, textAlign: 'right' }}>Actual Stock</th>
                </tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? C.surface : '#faf6ed' }}>
                      <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', fontWeight: 600 }}>{r.entity?.short_name || r.entity?.name || '—'}</td>
                      <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8' }}>{r.product?.name || '—'}</td>
                      <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', color: C.textSoft }}>{r.product?.category || '—'}</td>
                      <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right' }}>{r.opening_qty.toLocaleString('en-IN')}</td>
                      <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right', color: C.success }}>+{r.invoiced_in.toLocaleString('en-IN')}</td>
                      <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right', color: C.warning }}>−{r.invoiced_out.toLocaleString('en-IN')}</td>
                      <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right', fontWeight: 700, color: r.actual_qty < 0 ? C.danger : C.text }}>{r.actual_qty.toLocaleString('en-IN')}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={7} style={{ padding: '24px', textAlign: 'center', color: C.textMuted }}>No stock for this selection.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}

// ─── Stock Movement by E-way Bill ──────────────────────────────────────────────
// Every row here is a real, physical stock movement — the same set of lines
// fetchStockMovementData() counts toward Actual Stock, just shown one line
// at a time instead of aggregated.
function StockMovementReport({ entities }) {
  const [rows, setRows]       = useState(null)
  const [loading, setLoading] = useState(false)

  async function runReport() {
    setLoading(true)
    const [{ data: invLines }, { data: products }] = await Promise.all([
      fetchAllPages(() => supabase.from('invoice_lines')
        .select('qty, product_id, invoice:invoice_id(invoice_no, eway_bill_no, eway_bill_date, status, invoice_type, seller_entity_id, buyer_entity_id, seller:seller_entity_id(name,short_name), buyer:buyer_entity_id(name,short_name))')
        .not('invoice', 'is', null)),
      fetchAllPages(() => supabase.from('products').select('id,name')),
    ])
    const productById = Object.fromEntries((products || []).map(p => [p.id, p]))
    const result = (invLines || [])
      .filter(l => l.invoice && l.invoice.status !== 'cancelled' && l.invoice.status !== 'draft' && l.invoice.eway_bill_no && l.invoice.invoice_type !== 'purchase')
      .map(l => ({
        eway_bill_no: l.invoice.eway_bill_no, eway_bill_date: l.invoice.eway_bill_date, invoice_no: l.invoice.invoice_no,
        product: productById[l.product_id]?.name || (l.product_id ? '—' : '⚠ No product'),
        qty: l.qty, from: l.invoice.seller?.short_name || l.invoice.seller?.name, to: l.invoice.buyer?.short_name || l.invoice.buyer?.name,
      }))
      .sort((a, b) => new Date(b.eway_bill_date || 0) - new Date(a.eway_bill_date || 0))
    setRows(result)
    setLoading(false)
  }

  const th = { padding: '9px 12px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <button onClick={runReport} disabled={loading}
        style={{ alignSelf: 'flex-start', padding: '8px 18px', background: C.accent, color: '#f5f0e8', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit' }}>
        {loading ? 'Running…' : 'Run Report'}
      </button>
      {rows && (
        <Card>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead><tr>
                <th style={{ ...th, textAlign: 'left' }}>EWB Date</th>
                <th style={{ ...th, textAlign: 'left' }}>EWB No</th>
                <th style={{ ...th, textAlign: 'left' }}>Invoice No</th>
                <th style={{ ...th, textAlign: 'left' }}>Product</th>
                <th style={{ ...th, textAlign: 'right' }}>Qty Moved</th>
                <th style={{ ...th, textAlign: 'left' }}>From</th>
                <th style={{ ...th, textAlign: 'left' }}>To</th>
              </tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? C.surface : '#faf6ed' }}>
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8' }}>{r.eway_bill_date ? fmtDate(r.eway_bill_date) : '—'}</td>
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', fontFamily: 'monospace' }}>{r.eway_bill_no}</td>
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', fontFamily: 'monospace' }}>{r.invoice_no || '—'}</td>
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8' }}>{r.product}</td>
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right', fontWeight: 600 }}>{Number(r.qty).toLocaleString('en-IN')}</td>
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8' }}>{r.from}</td>
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8' }}>{r.to}</td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={7} style={{ padding: '24px', textAlign: 'center', color: C.textMuted }}>No E-way-Bill-backed movements found.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

// ─── Missing Product Mapping ────────────────────────────────────────────────────
// Any qty>0 line with no product_id is invisible to every stock calculation —
// this is the same rule findLinesMissingProductId() blocks on save, surfaced
// here for lines that slipped through before that validation existed.
function MissingProductReport() {
  const [rows, setRows]       = useState(null)
  const [loading, setLoading] = useState(false)

  async function runReport() {
    setLoading(true)
    const [{ data: piLines }, { data: poLines }, { data: invLines }] = await Promise.all([
      supabase.from('proforma_invoice_lines').select('qty, product_id, pi:pi_id(pi_no, pi_date, from_entity:from_entity_id(name,short_name))').is('product_id', null),
      supabase.from('purchase_order_lines').select('qty, product_id, po:po_id(po_no, po_date, buyer:buyer_entity_id(name,short_name))').is('product_id', null),
      supabase.from('invoice_lines').select('qty, product_id, invoice:invoice_id(invoice_no, invoice_date, seller:seller_entity_id(name,short_name))').is('product_id', null),
    ])
    const result = [
      ...(piLines || []).filter(l => l.pi && Number(l.qty) > 0).map(l => ({ source: 'PI', doc: l.pi.pi_no, date: l.pi.pi_date, entity: l.pi.from_entity?.short_name || l.pi.from_entity?.name, qty: l.qty })),
      ...(poLines || []).filter(l => l.po && Number(l.qty) > 0).map(l => ({ source: 'PO', doc: l.po.po_no, date: l.po.po_date, entity: l.po.buyer?.short_name || l.po.buyer?.name, qty: l.qty })),
      ...(invLines || []).filter(l => l.invoice && Number(l.qty) > 0).map(l => ({ source: 'Invoice', doc: l.invoice.invoice_no, date: l.invoice.invoice_date, entity: l.invoice.seller?.short_name || l.invoice.seller?.name, qty: l.qty })),
    ].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    setRows(result)
    setLoading(false)
  }

  const th = { padding: '9px 12px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <button onClick={runReport} disabled={loading}
        style={{ alignSelf: 'flex-start', padding: '8px 18px', background: C.accent, color: '#f5f0e8', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit' }}>
        {loading ? 'Running…' : 'Run Report'}
      </button>
      {rows && (
        <>
          {rows.length > 0 && (
            <div style={{ background: '#fff3cc', border: '1px solid #e6c040', borderRadius: '6px', padding: '10px 14px', fontSize: '13px', color: '#7a5000' }}>
              ⚠ {rows.length} line(s) with quantity but no product link — invisible to stock tracking until fixed.
            </div>
          )}
          <Card>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead><tr>
                  <th style={{ ...th, textAlign: 'left' }}>Source</th>
                  <th style={{ ...th, textAlign: 'left' }}>Document</th>
                  <th style={{ ...th, textAlign: 'left' }}>Date</th>
                  <th style={{ ...th, textAlign: 'left' }}>Entity</th>
                  <th style={{ ...th, textAlign: 'right' }}>Qty</th>
                </tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? C.surface : '#faf6ed' }}>
                      <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8' }}><Badge status={r.source === 'Invoice' ? 'submitted' : 'pending'} label={r.source} /></td>
                      <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', fontFamily: 'monospace' }}>{r.doc || '—'}</td>
                      <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8' }}>{r.date ? fmtDate(r.date) : '—'}</td>
                      <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8' }}>{r.entity || '—'}</td>
                      <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right', fontWeight: 600 }}>{Number(r.qty).toLocaleString('en-IN')}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={5} style={{ padding: '24px', textAlign: 'center', color: C.success }}>✓ No lines with missing product mapping.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}

// ─── Ageing Receivables / Payables ─────────────────────────────────────────────
const AGE_BUCKETS = [
  { label: 'Current (not yet due)', test: d => d < 0 },
  { label: '1-30 days',  test: d => d >= 0  && d <= 30 },
  { label: '31-60 days', test: d => d >= 31 && d <= 60 },
  { label: '61-90 days', test: d => d >= 61 && d <= 90 },
  { label: '90+ days',   test: d => d > 90 },
]

function AgeingReport({ entities, defaultEntityId }) {
  const [entityId, setEntityId] = useState('')
  useEffect(() => { if (defaultEntityId && !entityId) setEntityId(defaultEntityId) }, [defaultEntityId]) // eslint-disable-line react-hooks/exhaustive-deps
  const [rows, setRows]       = useState(null)
  const [loading, setLoading] = useState(false)

  async function runReport() {
    if (!entityId) return
    setLoading(true)
    const [{ data: receivables }, { data: payables }] = await Promise.all([
      supabase.from('invoices').select('id,invoice_no,invoice_date,due_date,total_amount,buyer:buyer_entity_id(name,short_name)').eq('seller_entity_id', entityId).eq('is_deleted', false).neq('status', 'cancelled'),
      supabase.from('invoices').select('id,invoice_no,invoice_date,due_date,total_amount,seller:seller_entity_id(name,short_name)').eq('buyer_entity_id', entityId).eq('is_deleted', false).neq('status', 'cancelled'),
    ])
    const invIds = [...(receivables || []), ...(payables || [])].map(i => i.id)
    let tranchesByInvoice = new Map()
    if (invIds.length) {
      const { data: tranches } = await supabase.from('invoice_payments').select('invoice_id, amount, tds_amount, adjustments').eq('is_deleted', false).in('invoice_id', invIds)
      tranchesByInvoice = groupTranchesByInvoice(tranches)
    }
    const todayStr = today()
    function toRows(list, partyKey) {
      return (list || []).map(inv => {
        const { pending } = computeInvoiceOutstanding(inv, tranchesByInvoice.get(inv.id))
        const dueDate = inv.due_date || inv.invoice_date
        const daysOverdue = Math.floor((new Date(todayStr) - new Date(dueDate)) / 86400000)
        return { invoice_no: inv.invoice_no, date: inv.invoice_date, due_date: inv.due_date, party: inv[partyKey]?.short_name || inv[partyKey]?.name, pending, daysOverdue }
      }).filter(r => r.pending > 0)
    }
    setRows({ receivables: toRows(receivables, 'buyer'), payables: toRows(payables, 'seller') })
    setLoading(false)
  }

  const th = { padding: '9px 12px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em' }

  function AgeingTable({ title, list }) {
    const bucketed = AGE_BUCKETS.map(b => ({ ...b, rows: list.filter(r => b.test(r.daysOverdue)), total: 0 }))
    bucketed.forEach(b => { b.total = b.rows.reduce((s, r) => s + r.pending, 0) })
    const grandTotal = list.reduce((s, r) => s + r.pending, 0)
    return (
      <Card>
        <div style={{ padding: '12px 16px', fontWeight: 700, fontSize: '14px', borderBottom: `1px solid ${C.border}` }}>{title} — {formatINR(grandTotal)} total</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 0 }}>
          {bucketed.map(b => (
            <div key={b.label} style={{ padding: '10px 14px', borderRight: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
              <div style={{ fontSize: '10px', color: C.textMuted, textTransform: 'uppercase', fontWeight: 700 }}>{b.label}</div>
              <div style={{ fontWeight: 700, fontSize: '14px', marginTop: '2px', color: b.total > 0 ? C.text : C.textMuted }}>{formatINR(b.total)}</div>
              <div style={{ fontSize: '11px', color: C.textMuted }}>{b.rows.length} invoice(s)</div>
            </div>
          ))}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead><tr>
              <th style={{ ...th, textAlign: 'left' }}>Invoice No</th>
              <th style={{ ...th, textAlign: 'left' }}>Party</th>
              <th style={{ ...th, textAlign: 'left' }}>Due Date</th>
              <th style={{ ...th, textAlign: 'right' }}>Days Overdue</th>
              <th style={{ ...th, textAlign: 'right' }}>Outstanding</th>
            </tr></thead>
            <tbody>
              {list.sort((a,b)=>b.daysOverdue-a.daysOverdue).map((r, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? C.surface : '#faf6ed' }}>
                  <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', fontFamily: 'monospace' }}>{r.invoice_no || '—'}</td>
                  <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8' }}>{r.party || '—'}</td>
                  <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8' }}>{r.due_date ? fmtDate(r.due_date) : '—'}</td>
                  <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right', color: r.daysOverdue > 0 ? C.danger : C.textMuted, fontWeight: r.daysOverdue > 0 ? 700 : 400 }}>{r.daysOverdue > 0 ? r.daysOverdue : '—'}</td>
                  <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right', fontWeight: 600 }}>{formatINR(r.pending)}</td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={5} style={{ padding: '20px', textAlign: 'center', color: C.textMuted }}>Nothing outstanding.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    )
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
        <button onClick={runReport} disabled={!entityId || loading}
          style={{ padding: '8px 18px', background: C.accent, color: '#f5f0e8', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: !entityId ? 'not-allowed' : 'pointer', opacity: !entityId ? 0.5 : 1, fontFamily: 'inherit' }}>
          {loading ? 'Running…' : 'Run Report'}
        </button>
      </div>
      {rows && (
        <>
          <AgeingTable title='Receivables (owed to this entity)' list={rows.receivables} />
          <AgeingTable title='Payables (owed by this entity)' list={rows.payables} />
        </>
      )}
    </div>
  )
}

// ─── Reports Shell ────────────────────────────────────────────────────────────
export default function Reports() {
  const [tab, setTab]           = useState('P&L')
  // CHANGED: master sees every entity same as before; everyone else only
  // sees entities they've been granted — no point offering an entity picker
  // full of entities whose reports RLS would return empty for anyway.
  const { entities, defaultEntityId } = useEntityAccess()
  const [fys, setFys]           = useState([])

  useEffect(() => {
    supabase.from('financial_years').select('*').order('start_date', { ascending: false }).then(({ data }) => setFys(data || []))
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

      {tab === 'P&L'         && <PLReport entities={entities} fys={fys} defaultEntityId={defaultEntityId} />}
      {tab === 'GST Summary' && <GSTSummary entities={entities} fys={fys} defaultEntityId={defaultEntityId} />}
      {tab === 'Ledger'      && <Ledger entities={entities} fys={fys} defaultEntityId={defaultEntityId} />}
      {tab === 'Profitability' && <ProfitabilityReport entities={entities} fys={fys} />}
      {tab === 'Actual Stock'    && <ActualStockReport entities={entities} defaultEntityId={defaultEntityId} />}
      {tab === 'Stock Movements' && <StockMovementReport entities={entities} />}
      {tab === 'Missing Products' && <MissingProductReport />}
      {tab === 'Ageing'      && <AgeingReport entities={entities} defaultEntityId={defaultEntityId} />}
    </div>
  )
}
