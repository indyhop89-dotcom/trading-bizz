/**
 * CSV Template utility
 * downloadCSV(filename, headers, rows) — triggers browser download instantly.
 * No server, no libraries — pure browser.
 */

/**
 * Detect the delimiter actually used in a CSV line. Handles the common case
 * where a user copies cells straight out of Excel (tab-separated) or a
 * regional Excel build that uses semicolons, instead of true comma-CSV.
 */
export function detectDelimiter(headerLine) {
  const counts = {
    ',':  (headerLine.match(/,/g)  || []).length,
    '\t': (headerLine.match(/\t/g) || []).length,
    ';':  (headerLine.match(/;/g)  || []).length,
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  return best[1] > 0 ? best[0] : ','
}

// CHANGED: moved here from Stock/index.jsx (was a private, unexported
// function there) so PI/PO/Invoices CSV upload can also parse quoted fields
// correctly. Plain `line.split(delim)` breaks the moment a field (e.g. a
// product name or description) contains the delimiter character inside
// quotes, like `"Steel Tea, Coffee & Sugar Container Set, 3 Pieces"` — it
// silently shreds the name across the wrong columns instead of erroring,
// which is how several PI lines ended up with truncated, unmatchable
// descriptions. This walks the line char-by-char, only splitting on `delim`
// when outside a quoted span, and un-escapes doubled quotes ("" -> ") per
// standard CSV rules.
export function parseCSVLine(line, delim) {
  const out = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ }
        else inQuotes = false
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delim) {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur.trim())
  return out
}

export function downloadCSV(filename, headers, rows) {
  const escape = val => {
    if (val === null || val === undefined) return ''
    const str = String(val)
    // wrap in quotes if contains comma, quote, or newline
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`
    }
    return str
  }

  const lines = [
    headers.map(escape).join(','),
    ...rows.map(row => headers.map(h => escape(row[h] ?? '')).join(',')),
  ]

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href     = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

// ─── Templates ────────────────────────────────────────────────────────────────

export const TEMPLATES = {

  products: {
    filename: 'products_template.csv',
    // CHANGED: category column added (optional)
    headers:  ['name', 'hsn_code', 'gst_rate', 'unit', 'default_rate', 'description', 'category'],
    rows: [
      { name: 'T-Shirt Basic Round Neck', hsn_code: '6109', gst_rate: 12, unit: 'Nos', default_rate: 250, description: 'Basic round neck t-shirt', category: 'Apparel' },
      { name: 'Cotton Woven Fabric', hsn_code: '5208', gst_rate: 5,  unit: 'Mtr', default_rate: 180, description: 'Cotton fabric 200gsm', category: 'Fabric' },
      { name: 'Polo T-Shirt', hsn_code: '6110', gst_rate: 12, unit: 'Nos', default_rate: 450, description: 'Polo collar t-shirt', category: 'Apparel' },
    ],
  },

  opening_stock: {
    filename: 'opening_stock_template.csv',
    // CHANGED: category column added (optional — only used if a product is auto-created by this upload)
    headers:  ['entity', 'product', 'fy', 'qty', 'unit', 'rate', 'hsn_code', 'gst_rate', 'as_of_date', 'category'],
    rows: [
      { entity: 'Siddi', product: 'T-Shirt Basic Round Neck', fy: 'FY 2025-26', qty: 1000, unit: 'Nos', rate: 250, hsn_code: '6109', gst_rate: 12, as_of_date: '2025-04-01', category: 'Apparel' },
      { entity: 'Retail', product: 'Cotton Woven Fabric',      fy: 'FY 2025-26', qty: 500,  unit: 'Mtr', rate: 180, hsn_code: '5208', gst_rate: 5,  as_of_date: '2025-04-01', category: 'Fabric' },
      { entity: 'MVL',    product: 'Polo T-Shirt',             fy: 'FY 2025-26', qty: 300,  unit: 'Nos', rate: 450, hsn_code: '6110', gst_rate: 12, as_of_date: '2025-04-01', category: 'Apparel' },
    ],
    notes: [
      '# entity   = short name or full name exactly as in Entities module',
      '# product  = product name exactly as in Products',
      '# fy       = financial year name exactly as in Settings → Financial Years',
      '# rate     = rate per unit in rupees',
      '# unit     = Nos / Kg / Pcs / Box / Mtr / Ltr / Set — leave blank to use the product\'s default unit',
      '# hsn_code = leave blank to use the product\'s default HSN code',
      '# gst_rate = GST % number only, e.g. 12 — leave blank to use the product\'s default GST rate',
      '# as_of_date = YYYY-MM-DD format',
    ],
  },

  hsn_master: {
    filename: 'hsn_master_template.csv',
    headers:  ['hsn_code', 'description', 'rate_type', 'fixed_rate', 'slabs'],
    rows: [
      { hsn_code: '5208', description: 'Cotton woven fabric >=85%, <=200gsm', rate_type: 'fixed', fixed_rate: 5,  slabs: '' },
      { hsn_code: '6109', description: 'T-shirts, singlets, vests knitted',    rate_type: 'slab',  fixed_rate: '', slabs: '1000:5|null:12' },
      { hsn_code: '6201', description: 'Mens overcoats and capes',             rate_type: 'slab',  fixed_rate: '', slabs: '1000:5|5000:12|null:18' },
    ],
    notes: [
      '# rate_type  = fixed OR slab',
      '# fixed_rate = GST % for fixed type (leave blank for slab)',
      '# slabs      = for slab type: threshold_rupees:gst_rate pairs separated by |',
      '#             null threshold = open-ended final slab (must be last)',
      '#             example: 1000:5|null:12 means <=Rs1000 @ 5%, above @ 12%',
    ],
  },

  pi: {
    filename: 'pi_template.csv',
    headers:  ['pi_date', 'from_entity', 'to_entity', 'is_interstate', 'product', 'description', 'hsn_code', 'qty', 'unit', 'rate', 'gst_rate', 'valid_upto', 'notes', 'pi_no'],
    rows: [
      { pi_date: '2025-04-15', from_entity: 'Siddi', to_entity: 'Retail', is_interstate: 'false', product: 'T-Shirt Basic Round Neck', description: 'T-Shirt Basic Round Neck', hsn_code: '6109', qty: 500, unit: 'Nos', rate: 250, gst_rate: 12, valid_upto: '2025-05-15', notes: '', pi_no: '' },
      { pi_date: '2025-04-15', from_entity: 'Siddi', to_entity: 'Retail', is_interstate: 'false', product: 'Polo T-Shirt',             description: 'Polo T-Shirt',             hsn_code: '6110', qty: 200, unit: 'Nos', rate: 450, gst_rate: 12, valid_upto: '2025-05-15', notes: '', pi_no: '' },
      { pi_date: '2025-04-20', from_entity: 'Retail', to_entity: 'MVL',   is_interstate: 'true',  product: 'T-Shirt Basic Round Neck', description: 'T-Shirt Basic Round Neck', hsn_code: '6109', qty: 300, unit: 'Nos', rate: 320, gst_rate: 12, valid_upto: '2025-05-20', notes: 'Export order', pi_no: '' },
    ],
    notes: [
      '# Each row = one LINE ITEM. Multiple rows with same pi_date+from+to = same PI.',
      '# from_entity / to_entity = short name or full name exactly as in Entities',
      '# product = match an existing Product name exactly (Stock > Products) — required for stock tracking to work. If no match is found, a new product is auto-created using this rows hsn_code / gst_rate / rate / unit.',
      '# is_interstate = true or false',
      '# rate = rate per unit in rupees (no symbols)',
      '# pi_no = optional — leave blank to auto-generate, or supply your own PI number',
      '# gst_rate = GST % number only e.g. 12 or 18',
    ],
  },

  po: {
    filename: 'po_template.csv',
    headers:  ['po_date', 'buyer_entity', 'seller_entity', 'is_interstate', 'product', 'description', 'hsn_code', 'qty', 'unit', 'rate', 'gst_rate', 'delivery_date', 'notes', 'po_no'],
    rows: [
      { po_date: '2025-04-16', buyer_entity: 'Retail', seller_entity: 'Siddi', is_interstate: 'false', product: 'T-Shirt Basic Round Neck', description: 'T-Shirt Basic Round Neck', hsn_code: '6109', qty: 500, unit: 'Nos', rate: 250, gst_rate: 12, delivery_date: '2025-05-01', notes: '', po_no: '' },
      { po_date: '2025-04-16', buyer_entity: 'Retail', seller_entity: 'Siddi', is_interstate: 'false', product: 'Polo T-Shirt',             description: 'Polo T-Shirt',             hsn_code: '6110', qty: 200, unit: 'Nos', rate: 450, gst_rate: 12, delivery_date: '2025-05-01', notes: '', po_no: '' },
      { po_date: '2025-04-21', buyer_entity: 'MVL',   seller_entity: 'Retail', is_interstate: 'true',  product: 'T-Shirt Basic Round Neck', description: 'T-Shirt Basic Round Neck', hsn_code: '6109', qty: 300, unit: 'Nos', rate: 320, gst_rate: 12, delivery_date: '2025-05-10', notes: '', po_no: '' },
    ],
    notes: [
      '# Each row = one LINE ITEM. Multiple rows with same po_date+buyer+seller = same PO.',
      '# buyer_entity / seller_entity = short name or full name exactly as in Entities',
      '# product = match an existing Product name exactly (Stock > Products) — required for stock tracking to work. If no match is found, a new product is auto-created using this rows hsn_code / gst_rate / rate / unit.',
      '# is_interstate = true or false',
      '# rate = rate per unit in rupees',
      '# po_no = optional — leave blank to auto-generate, or supply your own PO number',
    ],
  },

  invoices: {
    filename: 'invoices_template.csv',
    headers:  ['invoice_date', 'invoice_type', 'seller_entity', 'buyer_entity', 'is_interstate', 'product', 'description', 'hsn_code', 'qty', 'unit', 'rate', 'gst_rate', 'due_date', 'notes', 'invoice_no'],
    rows: [
      { invoice_date: '2025-04-30', invoice_type: 'sales', seller_entity: 'Siddi', buyer_entity: 'Retail', is_interstate: 'false', product: 'T-Shirt Basic Round Neck', description: 'T-Shirt Basic Round Neck', hsn_code: '6109', qty: 500, unit: 'Nos', rate: 250, gst_rate: 12, due_date: '2025-05-30', notes: '', invoice_no: '' },
      { invoice_date: '2025-04-30', invoice_type: 'sales', seller_entity: 'Siddi', buyer_entity: 'Retail', is_interstate: 'false', product: 'Polo T-Shirt',             description: 'Polo T-Shirt',             hsn_code: '6110', qty: 200, unit: 'Nos', rate: 450, gst_rate: 12, due_date: '2025-05-30', notes: '', invoice_no: '' },
      { invoice_date: '2025-05-05', invoice_type: 'sales', seller_entity: 'Retail', buyer_entity: 'MVL',  is_interstate: 'true',  product: 'T-Shirt Basic Round Neck', description: 'T-Shirt Basic Round Neck', hsn_code: '6109', qty: 300, unit: 'Nos', rate: 320, gst_rate: 12, due_date: '2025-06-05', notes: 'Export invoice', invoice_no: '' },
    ],
    notes: [
      '# Each row = one LINE ITEM. Multiple rows with same invoice_date+seller+buyer = same Invoice.',
      '# invoice_type = sales or purchase',
      '# seller_entity / buyer_entity = short name or full name exactly as in Entities',
      '# product = match an existing Product name exactly (Stock > Products) — required for stock tracking to work. If no match is found, a new product is auto-created using this rows hsn_code / gst_rate / rate / unit.',
      '# is_interstate = true or false',
      '# invoice_no = optional — leave blank to auto-generate, or supply your own invoice number',
      '# rate = rate per unit in rupees',
    ],
  },

  stock_adjustments: {
    filename: 'stock_adjustments_template.csv',
    headers:  ['entity', 'product', 'qty', 'reason', 'adjustment_date', 'notes'],
    rows: [
      { entity: 'Siddi',  product: 'T-Shirt Basic Round Neck', qty: -5,  reason: 'shortfall', adjustment_date: '2025-04-30', notes: 'Physical count came up short vs system' },
      { entity: 'Siddi',  product: 'Polo T-Shirt',             qty: -3,  reason: 'damage',    adjustment_date: '2025-04-30', notes: 'Water damage in warehouse' },
      { entity: 'Retail', product: 'Cotton Woven Fabric',      qty: 10,  reason: 'found',     adjustment_date: '2025-04-30', notes: 'Found unbilled stock from an old lot' },
      { entity: 'Retail', product: 'T-Shirt Basic Round Neck', qty: -2,  reason: 'recount',   adjustment_date: '2025-04-30', notes: 'Annual stock recount correction' },
      { entity: 'MVL',    product: 'Polo T-Shirt',             qty: 1,   reason: 'other',     adjustment_date: '2025-04-30', notes: 'Sample piece returned to stock' },
    ],
    notes: [
      '# entity  = short name or full name exactly as in Entities module',
      '# product = must match an existing Product name exactly (Stock > Products) — not auto-created',
      '# qty     = signed number. Positive = stock increase (found/recount-up). Negative = stock decrease (shortfall/damage/recount-down)',
      '# reason  = shortfall | damage | found | recount | other',
      '# adjustment_date = YYYY-MM-DD format',
      '# notes   = optional free text',
    ],
  },

  entities: {
    filename: 'entities_template.csv',
    headers:  ['name', 'short_name', 'type', 'gstin', 'pan', 'state_code', 'state_name', 'city', 'pincode', 'email', 'phone', 'bank_name', 'bank_account_no', 'bank_ifsc'],
    rows: [
      { name: 'Siddhi Garments Pvt Ltd', short_name: 'Siddi', type: 'associate', gstin: '29AABCS1234A1Z5', pan: 'AABCS1234A', state_code: '29', state_name: 'Karnataka', city: 'Bangalore', pincode: '560001', email: 'siddi@vananam.in', phone: '9876543210', bank_name: 'HDFC Bank', bank_account_no: '12345678901234', bank_ifsc: 'HDFC0001234' },
      { name: 'Retail Solutions LLP',    short_name: 'Retail', type: 'associate', gstin: '29AABCR5678A1Z5', pan: 'AABCR5678A', state_code: '29', state_name: 'Karnataka', city: 'Bangalore', pincode: '560002', email: 'retail@vananam.in', phone: '9876543211', bank_name: 'ICICI Bank', bank_account_no: '98765432109876', bank_ifsc: 'ICIC0001234' },
      { name: 'Creative Vision Textiles LLC', short_name: 'CVT', type: 'external', gstin: '',              pan: '',           state_code: '',   state_name: '',          city: 'Dubai',     pincode: '',       email: 'cvt@example.com',    phone: '+971501234567', bank_name: '', bank_account_no: '', bank_ifsc: '' },
    ],
    notes: [
      '# type = group | associate | external',
      '# state_code = 2-digit GST state code e.g. 29 for Karnataka',
      '# Leave fields blank if not applicable',
    ],
  },

}

/** Download a template by key */
export function downloadTemplate(key) {
  const t = TEMPLATES[key]
  if (!t) return
  // Add notes as comment rows at the top if present
  const allRows = t.rows
  downloadCSV(t.filename, t.headers, allRows)
  // Also log notes to console for reference
  if (t.notes) console.log(`[${key} template notes]\n` + t.notes.join('\n'))
}
