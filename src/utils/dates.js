// Financial year: April 1 to March 31
// FY 2024-25 → code "2425"

export function today() {
  return new Date().toISOString().slice(0, 10)
}

export function getFYCode(date) {
  const d = date ? new Date(date) : new Date()
  const year = d.getFullYear()
  const month = d.getMonth() + 1 // 1-12
  // April (4) onwards = new FY
  if (month >= 4) {
    return String(year).slice(2) + String(year + 1).slice(2)
  }
  return String(year - 1).slice(2) + String(year).slice(2)
}

export function getFYName(date) {
  const code = getFYCode(date)
  return `FY 20${code.slice(0, 2)}-${code.slice(2)}`
}

export function getFYDates(code) {
  // code = "2425"
  const startYear = 2000 + parseInt(code.slice(0, 2))
  return {
    start: `${startYear}-04-01`,
    end: `${startYear + 1}-03-31`,
  }
}

export function formatDate(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function formatDateShort(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
}

export function daysUntil(dateStr) {
  if (!dateStr) return null
  const diff = new Date(dateStr) - new Date()
  return Math.ceil(diff / (1000 * 60 * 60 * 24))
}

export function isOverdue(dateStr) {
  if (!dateStr) return false
  return new Date(dateStr) < new Date()
}
