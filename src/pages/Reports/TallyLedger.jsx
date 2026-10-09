// ─── Tally-style ledger statement ───────────────────────────────────────────────
// One shared layout for the ledger reports (Ledger and Party Ledger), following
// the TallyPrime ledger format:
//
//   Date | Particulars | Vch Type | Vch No. | Debit | Credit
//
// with an Opening Balance line first, then the vouchers, then Current Total and
// Closing Balance (Dr/Cr). The same data drives the on-screen table, the
// print / PDF view and the Excel download, so the three always agree.
//
// A ledger = { title, account, period, opening, rows }
//   opening  signed number: + = Debit balance, − = Credit balance
//   rows     [{ date, particulars, note?, vchType, vchNo, dr, cr }]
import { C, Card, Btn } from '../../components/UI/index'
import { formatINR } from '../../utils/money'
import { fmtDate } from '../../utils/dates'
import { ledgerTotals, ledgerPrefix, printLedger, downloadLedgerExcel } from '../../utils/ledgerExport'

const n = v => Number(v) || 0

// Export buttons for a report's filter bar.
export function LedgerExportButtons({ ledger, onError }) {
  const run = fn => { try { fn(ledger) } catch (e) { onError?.(e.message) } }
  return (
    <>
      <Btn variant='ghost' onClick={() => run(printLedger)} disabled={!ledger}>↓ PDF / Print</Btn>
      <Btn variant='ghost' onClick={() => run(downloadLedgerExcel)} disabled={!ledger}>↓ Excel</Btn>
    </>
  )
}

// ── On-screen table ─────────────────────────────────────────────────────────
export default function TallyLedgerTable({ ledger }) {
  const t = ledgerTotals(ledger)
  const th = { padding: '9px 12px', background: C.bg, borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em', textAlign: 'left', whiteSpace: 'nowrap' }
  const td = { padding: '8px 12px', borderBottom: '1px solid #f0e8d8', fontSize: '13px', verticalAlign: 'top' }
  const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
  const strong = { ...td, fontWeight: 700, background: '#f0ebe0', borderBottom: `1px solid ${C.border}` }
  return (
    <Card>
      <div style={{ textAlign: 'center', padding: '14px 12px 10px' }}>
        <div style={{ fontSize: '15px', fontWeight: 700, color: C.text }}>{ledger.title}</div>
        <div style={{ fontSize: '14px', fontWeight: 700, color: C.text, marginTop: '6px' }}>{ledger.account}</div>
        <div style={{ fontSize: '12px', color: C.textSoft }}>Ledger Account</div>
        <div style={{ fontSize: '12px', color: C.textSoft }}>{ledger.period}</div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={th}>Date</th>
            <th style={th}>Particulars</th>
            <th style={th}>Vch Type</th>
            <th style={th}>Vch No.</th>
            <th style={{ ...th, textAlign: 'right' }}>Debit</th>
            <th style={{ ...th, textAlign: 'right' }}>Credit</th>
          </tr></thead>
          <tbody>
            <tr>
              <td style={strong} /><td style={strong} colSpan={3}>Opening Balance</td>
              <td style={{ ...strong, ...num }}>{t.opening > 0 ? formatINR(t.opening) : ''}</td>
              <td style={{ ...strong, ...num }}>{t.opening < 0 ? formatINR(-t.opening) : ''}</td>
            </tr>
            {ledger.rows.map((r, i) => (
              <tr key={i} style={{ background: i % 2 === 0 ? C.surface : '#faf6ed' }}>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(r.date)}</td>
                <td style={td}>
                  <span style={{ display: 'inline-block', width: '24px', fontWeight: 700, color: C.textSoft }}>{ledgerPrefix(r)}</span>{r.particulars || '—'}
                  {r.note && <span style={{ display: 'block', paddingLeft: '24px', fontSize: '11px', color: C.textMuted }}>{r.note}</span>}
                </td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.vchType}</td>
                <td style={{ ...td, fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'nowrap' }}>{r.vchNo || '—'}</td>
                <td style={{ ...td, ...num }}>{n(r.dr) > 0 ? formatINR(r.dr) : ''}</td>
                <td style={{ ...td, ...num }}>{n(r.cr) > 0 ? formatINR(r.cr) : ''}</td>
              </tr>
            ))}
            {ledger.rows.length === 0 && <tr><td colSpan={6} style={{ ...td, textAlign: 'center', color: C.textMuted, padding: '20px' }}>No vouchers in this period.</td></tr>}
            <tr>
              <td style={strong} /><td style={strong} colSpan={3}>Current Total</td>
              <td style={{ ...strong, ...num }}>{formatINR(t.totalDr)}</td>
              <td style={{ ...strong, ...num }}>{formatINR(t.totalCr)}</td>
            </tr>
            <tr>
              <td style={strong} /><td style={strong} colSpan={3}>Closing Balance</td>
              <td style={{ ...strong, ...num, fontSize: '14px' }}>{t.closing >= 0 ? `${formatINR(t.closing)} Dr` : ''}</td>
              <td style={{ ...strong, ...num, fontSize: '14px' }}>{t.closing < 0 ? `${formatINR(-t.closing)} Cr` : ''}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  )
}
