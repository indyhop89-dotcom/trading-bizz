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
