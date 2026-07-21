import { useEffect, useState, useCallback, useRef } from 'react'

// ─── Design tokens (mirrors CSS variables — use for inline styles) ────────────
export const C = {
  bg:           'var(--bg)',
  surface:      'var(--surface)',
  surfaceAlt:   'var(--surface-alt)',
  surfaceRaised:'var(--surface-raised)',
  border:       'var(--border)',
  borderDark:   'var(--border-dark)',
  borderFocus:  'var(--border-focus)',
  text:         'var(--text)',
  textMid:      'var(--text-mid)',
  textSoft:     'var(--text-soft)',
  textMuted:    'var(--text-muted)',
  textInverse:  'var(--text-inverse)',
  accent:       'var(--accent)',
  accentHover:  'var(--accent-hover)',
  accentLight:  'var(--accent-light)',
  dark:         'var(--dark)',
  danger:       'var(--danger)',
  dangerLight:  'var(--danger-light)',
  success:      'var(--success)',
  successLight: 'var(--success-light)',
  warning:      'var(--warning)',
  warningLight: 'var(--warning-light)',
  info:         'var(--info)',
  infoLight:    'var(--info-light)',
}

// Raw hex values — used where CSS vars can't be used (e.g. rgba())
export const RAW = {
  accent:  '#2490ef',
  dark:    '#1a1208',
  danger:  '#e03636',
  success: '#1a7a40',
  warning: '#c47a00',
  border:  '#e8dfc8',
  bg:      '#f5f0e8',
  surface: '#fffdf6',
}

// ─── Spinner ──────────────────────────────────────────────────────────────────
export function Spinner({ size = 20 }) {
  return (
    <div style={{
      width: size, height: size,
      border: `2px solid var(--border)`,
      borderTop: `2px solid var(--accent)`,
      borderRadius: '50%',
      animation: 'spin 0.7s linear infinite',
      display: 'inline-block',
      flexShrink: 0,
    }} />
  )
}

// ─── Badge ────────────────────────────────────────────────────────────────────
const BADGE_COLORS = {
  draft:        { bg: '#f0ebe0', text: '#7a6a4a' },
  submitted:    { bg: 'var(--info-light)',    text: 'var(--info)' },
  sent:         { bg: 'var(--info-light)',    text: 'var(--info)' },
  accepted:     { bg: 'var(--success-light)', text: 'var(--success)' },
  converted:    { bg: 'var(--success-light)', text: 'var(--success)' },
  paid:         { bg: 'var(--success-light)', text: 'var(--success)' },
  partial:      { bg: 'var(--warning-light)', text: 'var(--warning)' },
  open:         { bg: 'var(--info-light)',    text: 'var(--info)' },
  planned:      { bg: '#ede8f3', text: '#5a3a8a' },
  completed:    { bg: 'var(--success-light)', text: 'var(--success)' },
  cancelled:    { bg: 'var(--danger-light)',  text: 'var(--danger)' },
  active:       { bg: 'var(--success-light)', text: 'var(--success)' },
  overdue:      { bg: 'var(--danger-light)',  text: 'var(--danger)' },
  pending:      { bg: 'var(--warning-light)', text: 'var(--warning)' },
  group:        { bg: '#ede8f3', text: '#3a1a6a' },
  associate:    { bg: 'var(--info-light)',    text: 'var(--info)' },
  external:     { bg: '#f0ebe0', text: '#7a6a4a' },
  domestic:     { bg: 'var(--success-light)', text: 'var(--success)' },
  export:       { bg: '#ede8f3', text: '#3a1a6a' },
  blended:      { bg: 'var(--warning-light)', text: 'var(--warning)' },
  receipt:      { bg: 'var(--success-light)', text: 'var(--success)' },
  payment:      { bg: 'var(--warning-light)', text: 'var(--warning)' },
  in_progress:  { bg: 'var(--info-light)',    text: 'var(--info)' },
  local:        { bg: 'var(--success-light)', text: 'var(--success)' },
  interstate:   { bg: '#ede8f3', text: '#3a1a6a' },
}

export function Badge({ status, label }) {
  const c = BADGE_COLORS[status?.toLowerCase()] || { bg: '#f0ebe0', text: '#7a6a4a' }
  return (
    <span style={{
      background: c.bg, color: c.text,
      fontSize: '11px', fontWeight: 600,
      padding: '2px 7px', borderRadius: '4px',
      textTransform: 'capitalize', letterSpacing: '0.02em',
      whiteSpace: 'nowrap', display: 'inline-block',
      lineHeight: '18px',
    }}>
      {label || status?.replace(/_/g, ' ')}
    </span>
  )
}

// ─── Modal ────────────────────────────────────────────────────────────────────
export function Modal({ open, onClose, title, width = 640, children, zIndex = 1000 }) {
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
        background: 'rgba(26,18,8,0.42)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex, padding: '16px',
        animation: 'fadeIn 0.12s ease',
      }}
    >
      <div style={{
        background: 'var(--surface-raised)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        width: '100%', maxWidth: width,
        maxHeight: '90vh', overflow: 'auto',
        boxShadow: 'var(--shadow-modal)',
        animation: 'slideDown 0.16s ease',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 20px',
          borderBottom: '1px solid var(--border)',
          position: 'sticky', top: 0,
          background: 'var(--surface-raised)', zIndex: 1,
        }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text)' }}>{title}</div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: '18px', color: 'var(--text-muted)',
            lineHeight: 1, padding: '2px 6px',
            borderRadius: 'var(--radius-sm)',
            transition: 'color var(--transition-fast)',
          }}
          onMouseEnter={e => e.target.style.color = 'var(--text)'}
          onMouseLeave={e => e.target.style.color = 'var(--text-muted)'}
          >×</button>
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
      <p style={{ color: 'var(--text-mid)', fontSize: '13px', marginBottom: '20px', lineHeight: 1.6 }}>
        {message}
      </p>
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <Btn variant='ghost' size='sm' onClick={onClose}>Cancel</Btn>
        <Btn variant={danger ? 'danger' : 'primary'} size='sm' onClick={onConfirm}>Confirm</Btn>
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

  const ICONS = { success: '✓', error: '✕', info: 'ℹ' }
  const colors = {
    success: { bg: 'var(--success-light)', text: 'var(--success)', border: '#b8dfca' },
    error:   { bg: 'var(--danger-light)',  text: 'var(--danger)',  border: '#f0c0c0' },
    info:    { bg: 'var(--info-light)',    text: 'var(--info)',    border: '#b8d0e0' },
  }
  const c = colors[type] || colors.info

  return (
    <div style={{
      position: 'fixed', bottom: '24px', right: '24px',
      background: c.bg, color: c.text,
      border: `1px solid ${c.border}`,
      padding: '10px 16px', borderRadius: 'var(--radius-md)',
      fontSize: '13px', fontWeight: 500,
      boxShadow: 'var(--shadow-lg)',
      zIndex: 2000, maxWidth: '380px', minWidth: '240px',
      display: 'flex', alignItems: 'center', gap: '10px',
      animation: 'fadeUp 0.18s ease',
    }}>
      <span style={{
        width: 20, height: 20, borderRadius: '50%',
        background: c.text, color: c.bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '11px', fontWeight: 700, flexShrink: 0,
      }}>{ICONS[type]}</span>
      <span style={{ flex: 1 }}>{message}</span>
      <button onClick={onClose} style={{
        background: 'none', border: 'none', cursor: 'pointer',
        color: c.text, fontSize: '16px', padding: 0, opacity: 0.5,
        transition: 'opacity var(--transition-fast)',
      }}
      onMouseEnter={e => e.target.style.opacity = 1}
      onMouseLeave={e => e.target.style.opacity = 0.5}
      >×</button>
    </div>
  )
}

// ─── EmptyState ───────────────────────────────────────────────────────────────
export function EmptyState({ icon = '📋', title, message, action }) {
  return (
    <div style={{
      textAlign: 'center', padding: '56px 24px',
      color: 'var(--text-muted)',
      animation: 'fadeIn 0.2s ease',
    }}>
      <div style={{ fontSize: '36px', marginBottom: '12px', opacity: 0.4 }}>{icon}</div>
      <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-mid)', marginBottom: '6px' }}>{title}</div>
      {message && <div style={{ fontSize: '13px', lineHeight: 1.6, marginBottom: action ? '16px' : 0, maxWidth: '320px', margin: '0 auto' }}>{message}</div>}
      {action && <div style={{ marginTop: '16px' }}>{action}</div>}
    </div>
  )
}

// ─── Btn ──────────────────────────────────────────────────────────────────────
export function Btn({ children, onClick, variant = 'primary', size = 'md', disabled, type = 'button', style: extraStyle }) {
  const base = {
    border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'var(--font-sans)', fontWeight: 600, letterSpacing: '0.01em',
    borderRadius: 'var(--radius)', transition: 'all var(--transition)',
    opacity: disabled ? 0.45 : 1,
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    whiteSpace: 'nowrap', flexShrink: 0,
  }
  const sizes = {
    xs: { padding: '3px 8px',   fontSize: '11px', height: '24px' },
    sm: { padding: '5px 11px',  fontSize: '12px', height: '28px' },
    md: { padding: '7px 14px',  fontSize: '13px', height: '32px' },
    lg: { padding: '9px 20px',  fontSize: '14px', height: '38px' },
  }
  const variants = {
    primary: { background: 'var(--accent)',   color: '#fff', boxShadow: '0 1px 2px rgba(36,144,239,0.3)' },
    ghost:   { background: 'transparent', color: 'var(--text-mid)', border: '1px solid var(--border-dark)' },
    dark:    { background: 'var(--dark)',     color: 'var(--text-inverse)' },
    danger:  { background: 'var(--danger)',   color: '#fff' },
    success: { background: 'var(--success)',  color: '#fff' },
    subtle:  { background: 'var(--bg)',       color: 'var(--text-soft)', border: '1px solid var(--border)' },
  }

  const [hovered, setHovered] = useState(false)
  const hoverMap = {
    primary: { background: 'var(--accent-hover)' },
    ghost:   { background: 'var(--bg)' },
    dark:    { background: 'var(--dark-hover)' },
    danger:  { background: '#c42d2d' },
    success: { background: '#15663a' },
    subtle:  { background: 'var(--surface-alt)' },
  }

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...base,
        ...sizes[size] || sizes.md,
        ...variants[variant],
        ...(hovered && !disabled ? hoverMap[variant] : {}),
        ...extraStyle,
      }}
    >
      {children}
    </button>
  )
}

// ─── FormRow ──────────────────────────────────────────────────────────────────
export function FormRow({ label, required, children, hint, error, action }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {label && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <label style={{
            fontSize: '11px', fontWeight: 700, color: 'var(--text-soft)',
            textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            {label}{required && <span style={{ color: 'var(--danger)', marginLeft: '2px' }}>*</span>}
          </label>
          {action}
        </div>
      )}
      {children}
      {hint && !error && <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.4 }}>{hint}</div>}
      {error && <div style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</div>}
    </div>
  )
}

// ─── Input ────────────────────────────────────────────────────────────────────
export function Input({ value, onChange, placeholder, type = 'text', disabled, readOnly, style: extra, onKeyDown, list }) {
  return (
    <input
      type={type}
      value={value ?? ''}
      onChange={onChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      list={list}
      className='tb-input'
      style={{
        padding: '7px 10px',
        border: '1.5px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: disabled || readOnly ? 'var(--bg)' : 'var(--surface-raised)',
        color: 'var(--text)', fontSize: '13px',
        width: '100%', boxSizing: 'border-box',
        outline: 'none', fontFamily: 'var(--font-sans)',
        transition: 'border-color var(--transition), box-shadow var(--transition)',
        cursor: readOnly ? 'default' : 'text',
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
      className='tb-select'
      style={{
        padding: '7px 10px',
        border: '1.5px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: disabled ? 'var(--bg)' : 'var(--surface-raised)',
        color: 'var(--text)', fontSize: '13px',
        width: '100%', boxSizing: 'border-box',
        outline: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'var(--font-sans)',
        transition: 'border-color var(--transition), box-shadow var(--transition)',
        ...extra,
      }}
    >
      {children}
    </select>
  )
}

// ─── MultiSelectDropdown ────────────────────────────────────────────────────
// Checkbox-list dropdown for filter bars where more than one value (e.g.
// status) needs to be selected at once — a plain <select> can only ever hold
// one. `options` is an array of strings or {value,label} objects; `selected`
// is an array of the chosen values.
export function MultiSelectDropdown({ options, selected, onChange, placeholder = 'All', style: extra }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  function norm(opt) { return typeof opt === 'string' ? { value: opt, label: opt } : opt }
  function toggle(value) {
    const next = new Set(selected)
    next.has(value) ? next.delete(value) : next.add(value)
    onChange([...next])
  }

  const label = selected.length === 0 ? placeholder
    : selected.length === 1 ? norm(options.find(o => norm(o).value === selected[0]) || selected[0]).label
    : `${selected.length} selected`

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type='button' onClick={() => setOpen(o => !o)} style={{
        padding: '7px 12px', border: `1.5px solid var(--border)`, borderRadius: 'var(--radius)',
        background: 'var(--surface)', fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit',
        display: 'flex', alignItems: 'center', gap: '8px', color: selected.length ? 'var(--text)' : 'var(--text-muted)',
        textTransform: 'capitalize', whiteSpace: 'nowrap', ...extra,
      }}>
        {label}
        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 20,
          background: 'var(--surface)', border: `1.5px solid var(--border)`, borderRadius: 'var(--radius)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.14)', minWidth: '180px', padding: '6px', maxHeight: '280px', overflowY: 'auto',
        }}>
          {selected.length > 0 && (
            <div onClick={() => onChange([])}
              style={{ padding: '6px 8px', fontSize: '12px', color: 'var(--accent)', cursor: 'pointer', borderBottom: `1px solid var(--border)`, marginBottom: '4px' }}>
              Clear all
            </div>
          )}
          {options.map(opt => {
            const { value, label } = norm(opt)
            return (
              <label key={value} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', fontSize: '13px', cursor: 'pointer', borderRadius: '4px', textTransform: 'capitalize' }}>
                <input type='checkbox' checked={selected.includes(value)} onChange={() => toggle(value)} />
                {label}
              </label>
            )
          })}
        </div>
      )}
    </div>
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
      className='tb-textarea'
      style={{
        padding: '7px 10px',
        border: '1.5px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: disabled ? 'var(--bg)' : 'var(--surface-raised)',
        color: 'var(--text)', fontSize: '13px',
        width: '100%', boxSizing: 'border-box',
        outline: 'none', fontFamily: 'var(--font-sans)',
        resize: 'vertical',
        transition: 'border-color var(--transition), box-shadow var(--transition)',
      }}
    />
  )
}

// ─── PageHeader ───────────────────────────────────────────────────────────────
export function PageHeader({ title, subtitle, action, meta }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      marginBottom: '20px', gap: '16px',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text)', margin: 0, lineHeight: 1.3 }}>{title}</h1>
          {meta}
        </div>
        {subtitle && <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '3px 0 0', lineHeight: 1.5 }}>{subtitle}</p>}
      </div>
      {action && <div style={{ flexShrink: 0, display: 'flex', gap: '8px', alignItems: 'center' }}>{action}</div>}
    </div>
  )
}

// ─── Card ─────────────────────────────────────────────────────────────────────
export function Card({ children, style: extra, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--surface-raised)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        boxShadow: 'var(--shadow-sm)',
        cursor: onClick ? 'pointer' : undefined,
        ...extra,
      }}
    >
      {children}
    </div>
  )
}

// ─── CsvFileDrop — file picker / drag-drop that loads a .csv file's text ──────
// Drop a .csv file or click "Choose File"; the file's contents are handed to
// onText(text) so callers can feed it into their existing paste-CSV state.
export function CsvFileDrop({ onText, label = 'Choose File' }) {
  const inputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState('')

  async function readFile(file) {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.csv')) { setError('Please choose a .csv file'); return }
    setError('')
    setFileName(file.name)
    const text = await file.text()
    onText(text)
  }

  return (
    <div>
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); readFile(e.dataTransfer.files?.[0]) }}
        style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          border: `1.5px dashed ${dragOver ? 'var(--accent)' : 'var(--border-dark)'}`,
          borderRadius: 'var(--radius)', padding: '12px 14px',
          background: dragOver ? 'var(--accent-light)' : 'var(--bg)',
          transition: 'all var(--transition-fast)',
        }}
      >
        <span style={{ fontSize: '12px', color: 'var(--text-muted)', flex: 1 }}>
          {fileName ? `Loaded: ${fileName}` : 'Drag a .csv file here, or'}
        </span>
        <Btn size='sm' variant='ghost' onClick={() => inputRef.current?.click()}>↑ {label}</Btn>
        <input
          ref={inputRef} type='file' accept='.csv' style={{ display: 'none' }}
          onChange={e => { readFile(e.target.files?.[0]); e.target.value = '' }}
        />
      </div>
      {error && <div style={{ fontSize: '11px', color: 'var(--danger)', marginTop: '4px' }}>{error}</div>}
    </div>
  )
}
export function CardHeader({ title, action, children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 16px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--surface-raised)',
    }}>
      {title && <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text)' }}>{title}</div>}
      {children}
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
    </div>
  )
}

// ─── Table ────────────────────────────────────────────────────────────────────
export function Table({ columns, rows, onRowClick, emptyState, sortKey, sortDir, onSort }) {
  if (!rows || rows.length === 0) {
    return emptyState || <EmptyState title='No records found' message='Try adjusting your filters or create a new record.' />
  }

  function SortIcon({ col }) {
    if (!onSort || !col.sortable) return null
    const active = sortKey === col.key
    return (
      <span className={`sort-icon ${active ? sortDir : ''}`} style={{ marginLeft: 4, display: 'inline-flex', flexDirection: 'column', gap: 1, verticalAlign: 'middle', opacity: active ? 1 : 0.35 }}>
        <span style={{ display: 'block', width: 0, height: 0, borderLeft: '3px solid transparent', borderRight: '3px solid transparent', borderBottom: `4px solid ${active && sortDir === 'asc' ? RAW.accent : 'currentColor'}` }} className='arrow-up' />
        <span style={{ display: 'block', width: 0, height: 0, borderLeft: '3px solid transparent', borderRight: '3px solid transparent', borderTop: `4px solid ${active && sortDir === 'desc' ? RAW.accent : 'currentColor'}` }} className='arrow-down' />
      </span>
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr>
            {columns.map((col, i) => (
              <th
                key={i}
                className={col.sortable && onSort ? 'th-sortable' : ''}
                onClick={() => col.sortable && onSort && onSort(col.key)}
                style={{
                  padding: '8px 12px', textAlign: col.right ? 'right' : 'left',
                  fontSize: '11px', fontWeight: 700, color: sortKey === col.key ? RAW.accent : '#9a8a6a',
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                  background: 'var(--bg)',
                  borderBottom: '1px solid var(--border)',
                  borderTop: '1px solid var(--border)',
                  whiteSpace: 'nowrap',
                  // CHANGED: stays pinned when this table sits inside a
                  // scrollable container (e.g. a Card with maxHeight+overflowY)
                  // — harmless no-op otherwise, since a non-scrolling ancestor
                  // never triggers the sticky behavior.
                  position: 'sticky', top: 0, zIndex: 1,
                }}
              >
                {col.label}<SortIcon col={col} />
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
                background: ri % 2 === 0 ? 'var(--surface-raised)' : 'var(--surface-alt)',
                cursor: onRowClick ? 'pointer' : 'default',
                transition: 'background var(--transition-fast)',
              }}
              onMouseEnter={e => onRowClick && (e.currentTarget.style.background = 'var(--accent-light)')}
              onMouseLeave={e => (e.currentTarget.style.background = ri % 2 === 0 ? 'var(--surface-raised)' : 'var(--surface-alt)')}
            >
              {columns.map((col, ci) => (
                <td key={ci} style={{
                  padding: '9px 12px',
                  borderBottom: '1px solid var(--border)',
                  textAlign: col.right ? 'right' : 'left',
                  color: 'var(--text)', verticalAlign: 'middle',
                  fontVariantNumeric: col.right ? 'tabular-nums' : 'normal',
                  maxWidth: col.maxWidth || undefined,
                }}>
                  {col.render ? col.render(row, ri) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── TableFooter — row count + pagination hint ────────────────────────────────
export function TableFooter({ total, filtered }) {
  if (!total) return null
  return (
    <div style={{
      padding: '8px 12px',
      borderTop: '1px solid var(--border)',
      fontSize: '11px', color: 'var(--text-muted)',
      display: 'flex', justifyContent: 'flex-end',
    }}>
      {filtered !== undefined && filtered !== total
        ? `${filtered} of ${total} records`
        : `${total} record${total !== 1 ? 's' : ''}`}
    </div>
  )
}

// ─── SectionDivider ───────────────────────────────────────────────────────────
export function SectionDivider({ label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '8px 0' }}>
      <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
      {label && <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>{label}</span>}
      <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
    </div>
  )
}

// ─── StatCard ─────────────────────────────────────────────────────────────────
export function StatCard({ label, value, sub, color, icon, onClick }) {
  const [hov, setHov] = useState(false)
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => onClick && setHov(true)}
      onMouseLeave={() => onClick && setHov(false)}
      style={{
        background: 'var(--surface-raised)',
        border: `1px solid ${hov ? RAW.accent : 'var(--border)'}`,
        borderRadius: 'var(--radius-md)',
        padding: '16px 18px',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'border-color var(--transition), box-shadow var(--transition)',
        boxShadow: hov ? `0 0 0 3px rgba(36,144,239,0.12)` : 'var(--shadow-sm)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>{label}</div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: color || 'var(--text)', lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
          {sub && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>{sub}</div>}
        </div>
        {icon && <div style={{ color: color || 'var(--text-muted)', opacity: 0.6, flexShrink: 0, marginTop: 2 }}>{icon}</div>}
      </div>
    </div>
  )
}

// ─── Kbd — keyboard shortcut badge ───────────────────────────────────────────
export function Kbd({ children }) {
  return (
    <kbd style={{
      background: 'var(--bg)',
      border: '1px solid var(--border-dark)',
      borderRadius: 'var(--radius-sm)',
      padding: '1px 5px',
      fontSize: '10px',
      fontFamily: 'var(--font-sans)',
      color: 'var(--text-muted)',
      fontWeight: 600,
      display: 'inline-block',
      lineHeight: '16px',
    }}>{children}</kbd>
  )
}

// ─── StatusStrip — coloured top border for form/detail views ─────────────────
export function StatusStrip({ status }) {
  const colorMap = {
    draft: RAW.warning, open: RAW.accent, active: RAW.success,
    submitted: RAW.accent, paid: RAW.success, completed: RAW.success,
    cancelled: RAW.danger, overdue: RAW.danger, pending: RAW.warning,
    partial: RAW.warning, in_progress: RAW.accent, planned: RAW.warning,
  }
  const color = colorMap[status?.toLowerCase()] || RAW.accent
  return (
    <div style={{
      height: '3px', borderRadius: '3px 3px 0 0',
      background: color, width: '100%',
    }} />
  )
}

// ─── SearchBar ────────────────────────────────────────────────────────────────
export function SearchBar({ value, onChange, placeholder = 'Search…', style: extra }) {
  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', ...extra }}>
      <svg style={{ position: 'absolute', left: 9, width: 14, height: 14, color: 'var(--text-muted)', pointerEvents: 'none' }} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5'>
        <circle cx='11' cy='11' r='8'/><path d='m21 21-4.35-4.35'/>
      </svg>
      <input
        type='text'
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className='tb-input'
        style={{
          paddingLeft: '30px', paddingRight: '10px',
          paddingTop: '6px', paddingBottom: '6px',
          border: '1.5px solid var(--border)',
          borderRadius: 'var(--radius)',
          background: 'var(--surface-raised)',
          color: 'var(--text)', fontSize: '13px',
          fontFamily: 'var(--font-sans)',
          outline: 'none', width: '100%',
          transition: 'border-color var(--transition), box-shadow var(--transition)',
        }}
      />
    </div>
  )
}
