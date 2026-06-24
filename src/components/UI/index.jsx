import { useEffect } from 'react'

// ─── design tokens ────────────────────────────────────────────────────────────
export const C = {
  bg:          '#f5f0e8',
  surface:     '#fffdf6',
  border:      '#e8dfc8',
  borderDark:  '#d4c9a8',
  text:        '#1a1208',
  textMid:     '#4a3a1a',
  textSoft:    '#7a6a4a',
  textMuted:   '#9a8a6a',
  accent:      '#1a1208',
  accentHover: '#2e2010',
  danger:      '#8a2020',
  success:     '#1a5c30',
  warning:     '#7a5000',
  info:        '#1a4a6a',
}

// ─── Spinner ──────────────────────────────────────────────────────────────────
export function Spinner({ size = 20 }) {
  return (
    <div style={{
      width: size, height: size,
      border: `2px solid ${C.border}`,
      borderTop: `2px solid ${C.accent}`,
      borderRadius: '50%',
      animation: 'spin 0.7s linear infinite',
      display: 'inline-block',
    }} />
  )
}

// ─── Badge ────────────────────────────────────────────────────────────────────
const BADGE_COLORS = {
  draft:      { bg: '#f0ebe0', text: '#7a6a4a' },
  submitted:  { bg: '#e8f0f3', text: '#1a4a6a' },
  sent:       { bg: '#e8f0f3', text: '#1a4a6a' },
  accepted:   { bg: '#e8f3ec', text: '#1a5c30' },
  converted:  { bg: '#e8f3ec', text: '#1a5c30' },
  paid:       { bg: '#e8f3ec', text: '#1a5c30' },
  partial:    { bg: '#f3ede8', text: '#7a3a10' },
  open:       { bg: '#e8f0f3', text: '#1a4a6a' },
  completed:  { bg: '#e8f3ec', text: '#1a5c30' },
  cancelled:  { bg: '#f0e8e8', text: '#8a2020' },
  active:     { bg: '#e8f3ec', text: '#1a5c30' },
  overdue:    { bg: '#f0e8e8', text: '#8a2020' },
  pending:    { bg: '#f3ede8', text: '#7a3a10' },
  group:      { bg: '#ede8f3', text: '#3a1a6a' },
  associate:  { bg: '#e8f0f3', text: '#1a4a6a' },
  external:   { bg: '#f0ebe0', text: '#7a6a4a' },
  domestic:   { bg: '#e8f3ec', text: '#1a5c30' },
  export:     { bg: '#ede8f3', text: '#3a1a6a' },
  blended:    { bg: '#f3ede8', text: '#7a3a10' },
  receipt:    { bg: '#e8f3ec', text: '#1a5c30' },
  payment:    { bg: '#f3ede8', text: '#7a3a10' },
  'in_progress': { bg: '#e8f0f3', text: '#1a4a6a' },
}

export function Badge({ status, label }) {
  const c = BADGE_COLORS[status?.toLowerCase()] || { bg: '#f0ebe0', text: '#7a6a4a' }
  return (
    <span style={{
      background: c.bg, color: c.text,
      fontSize: '11px', fontWeight: 600,
      padding: '2px 8px', borderRadius: '4px',
      textTransform: 'capitalize', letterSpacing: '0.02em',
      whiteSpace: 'nowrap',
    }}>
      {label || status?.replace(/_/g, ' ')}
    </span>
  )
}

// ─── Modal ────────────────────────────────────────────────────────────────────
export function Modal({ open, onClose, title, width = 640, children }) {
  useEffect(() => {
    if (!open) return
    const handler = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(26,18,8,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: '16px',
      }}
    >
      <div style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: '12px',
        width: '100%', maxWidth: width,
        maxHeight: '90vh', overflow: 'auto',
        boxShadow: '0 20px 60px rgba(26,18,8,0.25)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: `1px solid ${C.border}`,
          position: 'sticky', top: 0, background: C.surface, zIndex: 1,
        }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: C.text }}>{title}</div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: '18px', color: C.textSoft, lineHeight: 1, padding: '2px 6px',
          }}>×</button>
        </div>
        <div style={{ padding: '20px' }}>{children}</div>
      </div>
    </div>
  )
}

// ─── ConfirmModal ─────────────────────────────────────────────────────────────
export function ConfirmModal({ open, onClose, onConfirm, title, message, danger = false }) {
  return (
    <Modal open={open} onClose={onClose} title={title || 'Confirm'} width={420}>
      <p style={{ color: C.textMid, fontSize: '14px', marginBottom: '20px', lineHeight: 1.5 }}>
        {message}
      </p>
      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
        <Btn variant='ghost' onClick={onClose}>Cancel</Btn>
        <Btn variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>Confirm</Btn>
      </div>
    </Modal>
  )
}

// ─── Toast ────────────────────────────────────────────────────────────────────
export function Toast({ message, type = 'success', onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3500)
    return () => clearTimeout(t)
  }, [onClose])

  const colors = {
    success: { bg: '#e8f3ec', text: '#1a5c30', border: '#b8dfc8' },
    error:   { bg: '#f0e8e8', text: '#8a2020', border: '#dfb8b8' },
    info:    { bg: '#e8f0f3', text: '#1a4a6a', border: '#b8d0df' },
  }
  const c = colors[type] || colors.info

  return (
    <div style={{
      position: 'fixed', bottom: '24px', right: '24px',
      background: c.bg, color: c.text,
      border: `1px solid ${c.border}`,
      padding: '12px 18px', borderRadius: '8px',
      fontSize: '13px', fontWeight: 600,
      boxShadow: '0 4px 20px rgba(26,18,8,0.15)',
      zIndex: 2000, maxWidth: '360px',
      display: 'flex', alignItems: 'center', gap: '10px',
    }}>
      <span style={{ flex: 1 }}>{message}</span>
      <button onClick={onClose} style={{
        background: 'none', border: 'none', cursor: 'pointer',
        color: c.text, fontSize: '16px', padding: 0, opacity: 0.6,
      }}>×</button>
    </div>
  )
}

// ─── EmptyState ───────────────────────────────────────────────────────────────
export function EmptyState({ icon = '📋', title, message, action }) {
  return (
    <div style={{
      textAlign: 'center', padding: '64px 24px',
      color: C.textMuted,
    }}>
      <div style={{ fontSize: '40px', marginBottom: '12px', opacity: 0.5 }}>{icon}</div>
      <div style={{ fontSize: '15px', fontWeight: 700, color: C.textMid, marginBottom: '6px' }}>{title}</div>
      {message && <div style={{ fontSize: '13px', lineHeight: 1.6, marginBottom: action ? '16px' : 0 }}>{message}</div>}
      {action}
    </div>
  )
}

// ─── Btn ──────────────────────────────────────────────────────────────────────
export function Btn({ children, onClick, variant = 'primary', size = 'md', disabled, type = 'button', style: extraStyle }) {
  const base = {
    border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit', fontWeight: 600, letterSpacing: '0.02em',
    borderRadius: '6px', transition: 'opacity 0.15s',
    opacity: disabled ? 0.45 : 1,
    display: 'inline-flex', alignItems: 'center', gap: '6px',
  }
  const sizes = {
    sm: { padding: '5px 12px', fontSize: '12px' },
    md: { padding: '8px 16px', fontSize: '13px' },
    lg: { padding: '10px 22px', fontSize: '14px' },
  }
  const variants = {
    primary: { background: C.accent,   color: '#f5f0e8' },
    ghost:   { background: 'transparent', color: C.textMid, border: `1px solid ${C.borderDark}` },
    danger:  { background: '#8a2020',  color: '#fff5f5' },
    success: { background: '#1a5c30',  color: '#f0fff5' },
  }
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      style={{ ...base, ...sizes[size], ...variants[variant], ...extraStyle }}
    >
      {children}
    </button>
  )
}

// ─── FormRow ──────────────────────────────────────────────────────────────────
export function FormRow({ label, required, children, hint, error, cols = 1 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {label && (
        <label style={{
          fontSize: '11px', fontWeight: 700, color: C.textSoft,
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          {label}{required && <span style={{ color: C.danger }}> *</span>}
        </label>
      )}
      {children}
      {hint && !error && <div style={{ fontSize: '11px', color: C.textMuted }}>{hint}</div>}
      {error && <div style={{ fontSize: '11px', color: C.danger }}>{error}</div>}
    </div>
  )
}

// ─── Input ────────────────────────────────────────────────────────────────────
export function Input({ value, onChange, placeholder, type = 'text', disabled, readOnly, style: extra }) {
  return (
    <input
      type={type}
      value={value ?? ''}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      style={{
        padding: '8px 11px',
        border: `1.5px solid ${C.border}`,
        borderRadius: '6px',
        background: disabled || readOnly ? C.bg : C.surface,
        color: C.text, fontSize: '13px',
        width: '100%', boxSizing: 'border-box',
        outline: 'none', fontFamily: 'inherit',
        ...extra,
      }}
    />
  )
}

// ─── Select ───────────────────────────────────────────────────────────────────
export function Select({ value, onChange, children, disabled, style: extra }) {
  return (
    <select
      value={value ?? ''}
      onChange={onChange}
      disabled={disabled}
      style={{
        padding: '8px 11px',
        border: `1.5px solid ${C.border}`,
        borderRadius: '6px',
        background: disabled ? C.bg : C.surface,
        color: C.text, fontSize: '13px',
        width: '100%', boxSizing: 'border-box',
        outline: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'inherit',
        ...extra,
      }}
    >
      {children}
    </select>
  )
}

// ─── Textarea ─────────────────────────────────────────────────────────────────
export function Textarea({ value, onChange, placeholder, rows = 3, disabled }) {
  return (
    <textarea
      value={value ?? ''}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      rows={rows}
      style={{
        padding: '8px 11px',
        border: `1.5px solid ${C.border}`,
        borderRadius: '6px',
        background: disabled ? C.bg : C.surface,
        color: C.text, fontSize: '13px',
        width: '100%', boxSizing: 'border-box',
        outline: 'none', fontFamily: 'inherit',
        resize: 'vertical',
      }}
    />
  )
}

// ─── PageHeader ───────────────────────────────────────────────────────────────
export function PageHeader({ title, subtitle, action }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      marginBottom: '24px', gap: '16px',
    }}>
      <div>
        <h1 style={{ fontSize: '20px', fontWeight: 700, color: C.text, margin: 0 }}>{title}</h1>
        {subtitle && <p style={{ fontSize: '13px', color: C.textMuted, margin: '4px 0 0' }}>{subtitle}</p>}
      </div>
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
    </div>
  )
}

// ─── Card ─────────────────────────────────────────────────────────────────────
export function Card({ children, style: extra }) {
  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: '10px',
      overflow: 'hidden',
      ...extra,
    }}>
      {children}
    </div>
  )
}

// ─── Table ────────────────────────────────────────────────────────────────────
export function Table({ columns, rows, onRowClick, emptyState }) {
  if (!rows || rows.length === 0) {
    return emptyState || <EmptyState title='No records found' />
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr>
            {columns.map((col, i) => (
              <th key={i} style={{
                padding: '10px 14px', textAlign: col.right ? 'right' : 'left',
                fontSize: '11px', fontWeight: 700, color: C.textSoft,
                textTransform: 'uppercase', letterSpacing: '0.05em',
                background: C.bg, borderBottom: `1px solid ${C.border}`,
                whiteSpace: 'nowrap',
              }}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr
              key={ri}
              onClick={() => onRowClick && onRowClick(row)}
              style={{
                background: ri % 2 === 0 ? C.surface : '#faf6ed',
                cursor: onRowClick ? 'pointer' : 'default',
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => onRowClick && (e.currentTarget.style.background = '#f0e8d8')}
              onMouseLeave={e => (e.currentTarget.style.background = ri % 2 === 0 ? C.surface : '#faf6ed')}
            >
              {columns.map((col, ci) => (
                <td key={ci} style={{
                  padding: '11px 14px',
                  borderBottom: `1px solid #f0e8d8`,
                  textAlign: col.right ? 'right' : 'left',
                  color: C.text, verticalAlign: 'middle',
                  fontVariantNumeric: col.right ? 'tabular-nums' : 'normal',
                }}>
                  {col.render ? col.render(row) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── SectionDivider ───────────────────────────────────────────────────────────
export function SectionDivider({ label }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px',
      margin: '8px 0',
    }}>
      <div style={{ flex: 1, height: '1px', background: C.border }} />
      {label && <span style={{ fontSize: '11px', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>{label}</span>}
      <div style={{ flex: 1, height: '1px', background: C.border }} />
    </div>
  )
}

// ─── StatCard ─────────────────────────────────────────────────────────────────
export function StatCard({ label, value, sub, color }) {
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`,
      borderRadius: '10px', padding: '18px 20px',
    }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>{label}</div>
      <div style={{ fontSize: '22px', fontWeight: 700, color: color || C.text, lineHeight: 1.2 }}>{value}</div>
      {sub && <div style={{ fontSize: '12px', color: C.textMuted, marginTop: '4px' }}>{sub}</div>}
    </div>
  )
}
