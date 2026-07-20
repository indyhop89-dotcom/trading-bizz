/**
 * Low-level helpers shared by every per-entity document template family
 * (documentTemplate.js's "vananam" family, srplDocumentTemplate.js's "srpl"
 * family, and any future one) — kept here rather than in documentTemplate.js
 * so a new template module can reuse them without importing back into the
 * file that dispatches to it.
 */
import { formatNumberIN, roundRupees } from './money'

export const ROWS_PER_PAGE_FIRST = 12
export const ROWS_PER_PAGE_NEXT = 18

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Every print/Excel cell must always show a number (never money.js's
// formatINR "—" fallback for null/NaN) — thin wrappers over the canonical
// money-display rules in money.js, not a reimplementation.
export function fmtN(n) {
  return formatNumberIN(n)
}

export function fmtInt(n) {
  return roundRupees(n).toLocaleString('en-IN')
}

// Indian numbering (Crore/Lakh/Thousand) amount-in-words, e.g. 125050 -> "One Lakh Twenty Five Thousand Fifty Rupees Only"
export function numWords(n) {
  n = Math.round(Number(n) || 0)
  if (n === 0) return 'Zero Rupees Only'
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
  function conv(x) {
    if (x < 20) return ones[x]
    if (x < 100) return tens[Math.floor(x / 10)] + (x % 10 ? ' ' + ones[x % 10] : '')
    return ones[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' + conv(x % 100) : '')
  }
  let s = '', cr = n
  if (cr >= 10000000) { s += conv(Math.floor(cr / 10000000)) + ' Crore '; cr %= 10000000 }
  if (cr >= 100000)   { s += conv(Math.floor(cr / 100000)) + ' Lakh ';   cr %= 100000 }
  if (cr >= 1000)     { s += conv(Math.floor(cr / 1000)) + ' Thousand '; cr %= 1000 }
  if (cr > 0)         s += conv(cr)
  return s.trim() + ' Rupees Only'
}

export function addressLines(entity) {
  if (!entity) return ''
  const line2 = [entity.city, entity.state_name, entity.pincode].filter(Boolean).join(', ')
  return [entity.address, line2].filter(Boolean).map(esc).join('<br>')
}

// Split lines into fixed-size pages up front — simplest thing that renders
// correctly across browsers, no reliance on CSS Paged Media support.
//
// capFirst/capNext default to the vananam family's row caps, tuned for its
// roomier layout (larger font, per-line CGST/SGST breakdown). A family with
// a visually denser table (e.g. SRPL's single-line 9px rows) should pass
// its own, larger caps — otherwise it breaks to a new page far earlier than
// its content actually requires, leaving each page mostly blank.
export function paginateLines(lines, capFirst = ROWS_PER_PAGE_FIRST, capNext = ROWS_PER_PAGE_NEXT) {
  const pages = []
  const remaining = [...lines]
  let pageNo = 1
  do {
    const cap = pageNo === 1 ? capFirst : capNext
    pages.push(remaining.splice(0, cap))
    pageNo++
  } while (remaining.length)
  return pages
}
