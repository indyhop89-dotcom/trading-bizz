// Invoice → challans → challan details, in one popup.
//
// Opened by clicking an invoice number (Expenses list). First view lists the
// challans on that invoice; clicking a challan shows its details — vehicles,
// every invoice it covers and the freight expenses booked against it. The
// full invoice page is one click away from either view. Read-only.
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { C, Modal, Btn } from './UI/index'
import { fmtDate } from '../utils/dates'
import { formatINR } from '../utils/money'
import { challanKey, clean, fetchInvoiceVehicles, fetchExpenseChallanLinks } from '../utils/challans'

const entName = e => e?.short_name || e?.name || '—'
const th = { padding: '8px 10px', background: 'var(--bg)', borderBottom: '1px solid var(--border)', fontSize: '11px', fontWeight: 700, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.04em', textAlign: 'left' }
const td = { padding: '8px 10px', borderBottom: '1px solid var(--border)', fontSize: '12px', verticalAlign: 'top' }
const linkBtn = { background: 'none', border: 'none', padding: 0, color: 'var(--accent)', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', textAlign: 'left' }

export default function InvoiceChallansModal({ invoiceId, onClose }) {
  const [currentId, setCurrentId] = useState(invoiceId) // the invoice being shown (changes when you hop via a challan)
  const [inv, setInv]             = useState(null)
  const [challans, setChallans]   = useState([])
  const [loose, setLoose]         = useState([])        // vehicles with no challan number yet
  const [expByKey, setExpByKey]   = useState({})
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')
  const [challan, setChallan]     = useState(null)      // the challan opened for details
  const [covers, setCovers]       = useState(null)      // invoices that challan covers

  useEffect(() => { setCurrentId(invoiceId); setChallan(null) }, [invoiceId])

  useEffect(() => {
    if (!currentId) return
    let cancelled = false
    setLoading(true); setError('')
    Promise.all([
      supabase.from('invoices')
        .select('id,invoice_no,invoice_date,total_amount,eway_bill_no,seller:seller_entity_id(name,short_name),buyer:buyer_entity_id(name,short_name),orders(name,description)')
        .eq('id', currentId).single(),
      fetchInvoiceVehicles(currentId),
      fetchExpenseChallanLinks(),
    ]).then(([i, v, links]) => {
      if (cancelled) return
      if (i.error || v.error) { setError((i.error || v.error).message); setLoading(false); return }
      const groups = new Map(), noChallan = []
      for (const row of v.data || []) {
        const key = challanKey(row.challan_no, row.transporter_name)
        const veh = clean(row.vehicle_no)
        if (!key) { if (veh) noChallan.push(veh); continue }
        if (!groups.has(key)) groups.set(key, { key, challan_no: clean(row.challan_no), transporter: clean(row.transporter_name), vehicles: [], external: false, note: '' })
        if (row.is_external) { groups.get(key).external = true; groups.get(key).note = row.external_note || '' } // CHANGED: External challans
        if (veh && !groups.get(key).vehicles.includes(veh)) groups.get(key).vehicles.push(veh)
      }
      setInv(i.data); setChallans([...groups.values()]); setLoose(noChallan); setExpByKey(links.byKey || {})
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [currentId])

  // Every invoice the opened challan sits on (same number + same transporter).
  useEffect(() => {
    if (!challan) { setCovers(null); return }
    let cancelled = false
    setCovers(null)
    supabase.from('invoice_vehicles')
      .select('vehicle_no,challan_no,transporter_name,invoice:invoice_id(id,invoice_no,invoice_date,is_deleted,status)')
      .ilike('challan_no', challan.challan_no.replace(/[\\%_]/g, m => `\\${m}`))
      .then(({ data }) => {
        if (cancelled) return
        const seen = new Map(), vehicles = []
        for (const r of data || []) {
          if (challanKey(r.challan_no, r.transporter_name) !== challan.key) continue
          const veh = clean(r.vehicle_no)
          if (veh && !vehicles.includes(veh)) vehicles.push(veh)
          if (r.invoice && !r.invoice.is_deleted && r.invoice.status !== 'cancelled') seen.set(r.invoice.id, r.invoice)
        }
        setCovers({ invoices: [...seen.values()], vehicles })
      })
    return () => { cancelled = true }
  }, [challan])

  if (!invoiceId) return null
  const title = challan ? `Challan ${challan.challan_no}` : `Invoice ${inv?.invoice_no || ''}`
  const fact = (label, value) => (
    <div><div style={{ fontSize: '10px', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div><div style={{ fontSize: '13px' }}>{value || '—'}</div></div>
  )

  return (
    <Modal open onClose={onClose} title={title} width={680}>
      {loading ? <div style={{ padding: '32px', textAlign: 'center', color: C.textMuted, fontSize: '13px' }}>Loading…</div>
        : error ? <div style={{ padding: '16px', color: C.danger, fontSize: '13px' }}>Could not load: {error}</div>
        : challan ? (
          // ── Challan details ──
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px' }}>
              {fact('Challan No', challan.challan_no)}
              {fact('Transporter', challan.transporter)}
              {fact('Vehicles', (covers?.vehicles?.length ? covers.vehicles : challan.vehicles).join(', '))}
            </div>
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '6px' }}>Freight expense</div>
              <div style={{ fontSize: '13px', color: expByKey[challan.key] ? C.text : challan.external ? C.textSoft : C.warning }}>{expByKey[challan.key] ? expByKey[challan.key].join(', ') : challan.external ? `External — transport paid by another party${challan.note ? ` (${challan.note})` : ''}` : 'No expense recorded against this challan yet'}</div>
            </div>
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '6px' }}>Invoices on this challan</div>
              {covers === null ? <div style={{ fontSize: '12px', color: C.textMuted }}>Loading…</div> : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th style={th}>Invoice No</th><th style={th}>Date</th><th style={th} /></tr></thead>
                  <tbody>
                    {covers.invoices.map(i => (
                      <tr key={i.id}>
                        <td style={td}><button type='button' style={linkBtn} onClick={() => { setChallan(null); setCurrentId(i.id) }}>{i.invoice_no || '(no number)'}</button></td>
                        <td style={td}>{fmtDate(i.invoice_date)}</td>
                        <td style={{ ...td, textAlign: 'right' }}><Link to={`/invoices/${i.id}`} onClick={onClose} style={{ color: C.accent, fontSize: '12px', textDecoration: 'none' }}>Open invoice →</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Btn variant='ghost' onClick={() => setChallan(null)}>← Back to invoice {inv?.invoice_no || ''}</Btn>
              <Btn variant='ghost' onClick={onClose}>Close</Btn>
            </div>
          </div>
        ) : (
          // ── Challans on the invoice ──
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '12px' }}>
              {fact('Date', fmtDate(inv.invoice_date))}
              {fact('From → To', `${entName(inv.seller)} → ${entName(inv.buyer)}`)}
              {fact('Order', inv.orders?.name ? `${inv.orders.name}${inv.orders.description ? ` — ${inv.orders.description}` : ''}` : '')}
              {fact('Amount', formatINR(inv.total_amount))}
            </div>
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '6px' }}>Challans on this invoice</div>
              {challans.length === 0
                ? <div style={{ fontSize: '13px', color: C.textMuted }}>No challan on this invoice yet{loose.length ? ` · vehicle ${loose.join(', ')}` : ''}.</div>
                : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr><th style={th}>Challan No</th><th style={th}>Transporter</th><th style={th}>Vehicles</th><th style={th}>Freight Expense</th></tr></thead>
                    <tbody>
                      {challans.map(c => (
                        <tr key={c.key}>
                          <td style={td}><button type='button' style={linkBtn} title='View challan details' onClick={() => setChallan(c)}>{c.challan_no}</button></td>
                          <td style={td}>{c.transporter || '—'}</td>
                          <td style={td}>{c.vehicles.join(', ') || '—'}</td>
                          <td style={{ ...td, color: expByKey[c.key] ? C.text : c.external ? C.textSoft : C.warning }}>{expByKey[c.key] ? expByKey[c.key].join(', ') : c.external ? `External${c.note ? ` — ${c.note}` : ''}` : 'No expense yet'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Link to={`/invoices/${inv.id}`} onClick={onClose} style={{ color: C.accent, fontWeight: 600, fontSize: '13px', textDecoration: 'none' }}>Open full invoice →</Link>
              <Btn variant='ghost' onClick={onClose}>Close</Btn>
            </div>
          </div>
        )}
    </Modal>
  )
}
