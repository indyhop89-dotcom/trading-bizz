/** Format date string/Date to "15 Jun 2025" */
export function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

/** Format to YYYY-MM-DD for date inputs */
export function toInputDate(d) {
  if (!d) return ''
  return new Date(d).toISOString().split('T')[0]
}

/** Today as YYYY-MM-DD */
export function today() {
  return new Date().toISOString().split('T')[0]
}

/**
 * Parse a CSV date cell that may be YYYY-MM-DD (ISO, preferred) or DD-MM-YYYY
 * / DD/MM/YYYY (common when typed or copied from Excel in India). Returns
 * ISO YYYY-MM-DD, or null if the value is blank or doesn't match either shape.
 * Postgres's default DateStyle reads unquoted "15-06-2026" as MDY and throws
 * "date/time field value out of range" the moment the day exceeds 12 — this
 * normalizes on the JS side before the value ever reaches the DB.
 */
export function parseFlexibleDate(raw) {
  const s = (raw || '').trim()
  if (!s) return null
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return s
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/)
  if (dmy) {
    const [, d, m, y] = dmy
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  return null
}

/** Current financial year label e.g. "FY 2025-26" */
export function currentFYLabel() {
  const now = new Date()
  const m = now.getMonth() // 0-indexed
  const y = now.getFullYear()
  const start = m >= 3 ? y : y - 1
  return `FY ${start}-${String(start + 1).slice(2)}`
}

/** FY code for doc numbering e.g. "2526" for FY 2025-26 */
export function currentFYCode() {
  const now = new Date()
  const m = now.getMonth()
  const y = now.getFullYear()
  const start = m >= 3 ? y : y - 1
  return `${String(start).slice(2)}${String(start + 1).slice(2)}`
}

/**
 * CHANGED: FY code for a specific date (e.g. a PI/PO/Invoice's own date),
 * not always "today" — a backdated document should get the FY it actually
 * falls in. Accepts 'YYYY-MM-DD' or a Date. Indian FY: Apr 1 – Mar 31.
 */
export function fyCodeForDate(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput)
  const m = d.getMonth() // 0-indexed; 3 = April
  const y = d.getFullYear()
  const start = m >= 3 ? y : y - 1
  return `${String(start).slice(2)}${String(start + 1).slice(2)}`
}

/** List of FY options for selects */
export function fyOptions(count = 3) {
  const now = new Date()
  const m = now.getMonth()
  const y = now.getFullYear()
  const currentStart = m >= 3 ? y : y - 1
  return Array.from({ length: count }, (_, i) => {
    const s = currentStart - i
    const e = s + 1
    return {
      label: `FY ${s}-${String(e).slice(2)}`,
      start: `${s}-04-01`,
      end:   `${e}-03-31`,
      code:  `${String(s).slice(2)}${String(e).slice(2)}`,
    }
  })
}
