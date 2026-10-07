// Challans — enter transporter challan numbers for every dispatched invoice
// from one screen instead of opening each invoice.
//
// One row per VEHICLE per invoice. Lists sales invoices whose E-way Bill is
// entered (goods have moved). Vehicle No, Transporter and Challan No are typed
// straight into the row and save when you leave the field; Enter jumps to the
// same column in the next row. Data lives in invoice_vehicles — see
// utils/challans.js and 057_invoice_vehicles_and_expense_challans.sql.
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { C, Btn, Card, PageHeader, StatCard, Toast, ConfirmModal, EmptyState, MultiSelectDropdown } from '../../components/UI/index'
import { supabase } from '../../supabaseClient'
import { InlineCell, newVehicleRow } from '../../components/InvoiceVehicles'
import { fmtDate } from '../../utils/dates'
import {
  clean, challanKey, fetchChallanBoard, fetchExpenseChallanLinks, groupChallans,
  saveVehicleField, deleteVehicleRow, syncInvoiceTransport, saveErrorMessage,
} from '../../utils/challans'

const entName = e => e?.short_name || e?.name || '—'

export default function Challans() {
  const [invoices, setInvoices] = useState([])
  const [expLinks, setExpLinks] = useState({})   // challan key → [expense numbers]
  const [loading, setLoading]   = useState(true)
  const [loadError, setLoadError] = useState('')
  const [search, setSearch]     = useState('')
  const [missingOnly, setMissingOnly] = useState(false)
  // CHANGED: From / To entity, Order and Leg filters (multi-select — an empty
  // array means "all") plus an invoice-date range, same as the Invoices list.
  const [fromFilter, setFromFilter]   = useState([])
  const [toFilter, setToFilter]       = useState([])
  const [orderFilter, setOrderFilter] = useState([])
  const [legFilter, setLegFilter]     = useState([])
  const [dateFrom, setDateFrom]       = useState('')
  const [dateTo, setDateTo]           = useState('')
  const [legs, setLegs]               = useState({})   // order_leg_id → leg_no
  const [toast, setToast]       = useState(null)
  const [confirmRemove, setConfirmRemove] = useState(null) // { invId, key, label }
  // Saves run one at a time against the latest data, so tabbing quickly across
  // a brand-new row can never insert it twice.
  const dataRef = useRef([])
  const queue   = useRef(Promise.resolve())

  function apply(next) { dataRef.current = next; setInvoices(next) }
  function enqueue(fn) { queue.current = queue.current.then(fn, fn) }

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data, error }, links] = await Promise.all([fetchChallanBoard(), fetchExpenseChallanLinks()])
    if (error) { setLoadError(error.message); setLoading(false); return }
    setLoadError('')
    apply(data.map(inv => ({
      ...inv,
      // Every invoice gets at least one row to type into.
      vehicles: inv.vehicles.length ? inv.vehicles.map(v => ({ ...v, _key: v.id })) : [newVehicleRow(inv.id)],
    })))
    setExpLinks(links.byKey)
    setLoading(false)
    // Leg numbers for the Leg filter and the label under each invoice. Loaded
    // separately and after the page shows, so a problem here can never stop
    // the challan list itself from loading.
    const legIds = [...new Set(data.map(i => i.order_leg_id).filter(Boolean))]
    const map = {}
    for (let i = 0; i < legIds.length; i += 200) {
      const { data: rows } = await supabase.from('order_legs').select('id,leg_no').in('id', legIds.slice(i, i + 200))
      for (const r of rows || []) map[r.id] = r.leg_no
    }
    setLegs(map)
  }, [])
  useEffect(() => { load() }, [load])

  function setVehicles(invId, fn) {
    apply(dataRef.current.map(inv => inv.id === invId ? { ...inv, vehicles: fn(inv.vehicles) } : inv))
  }
  async function pushMirror(invId) {
    const inv = dataRef.current.find(i => i.id === invId)
    const { error } = await syncInvoiceTransport(invId, (inv?.vehicles || []).filter(v => v.id))
    if (error) setToast({ message: `Saved, but the invoice summary did not update: ${error.message}`, type: 'error' })
  }

  function commit(invId, key, field, value) {
    enqueue(async () => {
      const row = dataRef.current.find(i => i.id === invId)?.vehicles.find(v => v._key === key)
      if (!row || clean(row[field]) === clean(value)) return
      const { data, error } = await saveVehicleField(invId, row, field, value)
      if (error) return setToast({ message: saveErrorMessage(error), type: 'error' })
      if (!data) return
      setVehicles(invId, vs => vs.map(v => v._key === key ? { ...data, _key: key } : v))
      await pushMirror(invId)
    })
  }

  function addVehicle(invId) { setVehicles(invId, vs => [...vs, newVehicleRow(invId)]) }

  function remove(invId, key) {
    enqueue(async () => {
      const row = dataRef.current.find(i => i.id === invId)?.vehicles.find(v => v._key === key)
      if (!row) return
      if (row.id) {
        const { error } = await deleteVehicleRow(row.id)
        if (error) return setToast({ message: error.message, type: 'error' })
      }
      setVehicles(invId, vs => { const rest = vs.filter(v => v._key !== key); return rest.length ? rest : [newVehicleRow(invId)] })
      if (row.id) await pushMirror(invId)
    })
  }
  function askRemove(inv, v) {
    // A blank, never-saved row has nothing to lose — drop it without asking.
    if (!v.id) return remove(inv.id, v._key)
    setConfirmRemove({ invId: inv.id, key: v._key, label: `${v.vehicle_no || 'this vehicle'}${v.challan_no ? ` (challan ${v.challan_no})` : ''} from ${inv.invoice_no || 'the invoice'}` })
  }

  // How many invoices each challan covers — shown beside a shared challan.
  const invoiceCountByKey = useMemo(() => {
    const m = {}
    for (const g of groupChallans(invoices)) m[g.key] = g.invoices.length
    return m
  }, [invoices])

  const allRows = useMemo(() => invoices.flatMap(inv =>
    inv.vehicles.map((v, i) => ({ inv, v, first: i === 0 }))), [invoices])

  // Filter options come from what is actually on the page, so no option ever leads to an empty list.
  const uniq = (pairs) => { const m = new Map(); for (const [value, label] of pairs) if (value && !m.has(value)) m.set(value, label); return [...m].map(([value, label]) => ({ value, label })).sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true })) }
  const legLabel = inv => `${inv.orders?.name || 'No order'} · Leg ${legs[inv.order_leg_id] ?? '?'}`
  const fromOptions  = uniq(invoices.map(i => [i.seller_entity_id, entName(i.seller)]))
  const toOptions    = uniq(invoices.map(i => [i.buyer_entity_id, entName(i.buyer)]))
  const orderOptions = uniq(invoices.map(i => [i.order_id, i.orders?.description ? `${i.orders.name} · ${i.orders.description}` : i.orders?.name]))
  // Picking orders narrows the Leg list to those orders' legs.
  const legOptions   = uniq(invoices.filter(i => i.order_leg_id && (orderFilter.length === 0 || orderFilter.includes(i.order_id))).map(i => [i.order_leg_id, legLabel(i)]))
  const anyFilter = fromFilter.length || toFilter.length || orderFilter.length || legFilter.length || dateFrom || dateTo
  function clearFilters() { setFromFilter([]); setToFilter([]); setOrderFilter([]); setLegFilter([]); setDateFrom(''); setDateTo('') }

  const q = search.trim().toLowerCase()
  const rows = allRows.filter(({ inv, v }) => {
    if (missingOnly && clean(v.challan_no)) return false
    if (fromFilter.length  && !fromFilter.includes(inv.seller_entity_id)) return false
    if (toFilter.length    && !toFilter.includes(inv.buyer_entity_id)) return false
    if (orderFilter.length && !orderFilter.includes(inv.order_id)) return false
    if (legFilter.length   && !legFilter.includes(inv.order_leg_id)) return false
    if (dateFrom && (inv.invoice_date || '') < dateFrom) return false
    if (dateTo   && (inv.invoice_date || '') > dateTo) return false
    if (!q) return true
    return [inv.invoice_no, inv.eway_bill_no, inv.seller?.name, inv.seller?.short_name, inv.buyer?.name, inv.buyer?.short_name,
      inv.orders?.name, v.vehicle_no, v.challan_no, v.transporter_name]
      .some(x => (x || '').toLowerCase().includes(q))
  })
  const missingCount = allRows.filter(({ v }) => !clean(v.challan_no)).length

  const th = {
    padding: '8px 10px', textAlign: 'left', fontSize: '11px', fontWeight: 700, color: '#9a8a6a',
    textTransform: 'uppercase', letterSpacing: '0.05em', background: C.bg, whiteSpace: 'nowrap',
    borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, position: 'sticky', top: 0, zIndex: 1,
  }
  const td = { padding: '6px 10px', borderBottom: `1px solid ${C.border}`, fontSize: '13px', verticalAlign: 'middle', color: C.text }

  return (
    <div>
      <PageHeader title='Challans' subtitle='Transporter challan numbers for dispatched invoices — type straight into the row'
        action={<Btn variant='ghost' onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</Btn>} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label='Invoices with E-way Bill' value={invoices.length.toLocaleString('en-IN')} />
        <StatCard label='Vehicles' value={allRows.length.toLocaleString('en-IN')} />
        <StatCard label='Challan missing' value={missingCount.toLocaleString('en-IN')} color={missingCount ? C.warning : C.success}
          sub={missingOnly ? 'Showing only these — click to show all' : 'Click to show only these'}
          onClick={() => setMissingOnly(m => !m)} />
      </div>

      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder='Search invoice, E-way Bill, entity, vehicle, challan…'
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', flex: 1, minWidth: '220px', fontFamily: 'inherit' }} />
        <MultiSelectDropdown options={fromOptions} selected={fromFilter} onChange={setFromFilter} placeholder='All From Entities' capitalize={false} title='From (seller)' />
        <MultiSelectDropdown options={toOptions} selected={toFilter} onChange={setToFilter} placeholder='All To Entities' capitalize={false} title='To (buyer)' />
        <MultiSelectDropdown options={orderOptions} selected={orderFilter} onChange={setOrderFilter} placeholder='All orders' capitalize={false} />
        <MultiSelectDropdown options={legOptions} selected={legFilter} onChange={setLegFilter} placeholder='All legs' capitalize={false} />
        <input type='date' value={dateFrom} onChange={e => setDateFrom(e.target.value)} title='Invoice date from'
          style={{ padding: '8px 10px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', fontFamily: 'inherit' }} />
        <input type='date' value={dateTo} onChange={e => setDateTo(e.target.value)} title='Invoice date to'
          style={{ padding: '8px 10px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', fontFamily: 'inherit' }} />
        {!!anyFilter && <Btn size='sm' variant='ghost' onClick={clearFilters}>Clear filters</Btn>}
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input type='checkbox' checked={missingOnly} onChange={e => setMissingOnly(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
          Challan missing only
        </label>
      </div>

      <Card>
        {loading ? (
          <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
        ) : loadError ? (
          <div style={{ padding: '32px', textAlign: 'center', color: C.danger, fontSize: '13px' }}>Could not load challans: {loadError}</div>
        ) : rows.length === 0 ? (
          <EmptyState icon='🚛' title={allRows.length ? 'Nothing matches' : 'No dispatched invoices yet'}
            message={allRows.length ? 'Clear the search or the filters above.' : 'Invoices appear here once their E-way Bill is entered.'} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Invoice No</th>
                  <th style={th}>Date</th>
                  <th style={th}>From</th>
                  <th style={th}>To</th>
                  <th style={th}>E-way Bill</th>
                  <th style={th}>Vehicle No</th>
                  <th style={th}>Transporter</th>
                  <th style={th}>Challan No</th>
                  <th style={th}>Freight Expense</th>
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ inv, v, first }) => {
                  const key = challanKey(v.challan_no, v.transporter_name)
                  const shared = key ? invoiceCountByKey[key] || 0 : 0
                  const exps = key ? expLinks[key] : null
                  return (
                    <tr key={v._key} style={{ background: C.surfaceRaised }}>
                      <td style={{ ...td, whiteSpace: 'nowrap', opacity: first ? 1 : 0.55 }}>
                        <Link to={`/invoices/${inv.id}`} style={{ color: C.accent, fontWeight: 600, textDecoration: 'none' }}>{inv.invoice_no || '(no number)'}</Link>
                        {inv.orders?.name && <div style={{ fontSize: '11px', color: C.textMuted }}>{inv.orders.name}{legs[inv.order_leg_id] != null ? ` · Leg ${legs[inv.order_leg_id]}` : ''}</div>}
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap', fontSize: '12px', opacity: first ? 1 : 0.55 }}>{fmtDate(inv.invoice_date)}</td>
                      <td style={{ ...td, fontSize: '12px', opacity: first ? 1 : 0.55 }}>{entName(inv.seller)}</td>
                      <td style={{ ...td, fontSize: '12px', opacity: first ? 1 : 0.55 }}>{entName(inv.buyer)}</td>
                      <td style={{ ...td, fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'nowrap', opacity: first ? 1 : 0.55 }}>{inv.eway_bill_no}</td>
                      <td style={td}><InlineCell col='vehicle_no' upper value={v.vehicle_no} placeholder='Vehicle no' onCommit={val => commit(inv.id, v._key, 'vehicle_no', val)} /></td>
                      <td style={td}><InlineCell col='transporter_name' value={v.transporter_name} placeholder='Transporter' onCommit={val => commit(inv.id, v._key, 'transporter_name', val)} /></td>
                      <td style={td}>
                        <InlineCell col='challan_no' warnEmpty value={v.challan_no} placeholder='Challan no' onCommit={val => commit(inv.id, v._key, 'challan_no', val)} />
                        {shared > 1 && <div style={{ fontSize: '11px', color: C.textMuted, marginTop: '2px' }}>Same challan on {shared} invoices</div>}
                      </td>
                      <td style={{ ...td, fontSize: '12px', fontFamily: exps ? 'monospace' : 'inherit', color: exps ? C.text : C.textMuted }}>{exps ? exps.join(', ') : '—'}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                        <button type='button' title='Add another vehicle to this invoice' onClick={() => addVehicle(inv.id)}
                          style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: '12px', fontFamily: 'inherit', padding: '2px 6px' }}>+ Vehicle</button>
                        {(v.id || inv.vehicles.length > 1) && (
                          <button type='button' title='Remove this vehicle' onClick={() => askRemove(inv, v)}
                            style={{ background: 'none', border: 'none', color: C.danger, cursor: 'pointer', fontSize: '15px', lineHeight: 1, padding: '2px 6px' }}>×</button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {!loading && !loadError && (
        <div style={{ fontSize: '11px', color: C.textMuted, marginTop: '8px' }}>
          Showing {rows.length.toLocaleString('en-IN')} of {allRows.length.toLocaleString('en-IN')} vehicle rows. Each field saves when you leave it; press Enter to move down the column.
        </div>
      )}

      <ConfirmModal open={!!confirmRemove} danger title='Remove Vehicle' confirmLabel='Remove'
        message={`Remove ${confirmRemove?.label || 'this vehicle'}? Its challan number goes with it.`}
        onClose={() => setConfirmRemove(null)}
        onConfirm={() => { const c = confirmRemove; setConfirmRemove(null); if (c) remove(c.invId, c.key) }} />

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}
