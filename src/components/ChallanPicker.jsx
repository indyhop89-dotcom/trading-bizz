// Multi-select list of transporter challans for a freight expense.
// `groups` comes from groupChallans() (utils/challans.js): one entry per
// challan with the vehicles, invoices and orders it covers. `linkedByKey`
// maps a challan to the expenses it is already on — those stay selectable
// (advance + balance, freight + detention) but carry a warning.
import { useState } from 'react'
import { C } from './UI/index'

export default function ChallanPicker({ groups, selected, onChange, linkedByKey = {}, loading, error }) {
  const [q, setQ] = useState('')

  function toggle(key) {
    onChange(selected.includes(key) ? selected.filter(k => k !== key) : [...selected, key])
  }

  const needle = q.trim().toLowerCase()
  const shown = (groups || []).filter(g => !needle || selected.includes(g.key) ||
    [g.challan_no, g.transporter_name, ...g.vehicles, ...g.invoices.map(i => i.invoice_no), ...g.orders.map(o => o.name)]
      .some(x => (x || '').toLowerCase().includes(needle)))

  const box = { border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surfaceRaised }

  if (loading) return <div style={{ ...box, padding: '10px 12px', fontSize: '12px', color: C.textMuted }}>Loading challans…</div>
  if (error) return <div style={{ ...box, padding: '10px 12px', fontSize: '12px', color: C.danger }}>Could not load challans: {error}</div>
  if (!groups?.length) return (
    <div style={{ ...box, padding: '10px 12px', fontSize: '12px', color: C.textMuted }}>
      No challan numbers entered yet. Add them on the Challans page first.
    </div>
  )

  return (
    <div style={box}>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder='Search challan, vehicle, invoice, order…'
        style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: 'none', borderBottom: `1px solid ${C.border}`, background: 'transparent', fontSize: '13px', outline: 'none', fontFamily: 'inherit', color: C.text }} />
      <div style={{ maxHeight: '176px', overflowY: 'auto', padding: '4px' }}>
        {shown.length === 0 && <div style={{ padding: '8px', fontSize: '12px', color: C.textMuted }}>No challan matches.</div>}
        {shown.map(g => {
          const linked = linkedByKey[g.key]
          return (
            <label key={g.key} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '6px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '13px', background: selected.includes(g.key) ? C.accentLight : 'transparent' }}>
              <input type='checkbox' checked={selected.includes(g.key)} onChange={() => toggle(g.key)} style={{ marginTop: '3px', cursor: 'pointer' }} />
              <span style={{ minWidth: 0 }}>
                <strong>{g.challan_no}</strong>
                {g.transporter_name && <span style={{ color: C.textSoft }}> · {g.transporter_name}</span>}
                {g.vehicles.length > 0 && <span style={{ color: C.textSoft }}> · {g.vehicles.join(', ')}</span>}
                <span style={{ display: 'block', fontSize: '11px', color: C.textMuted }}>
                  {g.invoices.map(i => i.invoice_no || '(no number)').join(', ')}
                  {g.orders.length > 0 && <> · {g.orders.map(o => o.name).join(', ')}</>}
                </span>
                {linked && (
                  <span style={{ display: 'block', fontSize: '11px', color: C.warning, fontWeight: 600 }}>
                    ⚠ Already on {linked.join(', ')}
                  </span>
                )}
              </span>
            </label>
          )
        })}
      </div>
    </div>
  )
}
