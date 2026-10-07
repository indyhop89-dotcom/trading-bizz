// Vehicle / transporter / challan rows for ONE invoice, edited in place.
// Used inside the invoice page's "E-way Bill & Challan" section. Each field
// saves on its own when you leave it — there is no Save button.
//
// InlineCell (exported) is the same save-on-blur input the Challans page uses.
import { useState, useEffect, useRef, useCallback } from 'react'
import { C, Btn } from './UI/index'
import {
  clean, fetchInvoiceVehicles, saveVehicleField, deleteVehicleRow, syncInvoiceTransport, saveErrorMessage,
} from '../utils/challans'

let tempSeq = 0
export function newVehicleRow(invoiceId) {
  tempSeq += 1
  return { _key: `new-${invoiceId}-${tempSeq}`, id: null, invoice_id: invoiceId, vehicle_no: '', challan_no: '', transporter_name: '' }
}

// A text input that keeps its own draft and calls onCommit(value) only when
// the value actually changed, on blur or Enter. Esc discards the draft.
// Enter also jumps to the same column in the next row (data-col), so a whole
// column of challan numbers can be typed top to bottom.
export function InlineCell({ value, onCommit, placeholder, upper, disabled, col, warnEmpty, width }) {
  const [draft, setDraft] = useState(value || '')
  const [focused, setFocused] = useState(false)
  useEffect(() => { if (!focused) setDraft(value || '') }, [value, focused])

  function commit() {
    setFocused(false)
    let v = clean(draft)
    if (upper) v = v.toUpperCase()
    setDraft(v)
    if (v !== clean(value)) onCommit(v)
  }
  function onKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      const el = e.currentTarget
      const all = col ? [...document.querySelectorAll(`input[data-col="${col}"]`)] : []
      const next = all[all.indexOf(el) + 1]
      if (next) next.focus(); else el.blur()
    } else if (e.key === 'Escape') {
      setDraft(value || ''); setFocused(false)
      const el = e.currentTarget
      setTimeout(() => el.blur(), 0)
    }
  }
  const empty = !clean(draft)
  return (
    <input
      value={draft}
      data-col={col}
      disabled={disabled}
      placeholder={placeholder}
      onChange={e => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => { if (focused) commit() }}
      onKeyDown={onKeyDown}
      className='tb-input'
      style={{
        padding: '5px 8px', fontSize: '13px', fontFamily: 'inherit', outline: 'none',
        width: width || '100%', minWidth: '90px', boxSizing: 'border-box',
        border: `1.5px solid ${warnEmpty && empty && !disabled ? C.warning : C.border}`,
        borderRadius: '5px',
        background: disabled ? C.bg : (warnEmpty && empty ? C.warningLight : C.surfaceRaised),
        color: C.text,
      }}
    />
  )
}

export default function InvoiceVehicles({ invoiceId, locked, onMirror, onToast }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  // Saves run one after another, always against the latest rows — so tabbing
  // quickly across a brand-new row can never insert it twice.
  const rowsRef = useRef([])
  const queue = useRef(Promise.resolve())

  // An unlocked invoice always has at least one row to type into; a row with
  // no id is a blank that has not been saved yet.
  function apply(next) {
    const list = next.length || locked ? next : [newVehicleRow(invoiceId)]
    rowsRef.current = list; setRows(list)
  }

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error } = await fetchInvoiceVehicles(invoiceId)
    if (error) { setLoadError(error.message); setLoading(false); return }
    setLoadError('')
    apply((data || []).map(r => ({ ...r, _key: r.id })))
    setLoading(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId, locked])
  useEffect(() => { load() }, [load])

  function enqueue(fn) { queue.current = queue.current.then(fn, fn) }

  async function pushMirror(next) {
    const { mirror, error } = await syncInvoiceTransport(invoiceId, next.filter(r => r.id))
    if (error) onToast?.({ message: `Saved, but the invoice summary did not update: ${error.message}`, type: 'error' })
    else onMirror?.(mirror)
  }

  function commit(key, field, value) {
    enqueue(async () => {
      const row = rowsRef.current.find(r => r._key === key)
      if (!row || clean(row[field]) === clean(value)) return
      const { data, error } = await saveVehicleField(invoiceId, row, field, value)
      if (error) return onToast?.({ message: saveErrorMessage(error), type: 'error' })
      if (!data) return
      const next = rowsRef.current.map(r => r._key === key ? { ...data, _key: key } : r)
      apply(next)
      await pushMirror(next)
    })
  }

  function remove(key) {
    enqueue(async () => {
      const row = rowsRef.current.find(r => r._key === key)
      if (!row) return
      if (row.id) {
        const { error } = await deleteVehicleRow(row.id)
        if (error) return onToast?.({ message: error.message, type: 'error' })
      }
      const next = rowsRef.current.filter(r => r._key !== key)
      apply(next)
      if (row.id) await pushMirror(next)
    })
  }

  if (loading) return <div style={{ padding: '10px 14px', fontSize: '12px', color: C.textMuted, borderTop: `1px solid ${C.border}` }}>Loading vehicles…</div>
  if (loadError) return (
    <div style={{ padding: '10px 14px', fontSize: '12px', color: C.danger, borderTop: `1px solid ${C.border}` }}>
      Could not load vehicles: {loadError}
    </div>
  )

  const shown = locked ? rows.filter(r => r.id) : rows

  const th = { padding: '6px 14px', textAlign: 'left', fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.05em' }
  const td = { padding: '5px 14px', fontSize: '13px' }

  return (
    <div style={{ borderTop: `1px solid ${C.border}` }}>
      {shown.length === 0 ? (
        <div style={{ padding: '10px 14px', fontSize: '12px', color: C.textMuted }}>No vehicle or challan details entered.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr><th style={th}>Vehicle No</th><th style={th}>Transporter</th><th style={th}>Challan No</th><th style={th} /></tr>
          </thead>
          <tbody>
            {shown.map(r => (
              <tr key={r._key}>
                {locked ? (<>
                  <td style={td}>{r.vehicle_no || '—'}</td>
                  <td style={td}>{r.transporter_name || '—'}</td>
                  <td style={td}><strong>{r.challan_no || '—'}</strong></td>
                  <td style={td} />
                </>) : (<>
                  <td style={td}><InlineCell value={r.vehicle_no} upper placeholder='e.g. KA01AB1234' onCommit={v => commit(r._key, 'vehicle_no', v)} /></td>
                  <td style={td}><InlineCell value={r.transporter_name} placeholder='Transporter name' onCommit={v => commit(r._key, 'transporter_name', v)} /></td>
                  <td style={td}><InlineCell value={r.challan_no} placeholder='Transporter challan number' onCommit={v => commit(r._key, 'challan_no', v)} /></td>
                  <td style={{ ...td, width: '1%', whiteSpace: 'nowrap' }}>
                    {(r.id || rows.length > 1) && (
                      <button type='button' title='Remove this vehicle' onClick={() => remove(r._key)}
                        style={{ background: 'none', border: 'none', color: C.danger, cursor: 'pointer', fontSize: '15px', lineHeight: 1, padding: '2px 6px' }}>×</button>
                    )}
                  </td>
                </>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!locked && (
        <div style={{ padding: '6px 14px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
          <Btn size='sm' variant='ghost' onClick={() => apply([...rowsRef.current, newVehicleRow(invoiceId)])}>+ Add vehicle</Btn>
          <span style={{ fontSize: '11px', color: C.textMuted }}>Each field saves when you leave it.</span>
        </div>
      )}
    </div>
  )
}
