import { useState, useEffect } from 'react'
import { supabase } from '../../supabaseClient'
import { fetchAllPages, excludeAutoPurchaseMirrors } from '../../utils/query'
import { C, Card, FormRow, Select, StatCard, Badge, Btn, MultiSelectDropdown } from '../../components/UI/index'
import { formatINR, formatQty, toNum, round2 } from '../../utils/money'
import { fmtDate, today } from '../../utils/dates'
import { useEntityAccess } from '../../hooks/useEntityAccess'
import { fetchActualStockPosition } from '../../utils/stock'
import { computeInvoiceOutstanding, groupTranchesByInvoice } from '../../utils/payments'
import { matchPurchasesToSales, calcMarginPct } from '../../utils/margin'
import { downloadCSV } from '../../utils/csvTemplate'
import OrderTrail from './OrderTrail' // CHANGED: order → leg → invoice → challan → expense drill-down
import TallyLedgerTable, { LedgerExportButtons } from './TallyLedger' // CHANGED: Tally-style ledger statements
import { ledgerTotals } from '../../utils/ledgerExport'

// CHANGED: "Compliance" is one tab in the main row, sitting next to Party
// Ledger. Selecting it reveals a second-level sub-tab row for its two
// reports (GST Summary, TDS/TCS Report) rather than splitting the main row
// into groups.
const TABS = ['P&L', 'Party Ledger', 'Compliance', 'Ledger', 'Profitability', 'Margin Report', 'Actual Stock', 'Stock Movements', 'Missing Products', 'Ageing', 'Order Trail'] // CHANGED: Order Trail — order → leg → invoice → challan → expense drill-down
const COMPLIANCE_TABS = ['GST Summary', 'TDS/TCS Report']

// 'YYYY-MM' → 'Jul 2026' for the month-wise GST table
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function monthLabel(ym) {
  const [y, m] = (ym || '').split('-')
  return m ? `${MONTH_NAMES[Number(m) - 1]} ${y}` : (ym || '—')
}

// ─── Custom date range (overrides FY when set) ─────────────────────────────
// A custom From/To range always wins over the Financial Year dropdown when
// either bound is set; otherwise falls back to the FY's own start/end;
// otherwise no bound at all ("all time"). Shared by every report tab below
// instead of each one hand-rolling its own FY-range logic.
function resolveDateRange(fyFilter, dateFrom, dateTo) {
  if (dateFrom || dateTo) return { start: dateFrom || null, end: dateTo || null }
  return fyFilter ? { start: fyFilter.start_date, end: fyFilter.end_date } : null
}
// CHANGED: the period line printed on a ledger statement, e.g. "1 Apr 2026 to 31 Mar 2027".
function periodLabel(range) {
  if (!range || (!range.start && !range.end)) return 'All dates'
  if (range.start && range.end) return `${fmtDate(range.start)} to ${fmtDate(range.end)}`
  return range.start ? `From ${fmtDate(range.start)}` : `Up to ${fmtDate(range.end)}`
}
// Applies a resolved range to a Supabase query builder on one date column.
function applyDateRange(query, range, col) {
  if (!range) return query
  if (range.start) query = query.gte(col, range.start)
  if (range.end)   query = query.lte(col, range.end)
  return query
}
// Client-side membership test — for tabs that merge multiple sources before
// filtering, where a server-side .gte/.lte per source isn't practical.
function inDateRange(d, range) {
  if (!range) return true
  if (!d) return true
  if (range.start && d < range.start) return false
  if (range.end && d > range.end) return false
  return true
}
// Shared From/To date filter inputs — same pair of controls in every tab's
// filter bar, styled like the date inputs already used elsewhere (e.g.
// src/pages/PI/index.jsx).
function DateRangeFields({ dateFrom, setDateFrom, dateTo, setDateTo, toHint }) {
  const dateInputStyle = { padding: '8px 10px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', fontFamily: 'inherit' }
  return (
    <>
      <FormRow label='From Date'>
        <input type='date' value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={dateInputStyle} />
      </FormRow>
      <FormRow label='To Date' hint={toHint}>
        <input type='date' value={dateTo} onChange={e => setDateTo(e.target.value)} style={dateInputStyle} />
      </FormRow>
    </>
  )
}

// CHANGED: hoisted out of PLReport's render body — it only ever depended on
// its own props plus the module-level formatINR import, never on PLReport's
// own state, so nothing is lost by declaring it once at module scope instead
// of recreating the component function on every PLReport render.
function TaxRow({ label, taxable, cgst, sgst, igst }) {
  return (
    <tr>
      <td style={{ padding: '10px 14px', fontWeight: 600 }}>{label}</td>
      <td style={{ padding: '10px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatINR(taxable)}</td>
      <td style={{ padding: '10px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatINR(cgst)}</td>
      <td style={{ padding: '10px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatINR(sgst)}</td>
      <td style={{ padding: '10px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatINR(igst)}</td>
      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatINR(cgst + sgst + igst)}</td>
    </tr>
  )
}

// ─── P&L Report ───────────────────────────────────────────────────────────────
function PLReport({ entities, fys, defaultEntityId }) {
  const [entityId, setEntityId] = useState('')
  useEffect(() => { if (defaultEntityId && !entityId) setEntityId(defaultEntityId) }, [defaultEntityId]) // eslint-disable-line react-hooks/exhaustive-deps
  const [fyId, setFyId]         = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [data, setData]         = useState(null)
  const [loading, setLoading]   = useState(false)

  async function runReport() {
    if (!entityId) return
    setLoading(true)

    // For selected entity, get:
    // Sales: invoices where seller_entity_id = entityId
    // Purchases: invoices where buyer_entity_id = entityId
    // Expenses: expenses where entity_id = entityId
    const range = resolveDateRange(fys.find(f => f.id === fyId), dateFrom, dateTo)

    // CHANGED: excludeAutoPurchaseMirrors — without it, every internal-to-
    // internal purchase this entity made shows up twice (its seller's real
    // sales invoice AND the auto-mirrored 'purchase' copy of the same
    // transaction), inflating this entity's own P&L purchases figure.
    let salesQ = excludeAutoPurchaseMirrors(supabase.from('invoices')
      .select('id,total_amount,taxable_amount,cgst_amount,sgst_amount,igst_amount,invoice_date')
      .eq('seller_entity_id', entityId).eq('is_deleted', false)
      .neq('status', 'cancelled'))

    let purchasesQ = excludeAutoPurchaseMirrors(supabase.from('invoices')
      .select('id,total_amount,taxable_amount,cgst_amount,sgst_amount,igst_amount,invoice_date')
      .eq('buyer_entity_id', entityId).eq('is_deleted', false)
      .neq('status', 'cancelled'))

    let expensesQ = supabase.from('expenses')
      .select('id,total_amount,amount,gst_amount,expense_type,expense_date')
      .eq('entity_id', entityId).eq('is_deleted', false)

    salesQ     = applyDateRange(salesQ, range, 'invoice_date')
    purchasesQ = applyDateRange(purchasesQ, range, 'invoice_date')
    expensesQ  = applyDateRange(expensesQ, range, 'expense_date')

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

  function handleExportCSV() {
    if (!data) return
    const rows = [
      { metric: 'Sales (Taxable)', value: data.totalSales },
      { metric: 'Purchases (Taxable)', value: data.totalPurchases },
      { metric: 'Gross Profit', value: data.grossProfit },
      { metric: 'Expenses', value: data.totalExpenses },
      { metric: 'Net Profit', value: data.netProfit },
      ...Object.entries(data.expenseByType).map(([type, amount]) => ({ metric: `Expense: ${type}`, value: amount })),
    ]
    downloadCSV(`pl_report_${today()}.csv`, ['metric', 'value'], rows)
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
        <DateRangeFields dateFrom={dateFrom} setDateFrom={setDateFrom} dateTo={dateTo} setDateTo={setDateTo} />
        <button data-ctrl-enter='' title='Ctrl+Enter' onClick={runReport} disabled={!entityId || loading}
          style={{ padding: '8px 18px', background: C.accent, color: '#f5f0e8', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: !entityId ? 'not-allowed' : 'pointer', opacity: !entityId ? 0.5 : 1, fontFamily: 'inherit' }}>
          {loading ? 'Running…' : 'Run Report'}
        </button>
        <Btn variant='ghost' onClick={handleExportCSV} disabled={!data}>↓ Export CSV</Btn>
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
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [data, setData]         = useState(null)
  const [loading, setLoading]   = useState(false)

  async function runReport() {
    if (!entityId) return
    setLoading(true)
    const range = resolveDateRange(fys.find(f => f.id === fyId), dateFrom, dateTo)

    // CHANGED: excludeAutoPurchaseMirrors — see utils/query.js. Without it, an
    // entity that buys from an internal upstream entity has that purchase
    // counted twice (its real value plus the auto-mirrored duplicate),
    // inflating Input Tax Credit here relative to real Output Tax — which
    // can flip "net payable" into a false-negative even for an entity that
    // genuinely sells at a markup, if its own sales happen to go to an
    // external customer (no mirror created, output stays single-counted)
    // while its purchases come from an internal entity (mirror doubles it).
    let salesQ = excludeAutoPurchaseMirrors(supabase.from('invoices')
      .select('id,total_amount,taxable_amount,cgst_amount,sgst_amount,igst_amount,is_interstate,invoice_date,buyer:buyer_entity_id(gstin,name)')
      .eq('seller_entity_id', entityId).eq('is_deleted', false).neq('status', 'cancelled'))

    let purchasesQ = excludeAutoPurchaseMirrors(supabase.from('invoices')
      .select('id,total_amount,taxable_amount,cgst_amount,sgst_amount,igst_amount,is_interstate,invoice_date,seller:seller_entity_id(gstin,name)')
      .eq('buyer_entity_id', entityId).eq('is_deleted', false).neq('status', 'cancelled'))

    // CHANGED: GST-bearing expenses give input tax credit too — pulled in so the
    // month-wise net payable reflects real cash outflow, not sales−purchases only.
    // is_rcm=false excludes RCM expenses (self-assessed GST, tracked as a
    // liability below, not ordinary ITC) — belt-and-braces alongside
    // gt('gst_amount',0), since RCM expenses now save gst_amount=0 anyway.
    let expensesQ = supabase.from('expenses')
      .select('gst_amount,expense_date')
      .eq('entity_id', entityId).eq('is_deleted', false).eq('is_rcm', false).gt('gst_amount', 0)

    // CHANGED: RCM (Reverse Charge) — self-assessed GST on expenses like GTA
    // freight where the vendor charges no GST. This is an output-tax
    // liability owed to the government, paid in cash, and only later
    // claimed back as ITC — reported separately, never folded into
    // expenseITC above.
    let rcmQ = supabase.from('expenses')
      .select('rcm_gst_amount,expense_date,rcm_paid_date,rcm_itc_claimed_date')
      .eq('entity_id', entityId).eq('is_deleted', false).eq('is_rcm', true).gt('rcm_gst_amount', 0)

    salesQ     = applyDateRange(salesQ, range, 'invoice_date')
    purchasesQ = applyDateRange(purchasesQ, range, 'invoice_date')
    expensesQ  = applyDateRange(expensesQ, range, 'expense_date')
    rcmQ       = applyDateRange(rcmQ, range, 'expense_date')

    const [{ data: sales }, { data: purchases }, { data: expenses }, { data: rcmRows }] = await Promise.all([salesQ, purchasesQ, expensesQ, rcmQ])

    // CHANGED: month-wise breakdown for GST cash-flow planning. Output tax on
    // sales less ITC from BOTH purchase invoices and GST-bearing expenses, per
    // calendar month, with net GST payable (never negative — surplus ITC just
    // carries forward).
    const monthly = {}
    const mKey = d => (d || '').slice(0, 7)  // YYYY-MM
    const ensureM = k => (monthly[k] || (monthly[k] = { output: 0, purchaseITC: 0, expenseITC: 0, rcmLiability: 0 }))
    ;(sales || []).forEach(i => { ensureM(mKey(i.invoice_date)).output      += (i.cgst_amount + i.sgst_amount + i.igst_amount) })
    ;(purchases || []).forEach(i => { ensureM(mKey(i.invoice_date)).purchaseITC += (i.cgst_amount + i.sgst_amount + i.igst_amount) })
    ;(expenses || []).forEach(e => { ensureM(mKey(e.expense_date)).expenseITC  += (e.gst_amount || 0) })
    // CHANGED: RCM liability shown per month for cash-flow planning, but never
    // subtracted in `net` below — RCM must be paid in cash, it can't be offset
    // against ITC, so it doesn't reduce what's payable on regular sales/purchases.
    ;(rcmRows || []).forEach(r => { ensureM(mKey(r.expense_date)).rcmLiability += (r.rcm_gst_amount || 0) })
    const monthlyRows = Object.keys(monthly).sort().map(k => {
      const m = monthly[k]
      return { month: k, output: m.output, purchaseITC: m.purchaseITC, expenseITC: m.expenseITC, rcmLiability: m.rcmLiability, net: Math.max(0, m.output - m.purchaseITC - m.expenseITC) }
    })
    const expenseITC = (expenses || []).reduce((s, e) => s + (e.gst_amount || 0), 0)
    const rcmLiability = (rcmRows || []).reduce((s, r) => s + (r.rcm_gst_amount || 0), 0)
    const rcmPaid       = (rcmRows || []).filter(r => r.rcm_paid_date).reduce((s, r) => s + (r.rcm_gst_amount || 0), 0)
    const rcmClaimed    = (rcmRows || []).filter(r => r.rcm_itc_claimed_date).reduce((s, r) => s + (r.rcm_gst_amount || 0), 0)

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
      expenseITC, monthlyRows, // CHANGED: expense ITC + month-wise planning table
      rcmLiability, rcmPaid, rcmClaimed, // CHANGED: RCM — reported separately, never netted into ITC
      // TDS/TCS moved to its own report (Compliance → TDS/TCS Report), which
      // aggregates invoice_payments + credit_debit_notes + expenses — this
      // card used to read only the now-legacy tds_tcs_entries table.
    })
    setLoading(false)
  }

  function handleExportCSV() {
    if (!data) return
    downloadCSV(`gst_summary_${today()}.csv`, ['month', 'output', 'purchaseITC', 'expenseITC', 'rcmLiability', 'net'],
      data.monthlyRows.map(r => ({ ...r, month: monthLabel(r.month) })))
  }

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
        <DateRangeFields dateFrom={dateFrom} setDateFrom={setDateFrom} dateTo={dateTo} setDateTo={setDateTo} />
        <button data-ctrl-enter='' title='Ctrl+Enter' onClick={runReport} disabled={!entityId || loading}
          style={{ padding: '8px 18px', background: C.accent, color: '#f5f0e8', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: !entityId ? 'not-allowed' : 'pointer', opacity: !entityId ? 0.5 : 1, fontFamily: 'inherit' }}>
          {loading ? 'Running…' : 'Run Report'}
        </button>
        <Btn variant='ghost' onClick={handleExportCSV} disabled={!data}>↓ Export CSV</Btn>
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

      {data && data.expenseITC > 0 && (
        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '10px 14px', fontSize: '13px', display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: C.textSoft }}>Input Tax Credit from expenses (period)</span>
          <span style={{ fontWeight: 700, color: C.success }}>{formatINR(data.expenseITC)}</span>
        </div>
      )}

      {data && data.rcmLiability > 0 && (
        <Card>
          <div style={{ padding: '12px 16px', fontWeight: 700, fontSize: '14px', borderBottom: `1px solid ${C.border}` }}>
            RCM (Reverse Charge) — self-assessed, paid in cash, claimed as ITC separately
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px,1fr))', gap: '12px', padding: '14px 16px' }}>
            <StatCard label='RCM Liability (period)' value={formatINR(data.rcmLiability)} color={C.danger} />
            <StatCard label='Paid to Govt' value={formatINR(data.rcmPaid)} color={C.success} />
            <StatCard label='ITC Claimed' value={formatINR(data.rcmClaimed)} color={C.success} />
            <StatCard label='Pending to Claim' value={formatINR(data.rcmPaid - data.rcmClaimed)} color={C.warning} />
          </div>
        </Card>
      )}

      {data && (
        <Card>
          <div style={{ padding: '12px 16px', fontWeight: 700, fontSize: '14px', borderBottom: `1px solid ${C.border}` }}>Month-wise GST (cash-flow planning)</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead><tr>
                <th style={{ ...thStyle, textAlign: 'left' }}>Month</th>
                <th style={thStyle}>Output Tax</th>
                <th style={thStyle}>Purchase ITC</th>
                <th style={thStyle}>Expense ITC</th>
                <th style={thStyle}>RCM Liability</th>
                <th style={thStyle}>Net Payable</th>
              </tr></thead>
              <tbody>
                {data.monthlyRows.length === 0
                  ? <tr><td colSpan={6} style={{ padding: '18px', textAlign: 'center', color: C.textMuted }}>No taxable activity in this period.</td></tr>
                  : data.monthlyRows.map(m => (
                    <tr key={m.month}>
                      <td style={{ padding: '10px 14px', fontWeight: 600 }}>{monthLabel(m.month)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatINR(m.output)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatINR(m.purchaseITC)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatINR(m.expenseITC)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatINR(m.rcmLiability)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: m.net > 0 ? C.danger : C.success, fontVariantNumeric: 'tabular-nums' }}>{formatINR(m.net)}</td>
                    </tr>
                  ))}
              </tbody>
              {data.monthlyRows.length > 0 && (
                <tfoot>
                  <tr style={{ background: '#f0ebe0' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 700 }}>Total</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatINR(data.monthlyRows.reduce((s, m) => s + m.output, 0))}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatINR(data.monthlyRows.reduce((s, m) => s + m.purchaseITC, 0))}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatINR(data.monthlyRows.reduce((s, m) => s + m.expenseITC, 0))}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatINR(data.monthlyRows.reduce((s, m) => s + m.rcmLiability, 0))}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: C.danger }}>{formatINR(data.monthlyRows.reduce((s, m) => s + m.net, 0))}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </Card>
      )}

    </div>
  )
}

// ─── TDS/TCS Report ─────────────────────────────────────────────────────────────
// Consolidates TDS/TCS across every source that carries it: invoice_payments
// (TDS/TCS recognized at payment time — the single source of truth for
// invoices, per the decision to stop recording it at invoice creation),
// credit_debit_notes (auto-derived from the linked invoice's payment rate),
// and party_payments (expense-side TDS/TCS — also recognized at payment
// time, not when the expense was booked; we're always the payer here).
//
// Direction convention used throughout:
//   TDS: the payer withholds and owes it to govt (liability); the payee had
//        it withheld from them and can claim it as credit.
//   TCS: the payee/seller collects it and owes it to govt (liability); the
//        payer had it collected from them and can claim it as credit.
function TdsTcsReport({ entities, fys, defaultEntityId }) {
  const [entityId, setEntityId] = useState('')
  useEffect(() => { if (defaultEntityId && !entityId) setEntityId(defaultEntityId) }, [defaultEntityId]) // eslint-disable-line react-hooks/exhaustive-deps
  const [fyId, setFyId]       = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(false)

  async function runReport() {
    if (!entityId) return
    setLoading(true)
    const range = resolveDateRange(fys.find(f => f.id === fyId), dateFrom, dateTo)
    const inRange = d => inDateRange(d, range)

    const [{ data: ips }, { data: cdns }, { data: exps }] = await Promise.all([ // exps = party_payments (expense-side TDS/TCS)
      supabase.from('invoice_payments')
        .select('id,invoice_no,actual_payment_date,entity_id,party_entity_id,tds_section,tds_amount,tcs_section,tcs_amount')
        .eq('is_deleted', false).or(`entity_id.eq.${entityId},party_entity_id.eq.${entityId}`),
      supabase.from('credit_debit_notes')
        .select('id,note_no,note_type,note_date,issuer_entity_id,receiver_entity_id,tds_amount,tcs_amount')
        .eq('is_deleted', false).or(`issuer_entity_id.eq.${entityId},receiver_entity_id.eq.${entityId}`),
      // CHANGED: expense-side TDS/TCS now lives on party_payments — recognized
      // at payment time, same as invoices, not when the expense was booked.
      supabase.from('party_payments')
        .select('id,payment_date,entity_id,tds_section,tds_amount,tcs_section,tcs_amount,expense:expense_id(expense_no,vendor_invoice_no)')
        .eq('entity_id', entityId).eq('is_deleted', false),
    ])

    let tdsDeducted = 0, tdsCredit = 0, tcsCollected = 0, tcsCredit = 0
    const rows = []

    for (const p of (ips || [])) {
      if (!inRange(p.actual_payment_date)) continue
      const weArePayer = p.entity_id === entityId
      if (toNum(p.tds_amount) > 0) {
        if (weArePayer) tdsDeducted += p.tds_amount; else tdsCredit += p.tds_amount
        rows.push({ source: 'Invoice Payment', doc: p.invoice_no, date: p.actual_payment_date, section: p.tds_section, kind: 'TDS', direction: weArePayer ? 'Liability' : 'Credit', amount: p.tds_amount })
      }
      if (toNum(p.tcs_amount) > 0) {
        if (weArePayer) tcsCredit += p.tcs_amount; else tcsCollected += p.tcs_amount
        rows.push({ source: 'Invoice Payment', doc: p.invoice_no, date: p.actual_payment_date, section: p.tcs_section, kind: 'TCS', direction: weArePayer ? 'Credit' : 'Liability', amount: p.tcs_amount })
      }
    }

    for (const n of (cdns || [])) {
      if (!inRange(n.note_date)) continue
      const sign = n.note_type === 'debit_note' ? 1 : -1
      const weAreIssuer = n.issuer_entity_id === entityId // issuer ≈ seller side, same as invoices
      if (toNum(n.tds_amount) > 0) {
        const amt = sign * n.tds_amount
        if (weAreIssuer) tdsCredit += amt; else tdsDeducted += amt
        rows.push({ source: `${n.note_type === 'debit_note' ? 'Debit' : 'Credit'} Note`, doc: n.note_no, date: n.note_date, section: '—', kind: 'TDS', direction: weAreIssuer ? 'Credit' : 'Liability', amount: amt })
      }
      if (toNum(n.tcs_amount) > 0) {
        const amt = sign * n.tcs_amount
        if (weAreIssuer) tcsCollected += amt; else tcsCredit += amt
        rows.push({ source: `${n.note_type === 'debit_note' ? 'Debit' : 'Credit'} Note`, doc: n.note_no, date: n.note_date, section: '—', kind: 'TCS', direction: weAreIssuer ? 'Liability' : 'Credit', amount: amt })
      }
    }

    for (const p of (exps || [])) {
      if (!inRange(p.payment_date)) continue
      const doc = p.expense?.vendor_invoice_no || p.expense?.expense_no || '—' // general/on-account payments have no linked expense
      if (toNum(p.tds_amount) > 0) {
        tdsDeducted += p.tds_amount
        rows.push({ source: 'Party Payment', doc, date: p.payment_date, section: p.tds_section, kind: 'TDS', direction: 'Liability', amount: p.tds_amount })
      }
      if (toNum(p.tcs_amount) > 0) {
        tcsCredit += p.tcs_amount
        rows.push({ source: 'Party Payment', doc, date: p.payment_date, section: p.tcs_section, kind: 'TCS', direction: 'Credit', amount: p.tcs_amount })
      }
    }

    rows.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    setData({ tdsDeducted, tdsCredit, tcsCollected, tcsCredit, rows })
    setLoading(false)
  }

  function handleExportCSV() {
    if (!data) return
    downloadCSV(`tds_tcs_report_${today()}.csv`, ['source', 'doc', 'date', 'section', 'kind', 'direction', 'amount'], data.rows)
  }

  const th = { padding: '9px 12px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em' }

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
        <DateRangeFields dateFrom={dateFrom} setDateFrom={setDateFrom} dateTo={dateTo} setDateTo={setDateTo} />
        <button data-ctrl-enter='' title='Ctrl+Enter' onClick={runReport} disabled={!entityId || loading}
          style={{ padding: '8px 18px', background: C.accent, color: '#f5f0e8', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: !entityId ? 'not-allowed' : 'pointer', opacity: !entityId ? 0.5 : 1, fontFamily: 'inherit' }}>
          {loading ? 'Running…' : 'Run Report'}
        </button>
        <Btn variant='ghost' onClick={handleExportCSV} disabled={!data}>↓ Export CSV</Btn>
      </div>

      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', gap: '12px' }}>
            <StatCard label='TDS Deducted (payable to govt)' value={formatINR(data.tdsDeducted)} color={data.tdsDeducted > 0 ? C.danger : C.textMuted} />
            <StatCard label='TDS Credit (deducted by others)' value={formatINR(data.tdsCredit)} color={data.tdsCredit > 0 ? C.success : C.textMuted} />
            <StatCard label='TCS Collected (payable to govt)' value={formatINR(data.tcsCollected)} color={data.tcsCollected > 0 ? C.danger : C.textMuted} />
            <StatCard label='TCS Credit (collected by others)' value={formatINR(data.tcsCredit)} color={data.tcsCredit > 0 ? C.success : C.textMuted} />
          </div>

          <Card>
            <div style={{ padding: '12px 16px', fontWeight: 700, fontSize: '14px', borderBottom: `1px solid ${C.border}` }}>Detail (all contributing entries)</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead><tr>
                  <th style={{ ...th, textAlign: 'left' }}>Date</th>
                  <th style={{ ...th, textAlign: 'left' }}>Source</th>
                  <th style={{ ...th, textAlign: 'left' }}>Document</th>
                  <th style={{ ...th, textAlign: 'left' }}>Section</th>
                  <th style={{ ...th, textAlign: 'left' }}>Type</th>
                  <th style={{ ...th, textAlign: 'left' }}>Direction</th>
                  <th style={{ ...th, textAlign: 'right' }}>Amount</th>
                </tr></thead>
                <tbody>
                  {data.rows.length === 0
                    ? <tr><td colSpan={7} style={{ padding: '24px', textAlign: 'center', color: C.textMuted }}>No TDS/TCS activity for this selection.</td></tr>
                    : data.rows.map((r, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? C.surface : '#faf6ed' }}>
                        <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8' }}>{fmtDate(r.date)}</td>
                        <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8' }}>{r.source}</td>
                        <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', fontFamily: 'monospace', fontSize: '12px' }}>{r.doc || '—'}</td>
                        <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8' }}>{r.section || '—'}</td>
                        <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8' }}>
                          <span style={{ fontSize: '11px', background: r.kind === 'TDS' ? '#f3ede8' : '#e8f0f3', color: r.kind === 'TDS' ? C.warning : '#1a4a6a', padding: '2px 7px', borderRadius: '4px', fontWeight: 600 }}>{r.kind}</span>
                        </td>
                        <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', color: r.direction === 'Liability' ? C.danger : C.success }}>{r.direction}</td>
                        <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatINR(r.amount)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
      {!loading && !data && (
        <div style={{ textAlign: 'center', padding: '48px', color: C.textMuted, fontSize: '13px' }}>Select an entity, then Run Report.</div>
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
  const [dateFrom, setDateFrom]     = useState('')
  const [dateTo, setDateTo]         = useState('')
  const [ledger, setLedger]         = useState(null) // CHANGED: Tally-style statement (see TallyLedger.jsx)
  const [exportError, setExportError] = useState('')
  const [loading, setLoading]       = useState(false)

  async function runReport() {
    if (!ourEntityId) return
    setLoading(true)
    const range = resolveDateRange(fys.find(f => f.id === fyId), dateFrom, dateTo)
    // CHANGED: fetched up to the period end only — entries before the period
    // start are needed for the Opening Balance.
    const upTo = range?.end ? { end: range.end } : null

    // Sales invoices (Dr for our entity)
    // CHANGED: excludeAutoPurchaseMirrors — see utils/query.js. A sale to an
    // internal buyer would otherwise post twice: once as our real sales
    // invoice, once as the buyer's auto-mirrored 'purchase' copy of it
    // (which ALSO has seller_entity_id = us).
    let salesQ = excludeAutoPurchaseMirrors(supabase.from('invoices')
      .select('id,invoice_no,invoice_date,total_amount,buyer_entity_id,buyer:buyer_entity_id(name,short_name)')
      .eq('seller_entity_id', ourEntityId).eq('is_deleted', false).neq('status', 'cancelled'))
    if (partyId !== 'all') salesQ = salesQ.eq('buyer_entity_id', partyId)
    salesQ = applyDateRange(salesQ, upTo, 'invoice_date')

    // Purchase invoices (Cr for our entity)
    let purchasesQ = excludeAutoPurchaseMirrors(supabase.from('invoices')
      .select('id,invoice_no,invoice_date,total_amount,seller_entity_id,seller:seller_entity_id(name,short_name)')
      .eq('buyer_entity_id', ourEntityId).eq('is_deleted', false).neq('status', 'cancelled'))
    if (partyId !== 'all') purchasesQ = purchasesQ.eq('seller_entity_id', partyId)
    purchasesQ = applyDateRange(purchasesQ, upTo, 'invoice_date')

    // Receipts (Cr for our entity)
    let receiptsQ = supabase.from('payments')
      .select('id,payment_no,payment_date,net_amount,party_entity_id,party:party_entity_id(name,short_name),party_name')
      .eq('entity_id', ourEntityId).eq('payment_type', 'receipt').eq('is_deleted', false)
    if (partyId !== 'all') receiptsQ = receiptsQ.eq('party_entity_id', partyId)
    receiptsQ = applyDateRange(receiptsQ, upTo, 'payment_date')

    // Payments sent (Dr for our entity)
    let paymentsQ = supabase.from('payments')
      .select('id,payment_no,payment_date,net_amount,party_entity_id,party:party_entity_id(name,short_name),party_name')
      .eq('entity_id', ourEntityId).eq('payment_type', 'payment').eq('is_deleted', false)
    if (partyId !== 'all') paymentsQ = paymentsQ.eq('party_entity_id', partyId)
    paymentsQ = applyDateRange(paymentsQ, upTo, 'payment_date')

    const [{ data: sales }, { data: purchases }, { data: receipts }, { data: paymentsMade }] = await Promise.all([salesQ, purchasesQ, receiptsQ, paymentsQ])

    // Bill Discounting — disbursements (Dr: money received from bank) and repayments (Cr: money sent back)
    let bdEventsQ = supabase.from('bill_discounting_events')
      .select('id,discounting_date,net_proceeds,bank_name,bank:bank_id(name,short_name)')
      .eq('entity_id', ourEntityId).eq('is_deleted', false)
    bdEventsQ = applyDateRange(bdEventsQ, upTo, 'discounting_date')

    let bdRepaysQ = supabase.from('bill_discounting_repayments')
      .select('id,repayment_date,amount,interest_amount,total_payment,event_id, event:event_id(entity_id,bank_name,bank:bank_id(name,short_name))')
      .order('repayment_date')
    bdRepaysQ = applyDateRange(bdRepaysQ, upTo, 'repayment_date')

    // Standalone (non-invoice) entries recorded in Payments → Entity Ledger —
    // matches whichever side of `entity_payments` names our entity, so an
    // entry recorded under the OTHER party's book still shows up here (with
    // its direction flipped relative to us), same logic as buildEntityLedger
    // in utils/payments.js.
    let entPayQ = supabase.from('entity_payments')
      .select('id,actual_payment_date,entity_id,party_entity_id,party_name,direction,amount,reference_no,notes')
      .eq('is_deleted', false).or(`entity_id.eq.${ourEntityId},party_entity_id.eq.${ourEntityId}`)
    entPayQ = applyDateRange(entPayQ, upTo, 'actual_payment_date')

    const [{ data: bdEvents }, { data: bdRepays }, { data: entPayments }] = await Promise.all([bdEventsQ, bdRepaysQ, entPayQ])

    // Filter repayments to this entity
    const myRepays = (bdRepays || []).filter(r => r.event?.entity_id === ourEntityId)

    const entityById = Object.fromEntries(entities.map(e => [e.id, e]))
    // Dr when OUR entity paid out (a receivable-like advance, same
    // convention as "Payment Out" above), Cr when our entity received (same
    // convention as "Receipt" above) — flipped when the entry was recorded
    // under the OTHER entity's book instead of ours.
    const entPayRows = (entPayments || [])
      .filter(p => partyId === 'all' || p.entity_id === partyId || p.party_entity_id === partyId)
      .map(p => {
        const weAreBookOwner = p.entity_id === ourEntityId
        const dr = weAreBookOwner ? p.direction === 'paid' : p.direction === 'received'
        const partyEntity = weAreBookOwner ? p.party_entity_id : p.entity_id
        const party = entityById[partyEntity]?.short_name || entityById[partyEntity]?.name || (weAreBookOwner ? p.party_name : null)
        return { date: p.actual_payment_date, doc: p.reference_no || '—', party, type: 'Standalone Payment', dr: dr ? p.amount : 0, cr: dr ? 0 : p.amount, _raw: p }
      })

    const ledgerRows = [
      ...(sales || []).map(i => ({ date: i.invoice_date, doc: i.invoice_no, party: i.buyer?.short_name || i.buyer?.name, type: 'Sales Invoice', dr: i.total_amount, cr: 0 })),
      ...(paymentsMade || []).map(p => ({ date: p.payment_date, doc: p.payment_no, party: p.party?.short_name || p.party?.name || p.party_name, type: 'Payment Out', dr: p.net_amount, cr: 0 })),
      ...(purchases || []).map(i => ({ date: i.invoice_date, doc: i.invoice_no, party: i.seller?.short_name || i.seller?.name, type: 'Purchase Invoice', dr: 0, cr: i.total_amount })),
      ...(receipts || []).map(p => ({ date: p.payment_date, doc: p.payment_no, party: p.party?.short_name || p.party?.name || p.party_name, type: 'Receipt', dr: 0, cr: p.net_amount })),
      // Bill Discounting — disbursement is Dr (cash in), repayment is Cr (cash out)
      ...(bdEvents || []).map(e => ({ date: e.discounting_date, doc: '', party: e.bank?.name || e.bank_name, type: 'BD Disbursement', dr: e.net_proceeds || 0, cr: 0 })),
      ...myRepays.map(r => ({ date: r.repayment_date, doc: '', party: r.event?.bank?.name || r.event?.bank_name, type: 'BD Repayment', dr: 0, cr: (r.total_payment || r.amount) || 0 })),
      ...entPayRows,
    ].sort((a, b) => new Date(a.date) - new Date(b.date))

    // CHANGED: Tally-style statement. Everything dated before the period start
    // rolls into the Opening Balance; the rest are the vouchers of the period.
    // Which side each entry posts to (Dr/Cr) is unchanged from before.
    const VCH = { 'Sales Invoice': 'Sales', 'Purchase Invoice': 'Purchase', 'Receipt': 'Receipt', 'Payment Out': 'Payment', 'BD Disbursement': 'Bill Discounting', 'BD Repayment': 'BD Repayment' }
    const start = range?.start || null
    let opening = 0
    const period = []
    for (const r of ledgerRows) {
      const dr = Number(r.dr) || 0, cr = Number(r.cr) || 0
      if (start && (r.date || '') < start) { opening += dr - cr; continue }
      period.push({ date: r.date, particulars: r.party || '—', vchType: VCH[r.type] || (dr > 0 ? 'Payment' : 'Receipt'), vchNo: r.doc && r.doc !== '—' ? r.doc : '', dr, cr })
    }
    const our = entities.find(e => e.id === ourEntityId)
    const party = entities.find(e => e.id === partyId)
    setLedger({
      title: our?.name || our?.short_name || 'Ledger',
      account: partyId === 'all' ? 'All parties' : (party?.name || party?.short_name || 'Party'),
      period: periodLabel(range),
      opening, rows: period,
    })
    setLoading(false)
  }

  function handleExportCSV() {
    if (!ledger) return
    const t = ledgerTotals(ledger)
    downloadCSV(`ledger_${today()}.csv`, ['date', 'particulars', 'vch_type', 'vch_no', 'debit', 'credit'], [
      { date: '', particulars: 'Opening Balance', vch_type: '', vch_no: '', debit: t.opening > 0 ? t.opening : '', credit: t.opening < 0 ? -t.opening : '' },
      ...ledger.rows.map(r => ({ date: r.date, particulars: r.particulars, vch_type: r.vchType, vch_no: r.vchNo, debit: r.dr || '', credit: r.cr || '' })),
      { date: '', particulars: 'Current Total', vch_type: '', vch_no: '', debit: t.totalDr, credit: t.totalCr },
      { date: '', particulars: `Closing Balance (${t.closing >= 0 ? 'Dr' : 'Cr'})`, vch_type: '', vch_no: '', debit: t.closing >= 0 ? t.closing : '', credit: t.closing < 0 ? -t.closing : '' },
    ])
  }

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
        <DateRangeFields dateFrom={dateFrom} setDateFrom={setDateFrom} dateTo={dateTo} setDateTo={setDateTo} />
        <button data-ctrl-enter='' title='Ctrl+Enter' onClick={runReport} disabled={!ourEntityId || loading}
          style={{ padding: '8px 18px', background: C.accent, color: '#f5f0e8', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: !ourEntityId ? 'not-allowed' : 'pointer', opacity: !ourEntityId ? 0.5 : 1, fontFamily: 'inherit' }}>
          {loading ? 'Running…' : 'Run Report'}
        </button>
        <LedgerExportButtons ledger={ledger} onError={setExportError} />
        <Btn variant='ghost' onClick={handleExportCSV} disabled={!ledger}>↓ CSV</Btn>
      </div>
      {exportError && <div style={{ padding: '10px 14px', background: '#fbeaea', color: C.danger, borderRadius: '6px', fontSize: '13px' }}>{exportError}</div>}

      {ledger && <TallyLedgerTable ledger={ledger} />}

      {!loading && !ledger && (
        <div style={{ textAlign: 'center', padding: '48px', color: C.textMuted, fontSize: '13px' }}>
          Select an entity, then click "Run Report" to generate the ledger.
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
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  // CHANGED: Group By — entities now carry group_id (→ entity_groups), so this
  // already-cross-entity report can roll figures up by group instead of by
  // individual entity, reusing the exact same aggregation logic below.
  const [groupBy, setGroupBy] = useState('entity')
  const [rows, setRows]       = useState(null)
  const [loading, setLoading] = useState(false)

  async function runReport() {
    setLoading(true)
    const range = resolveDateRange(fys.find(f => f.id === fyId), dateFrom, dateTo)
    // CHANGED: excludeAutoPurchaseMirrors — see utils/query.js. Without it,
    // any entity buying from another internal entity has its purchases
    // (hence gross profit here) double-counted, skewing this cross-entity
    // comparison.
    let salesQ     = excludeAutoPurchaseMirrors(supabase.from('invoices').select('seller_entity_id, taxable_amount, invoice_date').eq('is_deleted', false).neq('status', 'cancelled'))
    let purchasesQ = excludeAutoPurchaseMirrors(supabase.from('invoices').select('buyer_entity_id, taxable_amount, invoice_date').eq('is_deleted', false).neq('status', 'cancelled'))
    let expensesQ  = supabase.from('expenses').select('entity_id, amount, expense_date').eq('is_deleted', false)
    salesQ     = applyDateRange(salesQ, range, 'invoice_date')
    purchasesQ = applyDateRange(purchasesQ, range, 'invoice_date')
    expensesQ  = applyDateRange(expensesQ, range, 'expense_date')
    const [{ data: sales }, { data: purchases }, { data: expenses }, { data: groups }] = await Promise.all([
      salesQ, purchasesQ, expensesQ,
      supabase.from('entity_groups').select('id,name'),
    ])

    const entityById = Object.fromEntries(entities.map(e => [e.id, e]))
    const groupById   = Object.fromEntries((groups || []).map(g => [g.id, g]))
    const bucketKey = entityId => groupBy === 'group' ? (entityById[entityId]?.group_id || 'ungrouped') : entityId

    const byKey = new Map()
    function ensure(entityId) {
      if (!entityId) return null
      const key = bucketKey(entityId)
      if (!byKey.has(key)) byKey.set(key, { sales: 0, purchases: 0, expenses: 0 })
      return byKey.get(key)
    }
    for (const s of (sales || []))     { const r = ensure(s.seller_entity_id); if (r) r.sales += s.taxable_amount }
    for (const p of (purchases || [])) { const r = ensure(p.buyer_entity_id);  if (r) r.purchases += p.taxable_amount }
    for (const e of (expenses || []))  { const r = ensure(e.entity_id);       if (r) r.expenses += e.amount }

    const result = [...byKey.entries()]
      .map(([key, v]) => {
        const grossProfit = v.sales - v.purchases
        const netProfit    = grossProfit - v.expenses
        const label = groupBy === 'group'
          ? (key === 'ungrouped' ? 'Ungrouped' : (groupById[key]?.name || 'Ungrouped'))
          : (entityById[key]?.short_name || entityById[key]?.name || '—')
        return { label, ...v, grossProfit, netProfit, margin: v.sales > 0 ? (netProfit / v.sales * 100) : null }
      })
      .sort((a, b) => b.netProfit - a.netProfit)
    setRows(result)
    setLoading(false)
  }

  function handleExportCSV() {
    if (!rows) return
    downloadCSV(`profitability_${today()}.csv`, ['label', 'sales', 'purchases', 'grossProfit', 'expenses', 'netProfit', 'margin'], rows)
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
        <DateRangeFields dateFrom={dateFrom} setDateFrom={setDateFrom} dateTo={dateTo} setDateTo={setDateTo} />
        <FormRow label='Group By'>
          <Select value={groupBy} onChange={e => setGroupBy(e.target.value)} style={{ minWidth: '140px' }}>
            <option value='entity'>Entity</option>
            <option value='group'>Group</option>
          </Select>
        </FormRow>
        <button data-ctrl-enter='' title='Ctrl+Enter' onClick={runReport} disabled={loading}
          style={{ padding: '8px 18px', background: C.accent, color: '#f5f0e8', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit' }}>
          {loading ? 'Running…' : 'Run Report'}
        </button>
        <Btn variant='ghost' onClick={handleExportCSV} disabled={!rows}>↓ Export CSV</Btn>
      </div>
      {rows && (
        <Card>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead><tr>
                <th style={{ ...th, textAlign: 'left' }}>{groupBy === 'group' ? 'Group' : 'Entity'}</th>
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
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', fontWeight: 600 }}>{r.label}</td>
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

// ─── Margin Report ────────────────────────────────────────────────────────────
// For a chosen middleman entity (e.g. MVL, bought from VRVPL and resold to
// Anugan), matches what they paid a supplier to what they charged their
// onward customer, so the margin they kept on that specific trade is
// visible. Two matching strategies, in priority order:
//   1. Order/Leg pairing — when the purchase invoice's leg is followed, on
//      the SAME order, by a leg where this entity is the from_entity, that
//      next leg's sale invoices are trusted as the exact match (an Order's
//      legs are built by the user specifically to chain one trade through
//      several entities, so they're assumed to correspond 1:1 — same
//      convention as computeLegMargin in Orders/index.jsx).
//   2. FIFO by product + date — for every purchase/sale NOT covered by a
//      leg pairing (most invoices, since Orders are opt-in), there's no
//      lot/batch id to match on (see utils/margin.js's matchPurchasesToSales
//      header), so the entity's oldest unconsumed purchase of a product is
//      matched to its oldest unmatched sale of that same product.
// Leftover purchased qty not yet resold, or sold qty with no matching
// purchase found (e.g. from opening stock, or excluded by the Supplier
// filter), is shown with no margin rather than guessed at.
function MarginReport({ entities, fys, defaultEntityId }) {
  const [entityId, setEntityId]     = useState('')
  useEffect(() => { if (defaultEntityId && !entityId) setEntityId(defaultEntityId) }, [defaultEntityId]) // eslint-disable-line react-hooks/exhaustive-deps
  const [supplierId, setSupplierId] = useState('all')
  const [fyId, setFyId]             = useState('')
  const [dateFrom, setDateFrom]     = useState('')
  const [dateTo, setDateTo]         = useState('')
  const [rows, setRows]             = useState(null)
  const [loading, setLoading]       = useState(false)

  async function runReport() {
    if (!entityId) return
    setLoading(true)
    const range = resolveDateRange(fys.find(f => f.id === fyId), dateFrom, dateTo)

    // Purchases into this entity (the supply side) — date-range bound, since
    // this defines the scope of goods being traced. excludeAutoPurchaseMirrors:
    // see utils/query.js — otherwise an internal supplier's sale double-counts
    // as this entity's purchase too.
    let purchQ = excludeAutoPurchaseMirrors(supabase.from('invoices')
      .select('id,invoice_no,invoice_date,seller_entity_id,order_leg_id,taxable_amount,total_qty,seller:seller_entity_id(name,short_name)')
      .eq('buyer_entity_id', entityId).eq('is_deleted', false).neq('status', 'cancelled'))
    if (supplierId !== 'all') purchQ = purchQ.eq('seller_entity_id', supplierId)
    purchQ = applyDateRange(purchQ, range, 'invoice_date')

    // Sales out of this entity — deliberately NOT date-bound, so a purchase
    // near the end of the selected range can still find its matching sale
    // even if that sale falls after the range.
    let saleQ = excludeAutoPurchaseMirrors(supabase.from('invoices')
      .select('id,invoice_no,invoice_date,buyer_entity_id,order_leg_id,taxable_amount,total_qty,buyer:buyer_entity_id(name,short_name)')
      .eq('seller_entity_id', entityId).eq('is_deleted', false).neq('status', 'cancelled'))

    const [{ data: purchInvoices }, { data: saleInvoices }] = await Promise.all([purchQ, saleQ])
    const purchIds = (purchInvoices || []).map(i => i.id)
    const saleIds  = (saleInvoices || []).map(i => i.id)

    const [{ data: purchLinesRaw }, { data: saleLinesRaw }] = await Promise.all([
      purchIds.length ? fetchAllPages(() => supabase.from('invoice_lines').select('invoice_id,product_name,qty,rate').in('invoice_id', purchIds)) : Promise.resolve({ data: [] }),
      saleIds.length  ? fetchAllPages(() => supabase.from('invoice_lines').select('invoice_id,product_name,qty,rate').in('invoice_id', saleIds))  : Promise.resolve({ data: [] }),
    ])

    const purchById = Object.fromEntries((purchInvoices || []).map(i => [i.id, i]))
    const saleById   = Object.fromEntries((saleInvoices || []).map(i => [i.id, i]))

    // Order/leg pairing — see header comment. A purchase leg's SAME-order
    // next leg, when that next leg's from_entity is this entity, is trusted
    // as the exact match.
    const legIds = [...new Set([...(purchInvoices || []), ...(saleInvoices || [])].map(i => i.order_leg_id).filter(Boolean))]
    let legById = {}, legByOrderAndNo = {}
    if (legIds.length) {
      const { data: legs } = await supabase.from('order_legs').select('id,order_id,leg_no,from_entity_id,to_entity_id').in('id', legIds)
      for (const l of (legs || [])) { legById[l.id] = l; legByOrderAndNo[`${l.order_id}__${l.leg_no}`] = l.id }
    }

    // Group purchase/sale invoices by leg — a leg invoiced in several
    // tranches is matched as one aggregate pair (same convention as
    // computeLegMargin in Orders/index.jsx).
    const purchByLeg = {}, saleByLeg = {}
    for (const i of (purchInvoices || [])) if (i.order_leg_id) (purchByLeg[i.order_leg_id] ||= []).push(i)
    for (const i of (saleInvoices  || [])) if (i.order_leg_id) (saleByLeg[i.order_leg_id]  ||= []).push(i)

    const legMatchedRows = []
    const legMatchedPurchInvIds = new Set()
    const legMatchedSaleInvIds  = new Set()
    for (const [legId, pInvs] of Object.entries(purchByLeg)) {
      const leg = legById[legId]
      if (!leg) continue
      const nextLegId = legByOrderAndNo[`${leg.order_id}__${leg.leg_no + 1}`]
      const sInvs = nextLegId ? saleByLeg[nextLegId] : null
      if (!sInvs || !sInvs.length) continue
      const purchTotal = round2(pInvs.reduce((s, i) => s + toNum(i.taxable_amount), 0))
      const purchQty   = round2(pInvs.reduce((s, i) => s + toNum(i.total_qty), 0))
      const saleTotal  = round2(sInvs.reduce((s, i) => s + toNum(i.taxable_amount), 0))
      legMatchedRows.push({
        matchType: 'Order Leg',
        supplierName: pInvs[0].seller?.short_name || pInvs[0].seller?.name || '—',
        customerName: sInvs[0].buyer?.short_name || sInvs[0].buyer?.name || '—',
        purchaseInvoices: pInvs.map(i => i.invoice_no).join(', '),
        saleInvoices: sInvs.map(i => i.invoice_no).join(', '),
        purchaseDate: pInvs[0].invoice_date, saleDate: sInvs[0].invoice_date,
        qty: purchQty, purchaseAmount: purchTotal, saleAmount: saleTotal,
        margin: round2(saleTotal - purchTotal), marginPct: calcMarginPct(purchTotal, saleTotal),
      })
      for (const i of pInvs) legMatchedPurchInvIds.add(i.id)
      for (const i of sInvs) legMatchedSaleInvIds.add(i.id)
    }

    // Everything not covered by a leg pairing falls to FIFO-by-product-date.
    const remainingPurchLines = (purchLinesRaw || [])
      .filter(l => !legMatchedPurchInvIds.has(l.invoice_id))
      .map(l => ({ ...l, invoice_date: purchById[l.invoice_id]?.invoice_date, invoice_no: purchById[l.invoice_id]?.invoice_no, supplierName: purchById[l.invoice_id]?.seller?.short_name || purchById[l.invoice_id]?.seller?.name || '—' }))
    const remainingSaleLines = (saleLinesRaw || [])
      .filter(l => !legMatchedSaleInvIds.has(l.invoice_id))
      .map(l => ({ ...l, invoice_date: saleById[l.invoice_id]?.invoice_date, invoice_no: saleById[l.invoice_id]?.invoice_no, customerName: saleById[l.invoice_id]?.buyer?.short_name || saleById[l.invoice_id]?.buyer?.name || '—' }))

    const fifoRows = matchPurchasesToSales(remainingPurchLines, remainingSaleLines).map(r => {
      if (r.matched) {
        const purchaseAmount = round2(r.qty * r.purchaseRate)
        const saleAmount = round2(r.qty * r.saleRate)
        return {
          matchType: 'FIFO',
          supplierName: r.purchase.supplierName, customerName: r.sale.customerName,
          purchaseInvoices: r.purchase.invoice_no, saleInvoices: r.sale.invoice_no,
          purchaseDate: r.purchase.invoice_date, saleDate: r.sale.invoice_date,
          qty: round2(r.qty), purchaseAmount, saleAmount, margin: round2(saleAmount - purchaseAmount), marginPct: calcMarginPct(purchaseAmount, saleAmount),
        }
      }
      if (r.side === 'purchase') {
        return {
          matchType: 'Unsold',
          supplierName: r.purchase.supplierName, customerName: '—',
          purchaseInvoices: r.purchase.invoice_no, saleInvoices: '—',
          purchaseDate: r.purchase.invoice_date, saleDate: null,
          qty: round2(r.qty), purchaseAmount: round2(r.qty * (Number(r.purchase.rate) || 0)), saleAmount: null, margin: null, marginPct: null,
        }
      }
      return {
        matchType: 'Unattributed Sale',
        supplierName: '—', customerName: r.sale.customerName,
        purchaseInvoices: '—', saleInvoices: r.sale.invoice_no,
        purchaseDate: null, saleDate: r.sale.invoice_date,
        qty: round2(r.qty), purchaseAmount: null, saleAmount: round2(r.qty * (Number(r.sale.rate) || 0)), margin: null, marginPct: null,
      }
    })

    const allRows = [...legMatchedRows, ...fifoRows]
      .sort((a, b) => (a.purchaseDate || a.saleDate || '').localeCompare(b.purchaseDate || b.saleDate || ''))
    setRows(allRows)
    setLoading(false)
  }

  function handleExportCSV() {
    if (!rows) return
    downloadCSV(`margin_report_${today()}.csv`,
      ['matchType', 'supplierName', 'purchaseInvoices', 'purchaseDate', 'customerName', 'saleInvoices', 'saleDate', 'qty', 'purchaseAmount', 'saleAmount', 'margin', 'marginPct'],
      rows)
  }

  const matchedRows   = (rows || []).filter(r => r.margin !== null)
  const totalPurchase = round2(matchedRows.reduce((s, r) => s + r.purchaseAmount, 0))
  const totalSale     = round2(matchedRows.reduce((s, r) => s + r.saleAmount, 0))
  const totalMargin   = round2(totalSale - totalPurchase)

  const th = { padding: '9px 12px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em' }
  const td = { padding: '9px 12px', borderBottom: '1px solid #f0e8d8' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <FormRow label='Entity' hint='The middleman whose margin you want'>
          <Select value={entityId} onChange={e => setEntityId(e.target.value)} style={{ minWidth: '200px' }}>
            <option value=''>Select entity</option>
            {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
          </Select>
        </FormRow>
        <FormRow label='Supplier' hint='Optional — restrict to purchases from one supplier'>
          <Select value={supplierId} onChange={e => setSupplierId(e.target.value)} style={{ minWidth: '180px' }}>
            <option value='all'>All suppliers</option>
            {entities.filter(e => e.id !== entityId).map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
          </Select>
        </FormRow>
        <FormRow label='Financial Year'>
          <Select value={fyId} onChange={e => setFyId(e.target.value)} style={{ minWidth: '160px' }}>
            <option value=''>All time</option>
            {fys.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </FormRow>
        <DateRangeFields dateFrom={dateFrom} setDateFrom={setDateFrom} dateTo={dateTo} setDateTo={setDateTo} toHint='Bounds the purchase side; matching sales are found regardless of date' />
        <button data-ctrl-enter='' title='Ctrl+Enter' onClick={runReport} disabled={!entityId || loading}
          style={{ padding: '8px 18px', background: C.accent, color: '#f5f0e8', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: !entityId ? 'not-allowed' : 'pointer', opacity: !entityId ? 0.5 : 1, fontFamily: 'inherit' }}>
          {loading ? 'Running…' : 'Run Report'}
        </button>
        <Btn variant='ghost' onClick={handleExportCSV} disabled={!rows}>↓ Export CSV</Btn>
      </div>

      {rows && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '12px' }}>
            <StatCard label='Matched Purchases' value={formatINR(totalPurchase)} />
            <StatCard label='Matched Sales' value={formatINR(totalSale)} />
            <StatCard label='Margin Kept' value={formatINR(totalMargin)} color={totalMargin >= 0 ? C.success : C.danger}
              sub={totalSale > 0 ? `${((totalMargin / totalSale) * 100).toFixed(1)}%` : undefined} />
          </div>

          <Card>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead><tr>
                  <th style={{ ...th, textAlign: 'left' }}>Supplier</th>
                  <th style={{ ...th, textAlign: 'left' }}>Purchase Inv.</th>
                  <th style={{ ...th, textAlign: 'left' }}>Purchase Date</th>
                  <th style={{ ...th, textAlign: 'left' }}>Customer</th>
                  <th style={{ ...th, textAlign: 'left' }}>Sale Inv.</th>
                  <th style={{ ...th, textAlign: 'left' }}>Sale Date</th>
                  <th style={{ ...th, textAlign: 'right' }}>Qty</th>
                  <th style={{ ...th, textAlign: 'right' }}>Purchase Value</th>
                  <th style={{ ...th, textAlign: 'right' }}>Sale Value</th>
                  <th style={{ ...th, textAlign: 'right' }}>Margin</th>
                  <th style={{ ...th, textAlign: 'right' }}>Margin %</th>
                  <th style={{ ...th, textAlign: 'left' }}>Matched Via</th>
                </tr></thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={12} style={{ padding: '24px', textAlign: 'center', color: C.textMuted }}>No purchases found for this selection.</td></tr>}
                  {rows.map((r, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? C.surface : '#faf6ed' }}>
                      <td style={td}>{r.supplierName}</td>
                      <td style={{ ...td, fontFamily: 'monospace', fontSize: '12px' }}>{r.purchaseInvoices}</td>
                      <td style={{ ...td, color: C.textSoft }}>{r.purchaseDate ? fmtDate(r.purchaseDate) : '—'}</td>
                      <td style={td}>{r.customerName}</td>
                      <td style={{ ...td, fontFamily: 'monospace', fontSize: '12px' }}>{r.saleInvoices}</td>
                      <td style={{ ...td, color: C.textSoft }}>{r.saleDate ? fmtDate(r.saleDate) : '—'}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{formatQty(r.qty)}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{r.purchaseAmount != null ? formatINR(r.purchaseAmount) : '—'}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{r.saleAmount != null ? formatINR(r.saleAmount) : '—'}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: r.margin == null ? C.textMuted : r.margin >= 0 ? C.success : C.danger }}>{r.margin != null ? formatINR(r.margin) : '—'}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: r.marginPct == null ? C.textMuted : r.marginPct >= 0 ? C.success : C.danger }}>{r.marginPct != null ? `${r.marginPct >= 0 ? '+' : ''}${r.marginPct.toFixed(1)}%` : '—'}</td>
                      <td style={td}><Badge status={r.matchType === 'Order Leg' ? 'completed' : r.matchType === 'FIFO' ? 'active' : 'pending'} label={r.matchType} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
      {!loading && !rows && (
        <div style={{ textAlign: 'center', padding: '48px', color: C.textMuted, fontSize: '13px' }}>Select an entity, then Run Report.</div>
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
  // CHANGED: stock position is a point-in-time snapshot, not a range — only
  // "To Date" is meaningful, wired to fetchActualStockPosition's existing
  // as-of param (utils/stock.js). "From Date" is still shown for filter-bar
  // consistency with every other report, but has no effect (see its hint).
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [rows, setRows]     = useState(null)
  const [loading, setLoading] = useState(false)

  async function runReport() {
    setLoading(true)
    // CHANGED: fetchActualStockPosition() hits the server-side aggregation
    // RPC (migration 041) when available, instead of downloading every raw
    // invoice line just to sum them per entity+product in the browser.
    const [map, { data: products }] = await Promise.all([
      fetchActualStockPosition(dateTo || null),
      fetchAllPages(() => supabase.from('products').select('id,name,hsn_code,unit,category')),
    ])
    const productByName = Object.fromEntries((products || []).map(p => [p.name, p]))
    const entityById  = Object.fromEntries(entities.map(e => [e.id, e]))
    // This is a "what do we actually hold right now" ledger, not a full
    // history — a product an entity once carried but is fully out of no
    // longer belongs here (same reasoning as Stock Position's hide-sold-out
    // default, applied unconditionally since this view has no toggle).
    let result = Object.values(map).filter(r => r.product_name && r.actual_qty !== 0)
    if (entityId) result = result.filter(r => r.entity_id === entityId)
    result = result
      .map(r => ({ ...r, entity: entityById[r.entity_id], product: productByName[r.product_name] }))
      .sort((a, b) => (a.entity?.name || '').localeCompare(b.entity?.name || '') || (a.product?.name || '').localeCompare(b.product?.name || ''))
    setRows(result)
    setLoading(false)
  }

  function handleExportCSV() {
    if (!rows) return
    downloadCSV(`actual_stock_${today()}.csv`,
      ['entity', 'product', 'category', 'opening_qty', 'invoiced_in', 'invoiced_out', 'actual_qty'],
      rows.map(r => ({ ...r, entity: r.entity?.short_name || r.entity?.name || '', product: r.product?.name || '', category: r.product?.category || '' })))
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
        <DateRangeFields dateFrom={dateFrom} setDateFrom={setDateFrom} dateTo={dateTo} setDateTo={setDateTo}
          toHint="Stock position is a snapshot — only 'To Date' applies, used as the as-of date." />
        <button data-ctrl-enter='' title='Ctrl+Enter' onClick={runReport} disabled={loading}
          style={{ padding: '8px 18px', background: C.accent, color: '#f5f0e8', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit' }}>
          {loading ? 'Running…' : 'Run Report'}
        </button>
        <Btn variant='ghost' onClick={handleExportCSV} disabled={!rows}>↓ Export CSV</Btn>
      </div>

      {rows && (
        <>
          <StatCard label='Rows' value={rows.length} sub={`${totalQty.toLocaleString('en-IN', { maximumFractionDigits: 2 })} total units across shown rows`} />
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
                      <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right' }}>{r.opening_qty.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                      <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right', color: C.success }}>+{r.invoiced_in.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                      <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right', color: C.warning }}>−{r.invoiced_out.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                      <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right', fontWeight: 700, color: r.actual_qty < 0 ? C.danger : C.text }}>{r.actual_qty.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
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
  // CHANGED: entity filter — every other report tab on this page lets you
  // scope to one entity, but this one previously took the `entities` prop
  // and never used it, dumping every E-way-Bill movement across the whole
  // business in one table. Matches on either side of the movement (an
  // entity cares about both what left and what arrived).
  const [entityId, setEntityId] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [rows, setRows]       = useState(null)
  const [loading, setLoading] = useState(false)

  async function runReport() {
    setLoading(true)
    const range = resolveDateRange(null, dateFrom, dateTo)
    const [{ data: invLines }] = await Promise.all([
      fetchAllPages(() => supabase.from('invoice_lines')
        .select('qty, product_name, invoice:invoice_id(invoice_no, eway_bill_no, eway_bill_date, status, invoice_type, seller_entity_id, buyer_entity_id, source_invoice_id, seller:seller_entity_id(name,short_name), buyer:buyer_entity_id(name,short_name))')
        .not('invoice', 'is', null)),
    ])
    // CHANGED: only the auto-generated buyer-side mirror (source_invoice_id
    // set) is excluded to avoid showing the same movement twice — a manual
    // purchase invoice (no source_invoice_id) is the only record of that
    // movement and must still appear (see stock.js for the same rule).
    // CHANGED: dropped the `status !== 'draft'` check — the EWB section
    // isn't locked for draft invoices, so a real E-way Bill can exist on
    // one, and that's the actual movement event regardless of the
    // document's own draft/submitted label (see stock.js's
    // MOVEMENT_STATUSES_EXCLUDED for the full rationale).
    const result = (invLines || [])
      .filter(l => l.invoice && l.invoice.status !== 'cancelled' && l.invoice.eway_bill_no && !(l.invoice.invoice_type === 'purchase' && l.invoice.source_invoice_id))
      .filter(l => !entityId || l.invoice.seller_entity_id === entityId || l.invoice.buyer_entity_id === entityId)
      .filter(l => inDateRange(l.invoice.eway_bill_date, range))
      .map(l => ({
        eway_bill_no: l.invoice.eway_bill_no, eway_bill_date: l.invoice.eway_bill_date, invoice_no: l.invoice.invoice_no,
        product: l.product_name || '⚠ No product',
        qty: l.qty, from: l.invoice.seller?.short_name || l.invoice.seller?.name, to: l.invoice.buyer?.short_name || l.invoice.buyer?.name,
      }))
      .sort((a, b) => new Date(b.eway_bill_date || 0) - new Date(a.eway_bill_date || 0))
    setRows(result)
    setLoading(false)
  }

  function handleExportCSV() {
    if (!rows) return
    downloadCSV(`stock_movements_${today()}.csv`, ['eway_bill_date', 'eway_bill_no', 'invoice_no', 'product', 'qty', 'from', 'to'], rows)
  }

  const th = { padding: '9px 12px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <FormRow label='Entity'>
          <Select value={entityId} onChange={e => setEntityId(e.target.value)} style={{ minWidth: '200px' }}>
            <option value=''>All entities</option>
            {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
          </Select>
        </FormRow>
        <DateRangeFields dateFrom={dateFrom} setDateFrom={setDateFrom} dateTo={dateTo} setDateTo={setDateTo} />
        <button data-ctrl-enter='' title='Ctrl+Enter' onClick={runReport} disabled={loading}
          style={{ padding: '8px 18px', background: C.accent, color: '#f5f0e8', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit' }}>
          {loading ? 'Running…' : 'Run Report'}
        </button>
        <Btn variant='ghost' onClick={handleExportCSV} disabled={!rows}>↓ Export CSV</Btn>
      </div>
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
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right', fontWeight: 600 }}>{Number(r.qty).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
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
// Any qty>0 line with no product_name is invisible to every stock calculation —
// this is the same rule findLinesMissingProductName() blocks on save, surfaced
// here for lines that slipped through before that validation existed.
function MissingProductReport() {
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [rows, setRows]       = useState(null)
  const [loading, setLoading] = useState(false)

  async function runReport() {
    setLoading(true)
    const range = resolveDateRange(null, dateFrom, dateTo)
    const [{ data: piLines }, { data: poLines }, { data: invLines }] = await Promise.all([
      supabase.from('proforma_invoice_lines').select('qty, product_name, pi:pi_id(pi_no, pi_date, from_entity:from_entity_id(name,short_name))').is('product_name', null),
      supabase.from('purchase_order_lines').select('qty, product_name, po:po_id(po_no, po_date, buyer:buyer_entity_id(name,short_name))').is('product_name', null),
      supabase.from('invoice_lines').select('qty, product_name, invoice:invoice_id(invoice_no, invoice_date, seller:seller_entity_id(name,short_name))').is('product_name', null),
    ])
    const result = [
      ...(piLines || []).filter(l => l.pi && Number(l.qty) > 0).map(l => ({ source: 'PI', doc: l.pi.pi_no, date: l.pi.pi_date, entity: l.pi.from_entity?.short_name || l.pi.from_entity?.name, qty: l.qty })),
      ...(poLines || []).filter(l => l.po && Number(l.qty) > 0).map(l => ({ source: 'PO', doc: l.po.po_no, date: l.po.po_date, entity: l.po.buyer?.short_name || l.po.buyer?.name, qty: l.qty })),
      ...(invLines || []).filter(l => l.invoice && Number(l.qty) > 0).map(l => ({ source: 'Invoice', doc: l.invoice.invoice_no, date: l.invoice.invoice_date, entity: l.invoice.seller?.short_name || l.invoice.seller?.name, qty: l.qty })),
    ]
      .filter(l => inDateRange(l.date, range))
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    setRows(result)
    setLoading(false)
  }

  function handleExportCSV() {
    if (!rows) return
    downloadCSV(`missing_products_${today()}.csv`, ['source', 'doc', 'date', 'entity', 'qty'], rows)
  }

  const th = { padding: '9px 12px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <DateRangeFields dateFrom={dateFrom} setDateFrom={setDateFrom} dateTo={dateTo} setDateTo={setDateTo} />
        <button data-ctrl-enter='' title='Ctrl+Enter' onClick={runReport} disabled={loading}
          style={{ padding: '8px 18px', background: C.accent, color: '#f5f0e8', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit' }}>
          {loading ? 'Running…' : 'Run Report'}
        </button>
        <Btn variant='ghost' onClick={handleExportCSV} disabled={!rows}>↓ Export CSV</Btn>
      </div>
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
                      <td style={{ padding: '9px 12px', borderBottom: '1px solid #f0e8d8', textAlign: 'right', fontWeight: 600 }}>{Number(r.qty).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
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

const ageingTh = { padding: '9px 12px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em' }

// CHANGED: hoisted out of AgeingReport's render body — its only dependencies
// (AGE_BUCKETS, ageingTh, C, formatINR, fmtDate) are all module-level, so
// nothing was actually closing over AgeingReport's own state.
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
            <th style={{ ...ageingTh, textAlign: 'left' }}>Invoice No</th>
            <th style={{ ...ageingTh, textAlign: 'left' }}>Party</th>
            <th style={{ ...ageingTh, textAlign: 'left' }}>Due Date</th>
            <th style={{ ...ageingTh, textAlign: 'right' }}>Days Overdue</th>
            <th style={{ ...ageingTh, textAlign: 'right' }}>Outstanding</th>
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

function AgeingReport({ entities, defaultEntityId }) {
  const [entityId, setEntityId] = useState('')
  useEffect(() => { if (defaultEntityId && !entityId) setEntityId(defaultEntityId) }, [defaultEntityId]) // eslint-disable-line react-hooks/exhaustive-deps
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [rows, setRows]       = useState(null)
  const [loading, setLoading] = useState(false)

  async function runReport() {
    if (!entityId) return
    setLoading(true)
    // CHANGED: excludeAutoPurchaseMirrors — see utils/query.js. The mirror
    // also carries its own outstanding_amount, so an internal buyer's
    // payables (and, symmetrically, an internal seller's receivables) would
    // otherwise be doubled here too.
    const [{ data: receivables }, { data: payables }] = await Promise.all([
      excludeAutoPurchaseMirrors(supabase.from('invoices').select('id,invoice_no,invoice_date,due_date,total_amount,buyer:buyer_entity_id(name,short_name)').eq('seller_entity_id', entityId).eq('is_deleted', false).neq('status', 'cancelled')),
      excludeAutoPurchaseMirrors(supabase.from('invoices').select('id,invoice_no,invoice_date,due_date,total_amount,seller:seller_entity_id(name,short_name)').eq('buyer_entity_id', entityId).eq('is_deleted', false).neq('status', 'cancelled')),
    ])
    const invIds = [...(receivables || []), ...(payables || [])].map(i => i.id)
    let tranchesByInvoice = new Map()
    if (invIds.length) {
      const { data: tranches } = await supabase.from('invoice_payments').select('invoice_id, amount, tds_amount, adjustments').eq('is_deleted', false).in('invoice_id', invIds)
      tranchesByInvoice = groupTranchesByInvoice(tranches)
    }
    // CHANGED: custom date range scopes WHICH invoices are included (by
    // invoice_date) — the overdue-days math itself stays relative to today,
    // unchanged, since ageing is inherently an "as of now" view.
    const range = resolveDateRange(null, dateFrom, dateTo)
    const todayStr = today()
    function toRows(list, partyKey) {
      return (list || []).filter(inv => inDateRange(inv.invoice_date, range)).map(inv => {
        const { pending } = computeInvoiceOutstanding(inv, tranchesByInvoice.get(inv.id))
        const dueDate = inv.due_date || inv.invoice_date
        const daysOverdue = Math.floor((new Date(todayStr) - new Date(dueDate)) / 86400000)
        return { invoice_no: inv.invoice_no, date: inv.invoice_date, due_date: inv.due_date, party: inv[partyKey]?.short_name || inv[partyKey]?.name, pending, daysOverdue }
      }).filter(r => r.pending > 0)
    }
    setRows({ receivables: toRows(receivables, 'buyer'), payables: toRows(payables, 'seller') })
    setLoading(false)
  }

  function handleExportCSV() {
    if (!rows) return
    const combined = [
      ...rows.receivables.map(r => ({ ...r, type: 'Receivable' })),
      ...rows.payables.map(r => ({ ...r, type: 'Payable' })),
    ]
    downloadCSV(`ageing_${today()}.csv`, ['type', 'invoice_no', 'party', 'due_date', 'daysOverdue', 'pending'], combined)
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
        <DateRangeFields dateFrom={dateFrom} setDateFrom={setDateFrom} dateTo={dateTo} setDateTo={setDateTo} />
        <button data-ctrl-enter='' title='Ctrl+Enter' onClick={runReport} disabled={!entityId || loading}
          style={{ padding: '8px 18px', background: C.accent, color: '#f5f0e8', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: !entityId ? 'not-allowed' : 'pointer', opacity: !entityId ? 0.5 : 1, fontFamily: 'inherit' }}>
          {loading ? 'Running…' : 'Run Report'}
        </button>
        <Btn variant='ghost' onClick={handleExportCSV} disabled={!rows}>↓ Export CSV</Btn>
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

// ─── Party Ledger ───────────────────────────────────────────────────────────────
// A vendor ledger for parties from the global parties master, across one or
// more of our entities: expenses booked (what we owe) vs party_payments (what we paid),
// with a running outstanding balance. Distinct from the entity-vs-entity Ledger.
function PartyLedger({ entities, parties, fys, defaultEntityId }) {
  // CHANGED: entity and party are multi-select. Nothing ticked = all of them
  // (entities are still limited to the ones this user has access to, by RLS).
  const [entityIds, setEntityIds] = useState([])
  const [defaulted, setDefaulted] = useState(false)
  useEffect(() => { if (defaultEntityId && !defaulted) { setEntityIds([defaultEntityId]); setDefaulted(true) } }, [defaultEntityId]) // eslint-disable-line react-hooks/exhaustive-deps
  const [partyIds, setPartyIds] = useState([])
  const [fyId, setFyId]         = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [ledger, setLedger]     = useState(null)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')

  async function runReport() {
    setLoading(true)
    setError('')
    const range = resolveDateRange(fys.find(f => f.id === fyId), dateFrom, dateTo)
    // CHANGED: fetched up to the period end only, so everything before the
    // period start can be rolled into the Opening Balance.
    const upTo = range?.end ? { end: range.end } : null
    const scope = q => {
      if (entityIds.length) q = q.in('entity_id', entityIds)
      if (partyIds.length)  q = q.in('party_id', partyIds)
      return q
    }
    // vendor_invoice_no is the main identifier; expense_no is the system reference.
    const [{ data: exps, error: expErr }, { data: pays, error: payErr }] = await Promise.all([
      fetchAllPages(() => applyDateRange(scope(supabase.from('expenses')
        .select('id,entity_id,party_id,expense_no,vendor_invoice_no,vendor_invoice_date,expense_date,description,total_amount')
        .eq('is_deleted', false).not('party_id', 'is', null)), upTo, 'expense_date').order('expense_date').order('id')),
      fetchAllPages(() => applyDateRange(scope(supabase.from('party_payments')
        .select('id,entity_id,party_id,payment_date,amount,tds_amount,reference,mode,expense:expense_id(expense_no,vendor_invoice_no)')
        .eq('is_deleted', false)), upTo, 'payment_date').order('payment_date').order('id')),
    ])
    if (expErr || payErr) { setLedger(null); setError((expErr || payErr).message); setLoading(false); return }

    const entityName = id => { const e = entities.find(x => x.id === id); return e ? (e.short_name || e.name) : '—' }
    const partyName  = id => parties.find(p => p.id === id)?.name || '—'
    // CHANGED: Tally-style statement of the party's account in our books.
    //   Expense booked  → Credit (we owe the party)
    //   Payment made    → Debit  (cash paid + TDS withheld — the TDS still
    //                     settles the bill, same convention as computeInvoiceOutstanding)
    // So a Credit closing balance = still payable to the party.
    const all = [
      ...(exps || []).map(e => ({ date: e.expense_date, entity: entityName(e.entity_id), party: partyName(e.party_id),
        particulars: partyName(e.party_id), note: [entityName(e.entity_id), e.description].filter(Boolean).join(' · '),
        vchType: 'Expense', vchNo: e.vendor_invoice_no || e.expense_no || '', dr: 0, cr: Number(e.total_amount) || 0 })),
      ...(pays || []).map(p => ({ date: p.payment_date, entity: entityName(p.entity_id), party: partyName(p.party_id),
        particulars: partyName(p.party_id),
        note: [entityName(p.entity_id), p.mode, (p.expense?.vendor_invoice_no || p.expense?.expense_no) ? `against ${p.expense.vendor_invoice_no || p.expense.expense_no}` : '', Number(p.tds_amount) ? `incl. TDS ${formatINR(p.tds_amount)}` : ''].filter(Boolean).join(' · '),
        vchType: 'Payment', vchNo: p.reference || '', dr: (Number(p.amount) || 0) + (Number(p.tds_amount) || 0), cr: 0 })),
    ].sort((a, b) => new Date(a.date) - new Date(b.date))

    const start = range?.start || null
    let opening = 0
    const period = []
    for (const r of all) { if (start && (r.date || '') < start) opening += r.dr - r.cr; else period.push(r) }
    const names = (ids, list, label, allLabel) => ids.length === 0 ? allLabel : ids.length <= 3 ? ids.map(id => { const x = list.find(v => v.id === id); return x ? (x.name || x.short_name) : '' }).filter(Boolean).join(', ') : `${ids.length} ${label}`
    setLedger({
      title: names(entityIds, entities, 'entities', 'All entities'),
      account: names(partyIds, parties, 'parties', 'All parties'),
      period: periodLabel(range),
      opening, rows: period,
    })
    setLoading(false)
  }

  function handleExportCSV() {
    if (!ledger) return
    const t = ledgerTotals(ledger)
    const blank = { date: '', entity: '', party: '', vch_type: '', vch_no: '', note: '' }
    downloadCSV(`party_ledger_${today()}.csv`, ['date', 'entity', 'party', 'particulars', 'vch_type', 'vch_no', 'note', 'debit', 'credit'], [
      { ...blank, particulars: 'Opening Balance', debit: t.opening > 0 ? t.opening : '', credit: t.opening < 0 ? -t.opening : '' },
      ...ledger.rows.map(r => ({ date: r.date, entity: r.entity, party: r.party, particulars: r.particulars, vch_type: r.vchType, vch_no: r.vchNo, note: r.note, debit: r.dr || '', credit: r.cr || '' })),
      { ...blank, particulars: 'Current Total', debit: t.totalDr, credit: t.totalCr },
      { ...blank, particulars: `Closing Balance (${t.closing >= 0 ? 'Dr' : 'Cr'})`, debit: t.closing >= 0 ? t.closing : '', credit: t.closing < 0 ? -t.closing : '' },
    ])
  }

  const closing = ledger ? ledgerTotals(ledger).closing : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <FormRow label='Entity'>
          <MultiSelectDropdown options={entities.map(e => ({ value: e.id, label: e.short_name || e.name }))} selected={entityIds} onChange={setEntityIds} placeholder='All entities' capitalize={false} style={{ minWidth: '180px' }} />
        </FormRow>
        <FormRow label='Party'>
          <MultiSelectDropdown options={parties.map(p => ({ value: p.id, label: p.name }))} selected={partyIds} onChange={setPartyIds} placeholder='All parties' capitalize={false} style={{ minWidth: '200px' }} />
        </FormRow>
        <FormRow label='Financial Year'>
          <Select value={fyId} onChange={e => setFyId(e.target.value)} style={{ minWidth: '160px' }}>
            <option value=''>All time</option>
            {fys.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </FormRow>
        <DateRangeFields dateFrom={dateFrom} setDateFrom={setDateFrom} dateTo={dateTo} setDateTo={setDateTo} />
        <button data-ctrl-enter='' title='Ctrl+Enter' onClick={runReport} disabled={loading}
          style={{ padding: '8px 18px', background: C.accent, color: '#f5f0e8', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.5 : 1 }}>
          {loading ? 'Running…' : 'Run Report'}
        </button>
        <LedgerExportButtons ledger={ledger} onError={setError} />
        <Btn variant='ghost' onClick={handleExportCSV} disabled={!ledger}>↓ CSV</Btn>
      </div>

      {error && <div style={{ padding: '12px 14px', background: '#fbeaea', color: C.danger, borderRadius: '6px', fontSize: '13px' }}>Report could not be loaded: {error}</div>}

      {ledger && (
        <>
          <div style={{ fontSize: '12px', color: C.textSoft }}>
            {closing < 0 ? `Credit closing balance — ${formatINR(-closing)} still payable.` : closing > 0 ? `Debit closing balance — ${formatINR(closing)} paid in advance / overpaid.` : 'Settled — nothing outstanding.'}
          </div>
          <TallyLedgerTable ledger={ledger} />
        </>
      )}
      {!loading && !error && !ledger && (
        <div style={{ textAlign: 'center', padding: '48px', color: C.textMuted, fontSize: '13px' }}>Pick entities and parties (leave blank for all), then Run Report.</div>
      )}
    </div>
  )
}

// ─── Reports Shell ────────────────────────────────────────────────────────────
export default function Reports() {
  const [tab, setTab]           = useState('P&L')
  const [complianceTab, setComplianceTab] = useState('GST Summary') // CHANGED: sub-tab within Compliance
  // CHANGED: master sees every entity same as before; everyone else only
  // sees entities they've been granted — no point offering an entity picker
  // full of entities whose reports RLS would return empty for anyway.
  const { entities, defaultEntityId } = useEntityAccess()
  const [fys, setFys]           = useState([])
  const [parties, setParties]   = useState([]) // CHANGED: global party master, for the Party Ledger tab

  useEffect(() => {
    supabase.from('financial_years').select('*').order('start_date', { ascending: false }).then(({ data }) => setFys(data || []))
    supabase.from('parties').select('id,name').eq('is_deleted', false).eq('is_active', true).order('name').then(({ data }) => setParties(data || []))
  }, [])

  return (
    <div>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: '20px', fontWeight: 700, color: C.text, margin: 0 }}>Reports</h1>
        <p style={{ fontSize: '13px', color: C.textMuted, margin: '4px 0 0' }}>Financial and operational reports</p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: tab === 'Compliance' ? '0' : '24px', borderBottom: `2px solid ${C.border}`, paddingBottom: '0' }}>
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

      {/* CHANGED: Compliance sub-tabs — shown only when Compliance is active */}
      {tab === 'Compliance' && (
        <div style={{ display: 'flex', gap: '4px', marginBottom: '24px', borderBottom: `1px solid ${C.border}`, paddingBottom: '0' }}>
          {COMPLIANCE_TABS.map(t => (
            <button key={t} onClick={() => setComplianceTab(t)}
              style={{
                padding: '6px 16px', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                fontWeight: complianceTab === t ? 700 : 500, fontSize: '12px',
                color: complianceTab === t ? C.accent : C.textSoft,
                background: complianceTab === t ? C.bg : 'transparent',
                borderRadius: '6px 6px 0 0', transition: 'all 0.15s',
              }}>
              {t}
            </button>
          ))}
        </div>
      )}

      {tab === 'P&L'         && <PLReport entities={entities} fys={fys} defaultEntityId={defaultEntityId} />}
      {tab === 'Compliance' && complianceTab === 'GST Summary' && <GSTSummary entities={entities} fys={fys} defaultEntityId={defaultEntityId} />}
      {tab === 'Compliance' && complianceTab === 'TDS/TCS Report' && <TdsTcsReport entities={entities} fys={fys} defaultEntityId={defaultEntityId} />}
      {tab === 'Party Ledger' && <PartyLedger entities={entities} parties={parties} fys={fys} defaultEntityId={defaultEntityId} />}
      {tab === 'Ledger'      && <Ledger entities={entities} fys={fys} defaultEntityId={defaultEntityId} />}
      {tab === 'Profitability' && <ProfitabilityReport entities={entities} fys={fys} />}
      {tab === 'Margin Report' && <MarginReport entities={entities} fys={fys} defaultEntityId={defaultEntityId} />}
      {tab === 'Actual Stock'    && <ActualStockReport entities={entities} defaultEntityId={defaultEntityId} />}
      {tab === 'Stock Movements' && <StockMovementReport entities={entities} />}
      {tab === 'Missing Products' && <MissingProductReport />}
      {tab === 'Ageing'      && <AgeingReport entities={entities} defaultEntityId={defaultEntityId} />}
      {tab === 'Order Trail' && <OrderTrail entities={entities} />}
    </div>
  )
}
