// Badge
export function Badge({ children, color = 'gray' }) {
  return <span className={`badge badge-${color}`}>{children}</span>
}

// Status badge helper
export function StatusBadge({ status }) {
  const map = {
    // Generic
    draft:     { label: 'Draft',     color: 'gray'   },
    open:      { label: 'Open',      color: 'blue'   },
    active:    { label: 'Active',    color: 'green'  },
    submitted: { label: 'Submitted', color: 'blue'   },
    cancelled: { label: 'Cancelled', color: 'red'    },
    completed: { label: 'Completed', color: 'green'  },
    closed:    { label: 'Closed',    color: 'gray'   },
    // Payment
    paid:      { label: 'Paid',      color: 'green'  },
    partial:   { label: 'Partial',   color: 'amber'  },
    unpaid:    { label: 'Unpaid',    color: 'red'    },
    overdue:   { label: 'Overdue',   color: 'red'    },
    // PI/PO
    sent:      { label: 'Sent',      color: 'blue'   },
    accepted:  { label: 'Accepted',  color: 'green'  },
    converted: { label: 'Converted', color: 'gray'   },
    // Movement
    pending:        { label: 'Pending',     color: 'gray'   },
    in_transit:     { label: 'In Transit',  color: 'amber'  },
    delivered:      { label: 'Delivered',   color: 'green'  },
    in_progress:    { label: 'In Progress', color: 'amber'  },
    // Bill discounting
    partially_repaid: { label: 'Partial',   color: 'amber'  },
    repaid:           { label: 'Repaid',    color: 'green'  },
    // Doc
    uploaded:  { label: 'Uploaded',  color: 'green'  },
    na:        { label: 'N/A',       color: 'gray'   },
  }
  const s = map[status] || { label: status, color: 'gray' }
  return <Badge color={s.color}>{s.label}</Badge>
}

// Spinner
export function Spinner({ sm }) {
  return <span className={`spinner${sm ? ' spinner-sm' : ''}`} />
}

// Loading center
export function Loading({ message = 'Loading…' }) {
  return (
    <div className="loading-center">
      <Spinner /> {message}
    </div>
  )
}

// Empty state
export function Empty({ message = 'No records yet', action }) {
  return (
    <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--ink3)' }}>
      <div style={{ fontSize: 32, marginBottom: 8 }}>—</div>
      <div style={{ fontSize: 13, marginBottom: action ? 14 : 0 }}>{message}</div>
      {action}
    </div>
  )
}

// Divider
export function Sep() {
  return <div className="sep" />
}

// Interstate badge
export function TaxBadge({ isInterstate }) {
  return isInterstate
    ? <Badge color="purple">IGST</Badge>
    : <Badge color="blue">CGST+SGST</Badge>
}

// Leg type badge
export function LegTypeBadge({ legType }) {
  return legType === 'export'
    ? <Badge color="amber">Export</Badge>
    : <Badge color="blue">Domestic</Badge>
}
