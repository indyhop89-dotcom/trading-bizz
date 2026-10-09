// Tally-style ledger statement — totals, print / PDF and Excel export.
// The on-screen table lives in pages/Reports/TallyLedger.jsx; all three are
// driven by the same ledger object so they always agree.
//
// A ledger = { title, account, period, opening, rows }
//   opening  signed number: + = Debit balance, − = Credit balance
//   rows     [{ date, particulars, note?, vchType, vchNo, dr, cr }]
import { fmtDate, today } from './dates'

const n = v => Number(v) || 0

export function ledgerTotals(ledger) {
  const totalDr = ledger.rows.reduce((s, r) => s + n(r.dr), 0)
  const totalCr = ledger.rows.reduce((s, r) => s + n(r.cr), 0)
  const opening = n(ledger.opening)
  return { opening, totalDr, totalCr, closing: opening + totalDr - totalCr }
}

// "To" marks a debit entry, "By" a credit entry — the Tally convention.
export const ledgerPrefix = r => (n(r.dr) > 0 ? 'To' : 'By')
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const money = v => (n(v) ? n(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '')

// ── Print / PDF ─────────────────────────────────────────────────────────────
// Opens the statement in a new window and brings up the print dialog, where
// "Save as PDF" gives the PDF — same technique as the invoice print.
export function printLedger(ledger) {
  const t = ledgerTotals(ledger)
  const body = ledger.rows.map(r => `<tr>
      <td>${esc(fmtDate(r.date))}</td>
      <td><span class="tb">${ledgerPrefix(r)}</span> ${esc(r.particulars || '')}${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}</td>
      <td>${esc(r.vchType || '')}</td><td>${esc(r.vchNo || '')}</td>
      <td class="num">${money(r.dr)}</td><td class="num">${money(r.cr)}</td></tr>`).join('')
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(ledger.account)} — Ledger</title><style>
    @page { size: A4; margin: 12mm; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #000; margin: 0; }
    h1 { font-size: 15px; text-align: center; margin: 0; } .sub { text-align: center; margin: 2px 0; }
    .acct { text-align: center; font-size: 13px; font-weight: bold; margin-top: 10px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th { border-top: 1px solid #000; border-bottom: 1px solid #000; padding: 5px 6px; text-align: left; font-size: 11px; }
    td { padding: 4px 6px; vertical-align: top; } .num { text-align: right; white-space: nowrap; } th.num { text-align: right; }
    .tb { display: inline-block; width: 20px; font-weight: bold; } .note { padding-left: 24px; font-size: 10px; color: #444; }
    .ob td { font-weight: bold; } .tot td { border-top: 1px solid #000; font-weight: bold; }
    .cb td { font-weight: bold; } .grand td { border-top: 1px solid #000; border-bottom: 3px double #000; font-weight: bold; }
  </style></head><body>
    <h1>${esc(ledger.title)}</h1>
    <div class="acct">${esc(ledger.account)}</div><div class="sub">Ledger Account</div><div class="sub">${esc(ledger.period)}</div>
    <table><thead><tr><th>Date</th><th>Particulars</th><th>Vch Type</th><th>Vch No.</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
    <tbody>
      <tr class="ob"><td></td><td>Opening Balance</td><td></td><td></td><td class="num">${t.opening > 0 ? money(t.opening) : ''}</td><td class="num">${t.opening < 0 ? money(-t.opening) : ''}</td></tr>
      ${body}
      <tr class="tot"><td></td><td>Current Total</td><td></td><td></td><td class="num">${money(t.totalDr) || '0.00'}</td><td class="num">${money(t.totalCr) || '0.00'}</td></tr>
      <tr class="cb"><td></td><td>Closing Balance</td><td></td><td></td><td class="num">${t.closing >= 0 ? `${money(t.closing) || '0.00'} Dr` : ''}</td><td class="num">${t.closing < 0 ? `${money(-t.closing)} Cr` : ''}</td></tr>
    </tbody></table>
  </body></html>`
  const win = window.open('', '_blank', 'width=900,height=700')
  if (!win) throw new Error("Could not open the print window — check your browser's popup blocker")
  win.document.write(html)
  win.document.close()
  let printed = false
  const doPrint = () => { if (printed) return; printed = true; try { win.focus(); win.print() } catch { /* window already closed */ } }
  win.onload = doPrint
  setTimeout(doPrint, 600)
}

// ── Excel ───────────────────────────────────────────────────────────────────
// Excel-2003 XML workbook (opens directly in Excel, amounts stay numeric) —
// same approach as the invoice Excel export, no library needed.
export function downloadLedgerExcel(ledger) {
  const t = ledgerTotals(ledger)
  const S = v => `<Cell><Data ss:Type="String">${esc(v)}</Data></Cell>`
  const B = v => `<Cell ss:StyleID="b"><Data ss:Type="String">${esc(v)}</Data></Cell>`
  const N = (v, style = 'n') => (n(v) ? `<Cell ss:StyleID="${style}"><Data ss:Type="Number">${n(v).toFixed(2)}</Data></Cell>` : '<Cell/>')
  const row = cells => `<Row>${cells.join('')}</Row>`
  const lines = [
    row([B(ledger.title)]), row([B(ledger.account)]), row([S('Ledger Account')]), row([S(ledger.period)]), row([]),
    row(['Date', 'Particulars', 'Vch Type', 'Vch No.', 'Debit', 'Credit'].map(B)),
    row([S(''), B('Opening Balance'), S(''), S(''), N(t.opening > 0 ? t.opening : 0, 'nb'), N(t.opening < 0 ? -t.opening : 0, 'nb')]),
    ...ledger.rows.map(r => row([S(fmtDate(r.date)), S(`${ledgerPrefix(r)} ${r.particulars || ''}${r.note ? ` (${r.note})` : ''}`), S(r.vchType || ''), S(r.vchNo || ''), N(r.dr), N(r.cr)])),
    row([S(''), B('Current Total'), S(''), S(''), N(t.totalDr, 'nb'), N(t.totalCr, 'nb')]),
    row([S(''), B(`Closing Balance (${t.closing >= 0 ? 'Dr' : 'Cr'})`), S(''), S(''), N(t.closing >= 0 ? t.closing : 0, 'nb'), N(t.closing < 0 ? -t.closing : 0, 'nb')]),
  ]
  const xml = `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="b"><Font ss:Bold="1"/></Style><Style ss:ID="n"><NumberFormat ss:Format="#,##0.00"/></Style><Style ss:ID="nb"><Font ss:Bold="1"/><NumberFormat ss:Format="#,##0.00"/></Style></Styles>
<Worksheet ss:Name="Ledger"><Table><Column ss:Width="70"/><Column ss:Width="260"/><Column ss:Width="90"/><Column ss:Width="120"/><Column ss:Width="90"/><Column ss:Width="90"/>
${lines.join('\n')}
</Table></Worksheet></Workbook>`
  const url = URL.createObjectURL(new Blob([xml], { type: 'application/vnd.ms-excel' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `ledger_${(ledger.account || 'statement').replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}_${today()}.xls`
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
