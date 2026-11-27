import { C, Input } from '../../components/UI/index'
import { formatNumberIN } from '../../utils/money'
import { fmtDate } from '../../utils/dates'

// Tick-and-amount list of pending invoices. Used by Add Payment (invoices to
// pay / sales to knock off) and the Journal tab (sales vs purchases).
//   list:  invoices with { id, invoice_no, invoice_date, _pending }
//   state: { [invoiceId]: { checked, amount, adjustments } }
const th = { padding: '9px 12px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '10px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', whiteSpace: 'nowrap' }
const td = { padding: '9px 12px', borderBottom: '1px solid #f0e8d8', fontSize: '12px', verticalAlign: 'middle' }
const smallInput = { padding: '5px 8px', fontSize: '12px', textAlign: 'right' }

export default function PickTable({ title, list, state, onChange, showAdj = false, emptyText = 'Nothing pending.' }) {
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: '6px', overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', background: C.bg, fontSize: '12px', fontWeight: 700, color: C.text }}>{title}</div>
      {list.length === 0 ? (
        <div style={{ padding: '12px', fontSize: '12px', color: C.textMuted }}>{emptyText}</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            {['', 'Invoice No', 'Date', 'Pending', 'Amount', ...(showAdj ? ['Adj.'] : [])].map((h, i) => (
              <th key={i} style={{ ...th, textAlign: i >= 3 ? 'right' : 'left' }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {list.map(i => {
              const s = state[i.id] || {}
              return (
                <tr key={i.id} style={{ background: s.checked ? '#fbf7ec' : C.surface }}>
                  <td style={{ ...td, width: '28px' }}>
                    <input type='checkbox' checked={!!s.checked} onChange={e => onChange(i.id, { checked: e.target.checked })} style={{ width: '15px', height: '15px', cursor: 'pointer' }} />
                  </td>
                  <td style={{ ...td, fontFamily: 'monospace', fontSize: '11px' }}>{i.invoice_no || '—'}</td>
                  <td style={td}>{fmtDate(i.invoice_date)}</td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>₹{formatNumberIN(i._pending)}</td>
                  <td style={{ ...td, textAlign: 'right', width: '130px' }}>
                    <Input type='number' value={s.amount ?? ''} disabled={!s.checked} onChange={e => onChange(i.id, { amount: e.target.value })} style={smallInput} />
                  </td>
                  {showAdj && (
                    <td style={{ ...td, textAlign: 'right', width: '100px' }}>
                      <Input type='number' value={s.adjustments ?? ''} disabled={!s.checked} onChange={e => onChange(i.id, { adjustments: e.target.value })} style={smallInput} />
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
