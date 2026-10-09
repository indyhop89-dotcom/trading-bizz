// ─── Order Trail ────────────────────────────────────────────────────────────────
// Read-only drill-down that follows the chain already recorded in the system:
//
//   Order → Leg → Invoice → Challan (vehicle rows on the invoice) → Expense
//
// Links used (nothing new is stored):
//   invoices.order_id / order_leg_id        invoice → order, leg
//   invoice_vehicles.challan_no             invoice → challan
//   expense_challans.challan_no             challan → expense   (challan = number + transporter)
//   expenses.invoice_id / order_id          expenses tagged straight to an invoice / order
//
// A freight bill that covers several challans is shown in full under each of
// them and marked as shared — the amount is never split (same rule as the
// Challans module). Every total counts an expense once.
import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../../supabaseClient'
import { fetchAllPages, excludeAutoPurchaseMirrors } from '../../utils/query'
import { C, Card, StatCard, Btn, MultiSelectDropdown } from '../../components/UI/index'
import { formatINR } from '../../utils/money'
import { fmtDate, today } from '../../utils/dates'
import { downloadCSV } from '../../utils/csvTemplate'
import { challanKey, clean } from '../../utils/challans'

const NO_ORDER = '__none__'
const entName = e => e?.short_name || e?.name || '—'
const expLabel = e => e.vendor_invoice_no || e.expense_no || 'Expense'

export default function OrderTrail({ entities }) {
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [search, setSearch]   = useState('')
  const [orderFilter, setOrderFilter]   = useState([])
  const [entityFilter, setEntityFilter] = useState([])
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [open, setOpen]         = useState(new Set()) // expanded order + leg rows

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const [orders, legs, invoices, links, expenses] = await Promise.all([
        fetchAllPages(() => supabase.from('orders').select('id,name,description').eq('is_deleted', false).order('name')),
        fetchAllPages(() => supabase.from('order_legs')
          .select('id,order_id,leg_no,from_entity:from_entity_id(name,short_name),to_entity:to_entity_id(name,short_name)').order('id')),
        // Auto-created purchase mirrors are left out so an invoice never shows twice.
        fetchAllPages(() => excludeAutoPurchaseMirrors(supabase.from('invoices')
          .select('id,invoice_no,invoice_date,invoice_type,status,total_amount,eway_bill_no,order_id,order_leg_id,seller_entity_id,buyer_entity_id,' +
            'seller:seller_entity_id(name,short_name),buyer:buyer_entity_id(name,short_name),' +
            'vehicles:invoice_vehicles(vehicle_no,challan_no,transporter_name)')
          .eq('is_deleted', false).neq('status', 'cancelled')).order('invoice_date').order('id')),
        fetchAllPages(() => supabase.from('expense_challans').select('id,expense_id,challan_no,transporter_name').order('id')),
        fetchAllPages(() => supabase.from('expenses')
          .select('id,expense_no,vendor_invoice_no,expense_date,expense_type,description,total_amount,status,entity_id,order_id,invoice_id,vendor_name,entity:entity_id(name,short_name)')
          .eq('is_deleted', false).order('expense_date').order('id')),
      ])
      if (cancelled) return
      const failed = [orders, legs, invoices, links, expenses].find(r => r.error)
      if (failed) { setError(failed.error.message); setLoading(false); return }
      setData({ orders: orders.data, legs: legs.data, invoices: invoices.data, links: links.data, expenses: expenses.data })
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  // ── Build the tree from what is loaded + the filters ──────────────────────
  const tree = useMemo(() => {
    if (!data) return null
    const expById = new Map(data.expenses.map(e => [e.id, e]))
    const legById = new Map(data.legs.map(l => [l.id, l]))

    // challan → expenses, and for each expense: how many challans / orders it reaches
    const expIdsByKey = new Map(), keysByExp = new Map()
    for (const l of data.links) {
      if (!expById.has(l.expense_id)) continue // deleted expense
      const key = challanKey(l.challan_no, l.transporter_name)
      if (!key) continue
      if (!expIdsByKey.has(key)) expIdsByKey.set(key, [])
      if (!expIdsByKey.get(key).includes(l.expense_id)) expIdsByKey.get(key).push(l.expense_id)
      if (!keysByExp.has(l.expense_id)) keysByExp.set(l.expense_id, new Set())
      keysByExp.get(l.expense_id).add(key)
    }
    const ordersByKey = new Map()
    for (const inv of data.invoices) for (const v of inv.vehicles || []) {
      const key = challanKey(v.challan_no, v.transporter_name)
      if (!key) continue
      if (!ordersByKey.has(key)) ordersByKey.set(key, new Set())
      ordersByKey.get(key).add(inv.order_id || NO_ORDER)
    }
    const ordersOfExp = id => {
      const ords = new Set()
      for (const k of keysByExp.get(id) || []) for (const o of ordersByKey.get(k) || []) ords.add(o)
      return ords
    }
    const sharedNote = exp => {
      const keys = keysByExp.get(exp.id)
      if (!keys || keys.size < 2) return ''
      const ords = ordersOfExp(exp.id)
      return `Shared bill — covers ${keys.size} challans${ords.size > 1 ? ` across ${ords.size} orders` : ''}`
    }

    const q = search.trim().toLowerCase()
    const inDates = d => (!dateFrom || (d || '') >= dateFrom) && (!dateTo || (d || '') <= dateTo)
    const orderOk = id => orderFilter.length === 0 || orderFilter.includes(id || NO_ORDER)
    const orderById = new Map(data.orders.map(o => [o.id, o]))
    const nodes = new Map() // order id → node
    const nodeFor = id => {
      const key = id || NO_ORDER
      if (!nodes.has(key)) {
        const o = orderById.get(id)
        nodes.set(key, { id: key, name: o ? o.name : (id ? 'Order not found' : 'No order linked'), description: o?.description || '', legs: new Map(), other: [], shown: new Set(), invoiceCount: 0, challanKeys: new Set(), unbilledKeys: new Set() })
      }
      return nodes.get(key)
    }

    for (const inv of data.invoices) {
      if (!orderOk(inv.order_id) || !inDates(inv.invoice_date)) continue
      if (entityFilter.length && !entityFilter.includes(inv.seller_entity_id) && !entityFilter.includes(inv.buyer_entity_id)) continue

      // Vehicle rows → one entry per challan on this invoice
      const challans = new Map(), loose = []
      for (const v of inv.vehicles || []) {
        const key = challanKey(v.challan_no, v.transporter_name)
        const veh = clean(v.vehicle_no)
        if (!key) { if (veh) loose.push(veh); continue }
        if (!challans.has(key)) challans.set(key, { key, challan_no: clean(v.challan_no), transporter: clean(v.transporter_name), vehicles: [], expenses: [] })
        if (veh && !challans.get(key).vehicles.includes(veh)) challans.get(key).vehicles.push(veh)
      }
      const onInvoice = new Set()
      for (const c of challans.values()) {
        c.expenses = (expIdsByKey.get(c.key) || []).map(id => expById.get(id)).filter(Boolean)
        c.expenses.forEach(e => onInvoice.add(e.id))
      }
      // Expenses tagged straight to this invoice (not through a challan)
      const direct = data.expenses.filter(e => e.invoice_id === inv.id && !onInvoice.has(e.id))
      direct.forEach(e => onInvoice.add(e.id))

      const node = nodeFor(inv.order_id)
      if (q) {
        const hay = [node.name, node.description, inv.invoice_no, inv.eway_bill_no, entName(inv.seller), entName(inv.buyer), ...loose,
          ...[...challans.values()].flatMap(c => [c.challan_no, c.transporter, ...c.vehicles]),
          ...[...onInvoice].flatMap(id => { const e = expById.get(id); return [e.vendor_invoice_no, e.expense_no, e.vendor_name, e.description] }),
        ].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(q)) continue
      }

      const legKey = inv.order_leg_id || NO_ORDER
      if (!node.legs.has(legKey)) node.legs.set(legKey, { id: legKey, leg: legById.get(inv.order_leg_id) || null, invoices: [] })
      node.legs.get(legKey).invoices.push({ inv, challans: [...challans.values()], loose, direct })
      node.invoiceCount++
      onInvoice.forEach(id => node.shown.add(id))
      for (const c of challans.values()) { node.challanKeys.add(c.key); if (c.expenses.length === 0) node.unbilledKeys.add(c.key) }
    }

    // Expenses tagged to an order only — not to one of its invoices, and not
    // reaching the order through a challan (those sit under the invoice above).
    const invoiceIds = new Set(data.invoices.map(i => i.id))
    for (const e of data.expenses) {
      if (!e.order_id || !orderOk(e.order_id) || !inDates(e.expense_date)) continue
      if (entityFilter.length && !entityFilter.includes(e.entity_id)) continue
      if (e.invoice_id && invoiceIds.has(e.invoice_id)) continue
      if (ordersOfExp(e.id).has(e.order_id)) continue
      const o = orderById.get(e.order_id)
      if (q && ![o?.name, o?.description, e.vendor_invoice_no, e.expense_no, e.vendor_name, e.description].filter(Boolean).join(' ').toLowerCase().includes(q)) continue
      const node = nodeFor(e.order_id)
      node.other.push(e); node.shown.add(e.id)
    }

    const list = [...nodes.values()].filter(n => n.invoiceCount > 0 || n.other.length > 0).map(n => ({
      ...n,
      legs: [...n.legs.values()].sort((a, b) => (a.leg?.leg_no ?? 9999) - (b.leg?.leg_no ?? 9999)),
      expenseTotal: [...n.shown].reduce((s, id) => s + (Number(expById.get(id)?.total_amount) || 0), 0),
    })).sort((a, b) => (a.id === NO_ORDER) - (b.id === NO_ORDER) || a.name.localeCompare(b.name, undefined, { numeric: true }))

    const allShown = new Set(), allKeys = new Set(), unbilled = new Set()
    for (const n of list) { n.shown.forEach(id => allShown.add(id)); n.challanKeys.forEach(k => allKeys.add(k)); n.unbilledKeys.forEach(k => unbilled.add(k)) }
    return {
      list, sharedNote,
      totals: {
        orders: list.filter(n => n.id !== NO_ORDER).length,
        invoices: list.reduce((s, n) => s + n.invoiceCount, 0),
        challans: allKeys.size, unbilled: unbilled.size,
        expenses: allShown.size,
        expenseTotal: [...allShown].reduce((s, id) => s + (Number(expById.get(id)?.total_amount) || 0), 0),
      },
    }
  }, [data, search, orderFilter, entityFilter, dateFrom, dateTo])

  const anyFilter = search || orderFilter.length || entityFilter.length || dateFrom || dateTo
  function clearFilters() { setSearch(''); setOrderFilter([]); setEntityFilter([]); setDateFrom(''); setDateTo('') }
  function toggle(id) { setOpen(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n }) }
  const isOpen = id => !!search.trim() || open.has(id) // a search opens every match

  function handleExportCSV() {
    if (!tree) return
    const rows = []
    const base = (n, lg, row) => ({
      order: n.name, order_description: n.description,
      leg: lg?.leg ? `Leg ${lg.leg.leg_no}` : '', leg_from: lg?.leg ? entName(lg.leg.from_entity) : '', leg_to: lg?.leg ? entName(lg.leg.to_entity) : '',
      invoice_no: row?.inv.invoice_no || '', invoice_date: row?.inv.invoice_date || '', invoice_type: row?.inv.invoice_type || '',
      seller: row ? entName(row.inv.seller) : '', buyer: row ? entName(row.inv.buyer) : '',
      invoice_total: row?.inv.total_amount ?? '', eway_bill_no: row?.inv.eway_bill_no || '',
      challan_no: '', transporter: '', vehicles: '', link: '',
      vendor_invoice_no: '', expense_ref: '', expense_date: '', expense_type: '', vendor: '', expense_total: '', expense_status: '', note: '',
    })
    const exp = (e, link) => ({ link, vendor_invoice_no: e.vendor_invoice_no || '', expense_ref: e.expense_no || '', expense_date: e.expense_date || '',
      expense_type: e.expense_type || '', vendor: e.vendor_name || '', expense_total: e.total_amount ?? '', expense_status: e.status || '', note: tree.sharedNote(e) })
    for (const n of tree.list) {
      for (const lg of n.legs) for (const row of lg.invoices) {
        const b = base(n, lg, row)
        let any = false
        for (const c of row.challans) {
          const cb = { ...b, challan_no: c.challan_no, transporter: c.transporter, vehicles: c.vehicles.join(', ') }
          if (c.expenses.length === 0) rows.push({ ...cb, note: 'No expense on this challan' })
          for (const e of c.expenses) rows.push({ ...cb, ...exp(e, 'Challan') })
          any = true
        }
        for (const e of row.direct) { rows.push({ ...b, vehicles: row.loose.join(', '), ...exp(e, 'Invoice') }); any = true }
        if (!any) rows.push({ ...b, vehicles: row.loose.join(', '), note: 'No challan on this invoice' })
      }
      for (const e of n.other) rows.push({ ...base(n, null, null), ...exp(e, 'Order') })
    }
    if (rows.length) downloadCSV(`order_trail_${today()}.csv`, Object.keys(rows[0]), rows)
  }

  // ── Table rendering ─────────────────────────────────────────────────────────
  // One table, one header. Order rows open into leg rows, leg rows open into
  // detail lines (one line per invoice / challan / expense). Repeated invoice
  // and challan values are printed once per group so the lines read cleanly.
  const dateInput = { padding: '8px 10px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', fontFamily: 'inherit' }
  const th = { padding: '9px 10px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em', textAlign: 'left', whiteSpace: 'nowrap' }
  const td = { padding: '7px 10px', borderBottom: '1px solid #f0e8d8', fontSize: '12px', verticalAlign: 'top' }
  const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
  const COLS = 13

  if (loading) return <div style={{ textAlign: 'center', padding: '48px', color: C.textMuted, fontSize: '13px' }}>Loading…</div>
  if (error) return <div style={{ padding: '12px 14px', background: '#fbeaea', color: C.danger, borderRadius: '6px', fontSize: '13px' }}>Report could not be loaded: {error}</div>

  const orderOptions = [...data.orders.map(o => ({ value: o.id, label: o.name })), { value: NO_ORDER, label: 'No order linked' }]
  const t = tree.totals
  const legKeyOf = (n, lg) => `${n.id}|${lg.id}`
  const sumExp = list => { const seen = new Map(); for (const e of list) seen.set(e.id, Number(e.total_amount) || 0); return [...seen.values()].reduce((s, v) => s + v, 0) }

  // The 5 expense-side cells of a detail line
  const expenseCells = (e, via) => {
    if (!e) return <><td style={{ ...td, color: C.warning }}>{via || ''}</td><td style={td} /><td style={td} /><td style={{ ...td, ...num }} /><td style={td} /></>
    const note = tree.sharedNote(e)
    return (
      <>
        <td style={td}>
          <span style={{ fontWeight: 700 }}>{expLabel(e)}</span>
          {note && <span title={note} style={{ display: 'block', fontSize: '10px', color: C.danger, fontWeight: 600 }}>{note}</span>}
          {via && <span style={{ display: 'block', fontSize: '10px', color: C.textMuted }}>{via}</span>}
        </td>
        <td style={{ ...td, fontFamily: 'monospace', fontSize: '11px', color: C.textSoft, whiteSpace: 'nowrap' }}>{e.vendor_invoice_no ? (e.expense_no || '') : ''}</td>
        <td style={td}>{e.vendor_name || '—'}<span style={{ display: 'block', fontSize: '10px', color: C.textMuted }}>{e.expense_type || ''}{e.expense_date ? ` · ${fmtDate(e.expense_date)}` : ''}</span></td>
        <td style={{ ...td, ...num, fontWeight: 700 }}>{formatINR(e.total_amount)}</td>
        <td style={td}><span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', padding: '2px 6px', borderRadius: '4px', background: e.status === 'paid' ? '#e8f3ec' : '#fff3cc', color: e.status === 'paid' ? C.success : C.warning }}>{e.status || '—'}</span></td>
      </>
    )
  }
  const invoiceCells = (inv, show) => show ? (
    <>
      <td style={{ ...td, fontFamily: 'monospace', fontWeight: 700, whiteSpace: 'nowrap' }}>{inv.invoice_no || '—'}{inv.invoice_type === 'purchase' && <span style={{ display: 'block', fontFamily: 'inherit', fontSize: '10px', fontWeight: 500, color: C.textMuted }}>Purchase</span>}</td>
      <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(inv.invoice_date)}</td>
      <td style={{ ...td, whiteSpace: 'nowrap' }}>{entName(inv.seller)} → {entName(inv.buyer)}</td>
      <td style={{ ...td, ...num }}>{formatINR(inv.total_amount)}</td>
      <td style={{ ...td, whiteSpace: 'nowrap' }}>{inv.eway_bill_no || <span style={{ color: C.textMuted }}>—</span>}</td>
    </>
  ) : <><td style={td} /><td style={td} /><td style={td} /><td style={td} /><td style={td} /></>
  const challanCells = (c, show) => show && c ? (
    <>
      <td style={{ ...td, fontWeight: 700, whiteSpace: 'nowrap' }}>{c.challan_no}{c.transporter && <span style={{ display: 'block', fontSize: '10px', fontWeight: 500, color: C.textMuted }}>{c.transporter}</span>}</td>
      <td style={td}>{c.vehicles.join(', ') || '—'}</td>
    </>
  ) : <><td style={td} /><td style={td} /></>

  // Detail lines for one invoice
  const invoiceLines = (row, stripe) => {
    const { inv, challans, loose, direct } = row
    const lines = []
    let first = true
    const push = (key, challanPart, expensePart) => {
      lines.push(<tr key={key} style={{ background: stripe ? '#faf6ed' : C.surface }}><td style={td} />{invoiceCells(inv, first)}{challanPart}{expensePart}</tr>)
      first = false
    }
    for (const c of challans) {
      if (c.expenses.length === 0) push(`${inv.id}|${c.key}`, challanCells(c, true), expenseCells(null, 'No expense yet'))
      c.expenses.forEach((e, i) => push(`${inv.id}|${c.key}|${e.id}`, challanCells(c, i === 0), expenseCells(e)))
    }
    for (const e of direct) push(`${inv.id}|d|${e.id}`, <><td style={{ ...td, color: C.textMuted }}>—</td><td style={td}>{loose.join(', ')}</td></>, expenseCells(e, 'Tagged to the invoice'))
    if (lines.length === 0) push(`${inv.id}|none`, <><td style={{ ...td, color: C.textMuted }}>No challan</td><td style={td}>{loose.join(', ')}</td></>, expenseCells(null))
    return lines
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder='Search order, invoice, challan, vehicle, vendor invoice no…'
          style={{ ...dateInput, padding: '8px 12px', flex: 1, minWidth: '240px' }} />
        <MultiSelectDropdown options={orderOptions} selected={orderFilter} onChange={setOrderFilter} placeholder='All orders' capitalize={false} />
        <MultiSelectDropdown options={entities.map(e => ({ value: e.id, label: e.short_name || e.name }))} selected={entityFilter} onChange={setEntityFilter} placeholder='All entities' capitalize={false} title='Seller, buyer or paying entity' />
        <input type='date' value={dateFrom} onChange={e => setDateFrom(e.target.value)} title='Date from' style={dateInput} />
        <input type='date' value={dateTo} onChange={e => setDateTo(e.target.value)} title='Date to' style={dateInput} />
        {!!anyFilter && <Btn size='sm' variant='ghost' onClick={clearFilters}>Clear filters</Btn>}
        <Btn size='sm' variant='ghost' onClick={() => setOpen(new Set(tree.list.flatMap(n => [n.id, ...n.legs.map(lg => legKeyOf(n, lg)), `${n.id}|other`])))}>Expand all</Btn>
        <Btn size='sm' variant='ghost' onClick={() => setOpen(new Set())}>Collapse all</Btn>
        <Btn variant='ghost' onClick={handleExportCSV} disabled={tree.list.length === 0}>↓ Export CSV</Btn>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '12px' }}>
        <StatCard label='Orders' value={t.orders} />
        <StatCard label='Invoices' value={t.invoices} />
        <StatCard label='Challans' value={t.challans} sub={t.unbilled ? `${t.unbilled} with no expense yet` : 'All have an expense'} color={t.unbilled ? C.warning : C.success} />
        <StatCard label='Expenses linked' value={formatINR(t.expenseTotal)} sub={`${t.expenses} expense${t.expenses === 1 ? '' : 's'}, each counted once`} />
      </div>

      <Card>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>Order / Leg</th>
              <th style={th}>Invoice No</th>
              <th style={th}>Inv Date</th>
              <th style={th}>From → To</th>
              <th style={{ ...th, textAlign: 'right' }}>Invoice Amt</th>
              <th style={th}>E-way Bill</th>
              <th style={th}>Challan</th>
              <th style={th}>Vehicle</th>
              <th style={th}>Vendor Inv No</th>
              <th style={th}>Expense Ref</th>
              <th style={th}>Vendor</th>
              <th style={{ ...th, textAlign: 'right' }}>Expense Amt</th>
              <th style={th}>Status</th>
            </tr></thead>
            <tbody>
              {tree.list.length === 0 && <tr><td colSpan={COLS} style={{ padding: '32px', textAlign: 'center', color: C.textMuted, fontSize: '13px' }}>Nothing matches these filters.</td></tr>}
              {tree.list.map(n => {
                const rows = []
                // ── Order row ──
                rows.push(
                  <tr key={n.id} onClick={() => toggle(n.id)} style={{ cursor: 'pointer', background: '#efe7d6' }}>
                    <td style={{ ...td, fontSize: '13px', fontWeight: 700, whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-block', width: '14px', color: C.textSoft }}>{isOpen(n.id) ? '▾' : '▸'}</span>{n.name}
                      {n.description && <span style={{ display: 'block', paddingLeft: '14px', fontSize: '11px', fontWeight: 500, color: C.textSoft, whiteSpace: 'normal' }}>{n.description}</span>}
                    </td>
                    <td style={{ ...td, fontWeight: 600 }} colSpan={5}>{n.legs.length} leg{n.legs.length === 1 ? '' : 's'} · {n.invoiceCount} invoice{n.invoiceCount === 1 ? '' : 's'}</td>
                    <td style={{ ...td, fontWeight: 600 }} colSpan={2}>{n.challanKeys.size} challan{n.challanKeys.size === 1 ? '' : 's'}{n.unbilledKeys.size > 0 && <span style={{ color: C.warning }}> · {n.unbilledKeys.size} no expense</span>}</td>
                    <td style={{ ...td, fontWeight: 600 }} colSpan={3}>{n.shown.size} expense{n.shown.size === 1 ? '' : 's'}</td>
                    <td style={{ ...td, ...num, fontSize: '13px', fontWeight: 700 }}>{formatINR(n.expenseTotal)}</td>
                    <td style={td} />
                  </tr>
                )
                if (!isOpen(n.id)) return rows
                // ── Leg rows ──
                for (const lg of n.legs) {
                  const lk = legKeyOf(n, lg)
                  const legExpenses = lg.invoices.flatMap(r => [...r.challans.flatMap(c => c.expenses), ...r.direct])
                  const legChallans = new Set(lg.invoices.flatMap(r => r.challans.map(c => c.key)))
                  rows.push(
                    <tr key={lk} onClick={() => toggle(lk)} style={{ cursor: 'pointer', background: '#f7f1e3' }}>
                      <td style={{ ...td, fontWeight: 700, paddingLeft: '28px', whiteSpace: 'nowrap' }}>
                        <span style={{ display: 'inline-block', width: '14px', color: C.textSoft }}>{isOpen(lk) ? '▾' : '▸'}</span>
                        {lg.leg ? `Leg ${lg.leg.leg_no}` : 'No leg linked'}
                      </td>
                      <td style={{ ...td, fontWeight: 600 }} colSpan={2}>{lg.invoices.length} invoice{lg.invoices.length === 1 ? '' : 's'}</td>
                      <td style={{ ...td, fontWeight: 600, whiteSpace: 'nowrap' }} colSpan={3}>{lg.leg ? `${entName(lg.leg.from_entity)} → ${entName(lg.leg.to_entity)}` : ''}</td>
                      <td style={{ ...td, fontWeight: 600 }} colSpan={2}>{legChallans.size} challan{legChallans.size === 1 ? '' : 's'}</td>
                      <td style={td} colSpan={3} />
                      <td style={{ ...td, ...num, fontWeight: 700 }}>{formatINR(sumExp(legExpenses))}</td>
                      <td style={td} />
                    </tr>
                  )
                  if (isOpen(lk)) lg.invoices.forEach((row, i) => rows.push(...invoiceLines(row, i % 2 === 1)))
                }
                // ── Expenses tagged to the order only ──
                if (n.other.length > 0) {
                  const ok = `${n.id}|other`
                  rows.push(
                    <tr key={ok} onClick={() => toggle(ok)} style={{ cursor: 'pointer', background: '#f7f1e3' }}>
                      <td style={{ ...td, fontWeight: 700, paddingLeft: '28px', whiteSpace: 'nowrap' }} colSpan={8}>
                        <span style={{ display: 'inline-block', width: '14px', color: C.textSoft }}>{isOpen(ok) ? '▾' : '▸'}</span>Other expenses on this order
                      </td>
                      <td style={td} colSpan={3} />
                      <td style={{ ...td, ...num, fontWeight: 700 }}>{formatINR(sumExp(n.other))}</td>
                      <td style={td} />
                    </tr>
                  )
                  if (isOpen(ok)) n.other.forEach(e => rows.push(
                    <tr key={`${ok}|${e.id}`} style={{ background: C.surface }}><td style={td} colSpan={8} />{expenseCells(e, 'Tagged to the order')}</tr>
                  ))
                }
                return rows
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
