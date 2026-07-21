import { useState } from 'react'
import { C, Btn } from './UI/index'
import { formatINR, formatQty, toNum, round2, roundRupees } from '../utils/money'
import { calcLineTax } from '../utils/tax'
import { resolveGSTRate } from '../utils/hsn'
import { calcSellRate, calcMarginPct } from '../utils/margin'

const GST_RATES = [0, 3, 5, 12, 18, 28]
const UNITS     = ['Nos', 'Kg', 'Pcs', 'Box', 'Mtr', 'Ltr', 'Set']

export function computeLine(line, interstate) {
  const qty     = Number(line.qty)  || 0
  const rate    = Number(line.rate) || 0
  const taxable = round2(qty * rate)
  const tax     = calcLineTax(taxable, line.gst_rate, interstate)
  return {
    ...line,
    taxable_amount: taxable,
    ...tax,
    total_amount: round2(taxable + tax.total_tax),
  }
}

// CHANGED: optional `roundOffOverride` (raw string/number from a manual
// input) lets the user pin round_off_amount to a specific value instead of
// always auto-computing it — for correcting an externally-sourced document
// (an Excel/CSV a client already sent) whose own rounding doesn't land on
// GST Rule 46's "nearest rupee from the precise subtotal" exactly, so the
// auto value would otherwise force a mismatch no amount of line-editing can
// close. Blank/undefined/NaN falls through to the original auto behaviour.
export function computeTotals(lines, roundOffOverride) {
  const sum = lines.reduce((acc, l) => ({
    taxable_amount: acc.taxable_amount + (Number(l.taxable_amount) || 0),
    cgst_amount:    acc.cgst_amount    + (Number(l.cgst_amount)    || 0),
    sgst_amount:    acc.sgst_amount    + (Number(l.sgst_amount)    || 0),
    igst_amount:    acc.igst_amount    + (Number(l.igst_amount)    || 0),
    total_qty:      acc.total_qty      + (Number(l.qty)            || 0),
  }), { taxable_amount: 0, cgst_amount: 0, sgst_amount: 0, igst_amount: 0, total_qty: 0 })
  // Lines are each already 2dp, but summing many of them in JS floating point
  // can leave a tiny residue (e.g. 8784284.829999999) — round2() cleans that
  // up. Rounding off to a whole rupee happens exactly once, here, on the
  // final invoice/PI/PO total (GST Rule 46) — never per line.
  const taxable_amount = round2(sum.taxable_amount)
  const cgst_amount    = round2(sum.cgst_amount)
  const sgst_amount    = round2(sum.sgst_amount)
  const igst_amount    = round2(sum.igst_amount)
  const subtotal       = round2(taxable_amount + cgst_amount + sgst_amount + igst_amount)
  const hasOverride = roundOffOverride !== '' && roundOffOverride !== null && roundOffOverride !== undefined && !isNaN(Number(roundOffOverride))
  const round_off_amount = hasOverride ? round2(Number(roundOffOverride)) : round2(roundRupees(subtotal) - subtotal)
  const total_amount     = hasOverride ? round2(subtotal + round_off_amount) : roundRupees(subtotal)
  // NOTE: `subtotal` is deliberately not included below — this object gets
  // spread directly into PI/PO/Invoice insert/update payloads, and none of
  // those tables have a `subtotal` column (only total_amount/round_off_amount
  // do). TotalsBar derives it back as total_amount - round_off_amount.
  // total_qty is round2()'d — summing fractional quantities in floating
  // point leaves residue (16680.000000000004) that otherwise gets stored
  // and displayed verbatim.
  return { taxable_amount, cgst_amount, sgst_amount, igst_amount, round_off_amount, total_amount, total_qty: round2(sum.total_qty) }
}

function TotalsBar({ totals, interstate, roundOffOverride, onRoundOffOverrideChange }) {
  if (!totals || totals.total_amount === 0) return null
  const editableRoundOff = typeof onRoundOffOverrideChange === 'function'
  return (
    <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '8px', padding: '10px 18px', minWidth: '260px' }}>
      <TotRow label='Total Qty' val={formatQty(totals.total_qty)} />
      <TotRow label='Taxable Amount' val={formatINR(totals.taxable_amount)} />
      {interstate
        ? <TotRow label='IGST' val={formatINR(totals.igst_amount)} />
        : <>
            <TotRow label='CGST' val={formatINR(totals.cgst_amount)} />
            <TotRow label='SGST' val={formatINR(totals.sgst_amount)} />
          </>
      }
      <TotRow label='Total' val={formatINR(totals.total_amount - totals.round_off_amount)} />
      {editableRoundOff ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', color: C.textSoft, marginBottom: '5px', gap: '8px' }}>
          <span>
            Round Off
            {roundOffOverride !== '' && roundOffOverride != null && (
              <span title='Manually overridden — clear the box to auto-calculate again' style={{ color: '#c0820a', marginLeft: '4px' }}>✎</span>
            )}
          </span>
          <input
            type='number' step='0.01'
            value={roundOffOverride ?? ''}
            onChange={e => onRoundOffOverrideChange(e.target.value)}
            placeholder={totals.round_off_amount.toFixed(2)}
            style={{ width: '86px', textAlign: 'right', padding: '2px 6px', border: `1px solid ${C.border}`, borderRadius: '4px', fontSize: '12px', fontFamily: 'inherit', background: '#fffdf6' }}
          />
        </div>
      ) : (
        <TotRow label='Round Off' val={formatINR(totals.round_off_amount)} />
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: '15px', color: C.text, paddingTop: '6px', marginTop: '4px', borderTop: `1px solid ${C.border}` }}>
        <span>Final Amount</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatINR(totals.total_amount)}</span>
      </div>
    </div>
  )
}

// CHANGED: searchable product picker — the old plain <select> forced
// scrolling an alphabetical list of thousands of products. Type to filter by
// name or HSN; each option shows HSN + default rate so duplicate-named
// products (a real, supported case — same name at different rates) can be
// told apart. Capped at 50 visible matches; narrowing the search surfaces
// the rest.
const PICKER_MAX_RESULTS = 50
export function ProductPicker({ products, value, onSelect, inp = { padding: '7px 9px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: '#fffdf6', fontSize: '13px', width: '100%', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' } }) {
  const [query, setQuery] = useState(null) // null = idle (show selected name); string = actively searching
  const [open, setOpen] = useState(false)
  const selected = value ? products.find(p => p.id === value) : null
  const display = query !== null ? query : (selected?.name || '')
  const q = (query || '').trim().toLowerCase()
  const allMatches = q
    ? products.filter(p => (p.name || '').toLowerCase().includes(q) || (p.hsn_code || '').toLowerCase().includes(q))
    : products
  const matches = allMatches.slice(0, PICKER_MAX_RESULTS)
  function choose(id) { onSelect(id); setOpen(false); setQuery(null) }
  return (
    <div style={{ position: 'relative', marginBottom: '4px' }}>
      <input
        value={display}
        placeholder='🔍 Search product…'
        onFocus={() => { setOpen(true); setQuery('') }}
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onBlur={() => setTimeout(() => { setOpen(false); setQuery(null) }, 150)}
        onKeyDown={e => { if (e.key === 'Enter' && matches.length === 1) { e.preventDefault(); choose(matches[0].id) } if (e.key === 'Escape') { setOpen(false); setQuery(null); e.currentTarget.blur() } }}
        style={{ ...inp, fontStyle: selected || query !== null ? 'normal' : 'italic' }}
      />
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, minWidth: '100%', width: 'max-content', maxWidth: '340px', zIndex: 30, background: '#fffdf6', border: `1px solid ${C.border}`, borderRadius: '6px', maxHeight: '240px', overflowY: 'auto', boxShadow: '0 4px 14px rgba(60,45,20,0.18)' }}>
          {value && (
            <div onMouseDown={e => { e.preventDefault(); choose('') }}
              style={{ padding: '6px 9px', fontSize: '11px', color: C.danger, cursor: 'pointer', borderBottom: `1px solid ${C.border}` }}>
              ✕ Clear selected product
            </div>
          )}
          {matches.length === 0 && (
            <div style={{ padding: '8px 9px', fontSize: '12px', color: C.textMuted }}>No products match "{query}"</div>
          )}
          {matches.map(p => (
            <div key={p.id}
              onMouseDown={e => { e.preventDefault(); choose(p.id) }}
              style={{ padding: '6px 9px', cursor: 'pointer', fontSize: '12px', background: p.id === value ? '#f0e8d8' : 'transparent', borderBottom: '1px solid #f5efe2' }}
              onMouseEnter={e => { e.currentTarget.style.background = '#f5efe2' }}
              onMouseLeave={e => { e.currentTarget.style.background = p.id === value ? '#f0e8d8' : 'transparent' }}>
              <div style={{ fontWeight: 600, lineHeight: 1.3 }}>{p.name}</div>
              <div style={{ fontSize: '10px', color: C.textMuted, fontFamily: 'monospace' }}>
                {p.hsn_code || 'no HSN'}{p.default_rate != null ? ` · ₹${p.default_rate}` : ''}{p.unit ? ` · ${p.unit}` : ''}
              </div>
            </div>
          ))}
          {allMatches.length > PICKER_MAX_RESULTS && (
            <div style={{ padding: '6px 9px', fontSize: '11px', color: C.textMuted, borderTop: `1px solid ${C.border}` }}>
              Showing first {PICKER_MAX_RESULTS} of {allMatches.length} — keep typing to narrow down
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * LineItemsEditor
 *
 * Props:
 *   lines      - array of line objects
 *   setLines   - setter
 *   interstate - boolean
 *   products   - optional product list
 *   hsnMap     - Map from buildHSNMap()
 *   asOfDate   - the parent document's own date (invoice_date/pi_date/po_date/note_date) —
 *                HSN rates are resolved as of this date, not "today", so a document dated
 *                for an earlier period keeps the rate that was actually in force back then.
 *   readOnly   - boolean
 *   showMargin - boolean — show Margin % column + apply-all control
 *   stockMap   - Map<product_id, availableQty> — for shortfall warnings
 *
 * Margin workflow:
 *   _cost_rate  = locked purchase price (from previous leg PI via copy, or snapshotted on
 *                 first margin entry). Never overwritten once set.
 *   _margin_pct = raw input string — kept as string so "-" and "-1" can be typed freely.
 *                 Parsed to number only for calculation.
 *   rate        = computed sell price = _cost_rate × (1 + _margin_pct/100).
 *                 Supports negative margin (selling below cost).
 */
// CHANGED: large real documents (a PI moving an entire ~1000-product catalog
// in one go, for example) used to freeze the tab solid when edited — every
// line renders several controlled inputs plus live HSN/margin computation,
// and mounting 1000+ of those at once is more synchronous render work than
// a browser tab can do without blocking. Above VIRTUALIZE_THRESHOLD lines,
// only the rows actually scrolled into view (plus a small overscan buffer)
// are mounted; the rest are represented by two spacer rows so the scrollbar
// still reflects the true list length. Below the threshold, rendering is
// completely unchanged. ROW_HEIGHT is an estimate (real rows vary slightly
// with badges like the stock-shortfall/HSN-override warnings) — good enough
// for scroll math, not pixel-perfect.
const VIRTUALIZE_THRESHOLD = 100
const ROW_HEIGHT = 56
const OVERSCAN = 15
const VIEWPORT_HEIGHT = 600

export default function LineItemsEditor({ lines, setLines, interstate, products = [], hsnMap, asOfDate, readOnly, showMargin = false, stockMap, roundOffOverride = '', onRoundOffOverrideChange }) {

  const [applyMarginPct, setApplyMarginPct] = useState('')
  const [scrollTop, setScrollTop] = useState(0)

  function addLine() {
    setLines(prev => [...prev, {
      _id: Date.now(), line_no: prev.length + 1,
      product_id: '', description: '', hsn_code: '',
      qty: '', unit: 'Nos', rate: '', gst_rate: 18,
      taxable_amount: 0, cgst_rate: 0, cgst_amount: 0,
      sgst_rate: 0, sgst_amount: 0, igst_rate: 0, igst_amount: 0, total_amount: 0,
      _hsn_resolved_rate: null, _hsn_override: false, _hsn_manually_set: false,
      _cost_rate: null,   // locked purchase price — set once, never overwritten
      _margin_pct: '',    // FIX: string so partial input like "-" or "-1" works freely
    }])
  }

  function removeLine(idx) {
    setLines(prev => prev.filter((_, i) => i !== idx).map((l, i) => ({ ...l, line_no: i + 1 })))
  }

  function updateLine(idx, key, val) {
    setLines(prev => {
      const next    = [...prev]
      let updated   = { ...next[idx], [key]: val }

      if (key === 'gst_rate') {
        updated._hsn_manually_set = true
        updated._hsn_override = updated._hsn_resolved_rate !== null && Number(val) !== updated._hsn_resolved_rate
        next[idx] = computeLine(updated, interstate)
        return next
      }

      if (key === 'hsn_code' || key === 'rate') {
        const rateForLookup = key === 'rate' ? toNum(val) : toNum(updated.rate)
        const hsnForLookup  = key === 'hsn_code' ? val : updated.hsn_code
        const { gst_rate, source } = hsnMap
          ? resolveGSTRate(hsnForLookup, rateForLookup, hsnMap, asOfDate)
          : { gst_rate: null, source: 'default' }

        if (gst_rate !== null) {
          if (!updated._hsn_manually_set) updated.gst_rate = gst_rate
          updated._hsn_resolved_rate = gst_rate
          updated._hsn_source = source
          updated._hsn_override = updated._hsn_manually_set && Number(updated.gst_rate) !== gst_rate
        } else {
          updated._hsn_resolved_rate = null
          updated._hsn_override = false
          if (key === 'hsn_code' && !val) updated._hsn_manually_set = false
        }

        // When user edits rate directly:
        // - If cost is not locked yet: leave _cost_rate null (no margin mode yet)
        // - If cost IS locked: recalculate implied margin % and update display
        if (key === 'rate' && updated._cost_rate !== null && updated._cost_rate > 0) {
          const newRate = toNum(val)
          updated._margin_pct = newRate > 0
            ? String(calcMarginPct(updated._cost_rate, newRate).toFixed(2))
            : ''
        }

        next[idx] = computeLine(updated, interstate)
        return next
      }

      next[idx] = computeLine(updated, interstate)
      return next
    })
  }

  // FIX: Keep raw string in _margin_pct so the user can type freely (including "-", "-1.", etc.)
  // Only compute a new sell rate when the string is a valid, complete number.
  function updateLineMargin(idx, rawStr) {
    setLines(prev => {
      const next = [...prev]
      const line = next[idx]

      // FIX: Lock cost basis from CURRENT rate the first time margin is entered.
      // _cost_rate is set once here and never changed again — it's always the purchase price.
      const currentRate = toNum(line.rate)
      const costRate = (line._cost_rate !== null && line._cost_rate > 0)
        ? line._cost_rate
        : currentRate

      // Always store the raw string so the input field reflects what was typed
      // (this allows typing "-", "-1", "-10" without intermediate NaN blanking)
      let updated = { ...line, _margin_pct: rawStr, _cost_rate: costRate }

      // Only compute new rate when the string is a valid complete number
      const pct = parseFloat(rawStr)
      if (!isNaN(pct) && rawStr !== '' && rawStr !== '-') {
        if (costRate > 0) {
          const newRate = calcSellRate(costRate, pct)

          // Negative margin guard: sell rate cannot go to 0 or below
          if (newRate > 0) {
            updated.rate = newRate

            // Re-evaluate HSN at new rate
            if (hsnMap && updated.hsn_code) {
              const { gst_rate, source } = resolveGSTRate(updated.hsn_code, newRate, hsnMap, asOfDate)
              if (gst_rate !== null) {
                updated.gst_rate = gst_rate
                updated._hsn_resolved_rate = gst_rate
                updated._hsn_source = source
                updated._hsn_override = false
                updated._hsn_manually_set = false
              }
            }
          }
        }
        updated = computeLine(updated, interstate)
      } else {
        // Partial input like "-" or "" — just store it without recomputing
        next[idx] = updated
        return next
      }

      next[idx] = updated
      return next
    })
  }

  // Apply margin to all lines at once
  function handleApplyMarginToAll() {
    const pct = parseFloat(applyMarginPct)
    if (isNaN(pct)) return
    setLines(prev => prev.map(line => {
      const currentRate = toNum(line.rate)
      const costRate = (line._cost_rate !== null && line._cost_rate > 0)
        ? line._cost_rate
        : currentRate
      if (!costRate) return line

      const newRate = calcSellRate(costRate, pct)
      if (newRate <= 0) return line // skip if negative sell price

      let updated = {
        ...line,
        rate: newRate,
        _cost_rate: costRate,
        _margin_pct: String(pct),
        _hsn_manually_set: false,
      }
      if (hsnMap && updated.hsn_code) {
        const { gst_rate, source } = resolveGSTRate(updated.hsn_code, newRate, hsnMap, asOfDate)
        if (gst_rate !== null) {
          updated.gst_rate = gst_rate
          updated._hsn_resolved_rate = gst_rate
          updated._hsn_source = source
          updated._hsn_override = false
        }
      }
      return computeLine(updated, interstate)
    }))
  }

  function onProductSelect(idx, productId) {
    const p = products.find(p => p.id === productId)
    if (!p) { updateLine(idx, 'product_id', productId); return }
    setLines(prev => {
      const next    = [...prev]
      const updated = {
        ...next[idx],
        product_id: p.id, description: p.name,
        hsn_code: p.hsn_code || '', unit: p.unit || 'Nos',
        rate: p.default_rate != null ? String(p.default_rate) : '',
        _hsn_manually_set: false,
        _cost_rate: null, _margin_pct: '', // reset cost lock when product changes
      }
      const { gst_rate, source } = hsnMap
        ? resolveGSTRate(updated.hsn_code, toNum(updated.rate), hsnMap, asOfDate)
        : { gst_rate: null }
      if (gst_rate !== null) {
        updated.gst_rate = gst_rate
        updated._hsn_resolved_rate = gst_rate
        updated._hsn_source = source
      } else {
        updated.gst_rate = p.gst_rate || 18
        updated._hsn_resolved_rate = null
      }
      next[idx] = computeLine(updated, interstate)
      return next
    })
  }

  const totals = computeTotals(lines, roundOffOverride)

  const th = { padding: '8px 10px', fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em', background: C.bg, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }
  const td  = { padding: '6px 8px', borderBottom: `1px solid #f0e8d8`, verticalAlign: 'top' }
  const inp = { padding: '5px 7px', border: `1px solid ${C.border}`, borderRadius: '4px', background: '#fffdf6', fontSize: '12px', width: '100%', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }

  const isVirtualized = !readOnly && lines.length > VIRTUALIZE_THRESHOLD
  const startIdx = isVirtualized ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0
  const endIdx   = isVirtualized ? Math.min(lines.length, Math.ceil((scrollTop + VIEWPORT_HEIGHT) / ROW_HEIGHT) + OVERSCAN) : lines.length
  const visibleLines = isVirtualized ? lines.slice(startIdx, endIdx) : lines
  const colCount = 10 + (showMargin ? 1 : 0) + (!readOnly ? 1 : 0)

  return (
    <div>
      {lines.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px', gap: '12px', flexWrap: 'wrap' }}>
          {!readOnly && showMargin && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#fffbf0', border: `1px solid #e6c040`, borderRadius: '7px', padding: '8px 14px' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: C.textMid }}>Apply to all lines:</span>
              <input
                type='number'
                value={applyMarginPct}
                onChange={e => setApplyMarginPct(e.target.value)}
                placeholder='e.g. -5 or 10'
                style={{ ...inp, width: '90px', textAlign: 'right' }}
              />
              <span style={{ fontSize: '12px', color: C.textSoft }}>%</span>
              <Btn size='sm' onClick={handleApplyMarginToAll}>Apply</Btn>
              <span style={{ fontSize: '11px', color: C.textMuted }}>Positive or negative. HSN re-evaluated.</span>
            </div>
          )}
          <div style={{ marginLeft: 'auto' }}>
            <TotalsBar totals={totals} interstate={interstate} roundOffOverride={roundOffOverride} onRoundOffOverrideChange={!readOnly ? onRoundOffOverrideChange : undefined} />
          </div>
        </div>
      )}

      {isVirtualized && (
        <div style={{ fontSize: '11px', color: C.textMuted, marginBottom: '6px' }}>
          {lines.length} lines — scrolling renders rows on demand to keep this responsive.
        </div>
      )}
      <div
        style={{
          overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: '8px',
          ...(isVirtualized ? { overflowY: 'auto', maxHeight: `${VIEWPORT_HEIGHT}px` } : {}),
        }}
        onScroll={isVirtualized ? e => setScrollTop(e.currentTarget.scrollTop) : undefined}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: showMargin ? '1040px' : '860px' }}>
          <thead>
            <tr>
              <th style={{ ...th, width: '28px' }}>#</th>
              <th style={{ ...th, minWidth: '160px' }}>Description</th>
              <th style={{ ...th, width: '90px' }}>HSN</th>
              <th style={{ ...th, width: '80px' }}>Qty</th>
              <th style={{ ...th, width: '65px' }}>Unit</th>
              <th style={{ ...th, width: '130px' }}>
                Rate (₹)
                {showMargin && !readOnly && <div style={{ fontSize: '9px', fontWeight: 400, color: C.textMuted, textTransform: 'none', letterSpacing: 0 }}>sell price</div>}
              </th>
              {showMargin && (
                <th style={{ ...th, width: '100px' }}>
                  Margin %
                  <div style={{ fontSize: '9px', fontWeight: 400, color: C.textMuted, textTransform: 'none', letterSpacing: 0 }}>vs purchase</div>
                </th>
              )}
              <th style={{ ...th, width: '80px' }}>GST %</th>
              <th style={{ ...th, textAlign: 'right', width: '110px' }}>Taxable</th>
              <th style={{ ...th, textAlign: 'right', width: '100px' }}>Tax</th>
              <th style={{ ...th, textAlign: 'right', width: '115px' }}>Total</th>
              {!readOnly && <th style={{ ...th, width: '32px' }}></th>}
            </tr>
          </thead>
          <tbody>
            {isVirtualized && startIdx > 0 && (
              <tr><td colSpan={colCount} style={{ padding: 0, border: 'none', height: `${startIdx * ROW_HEIGHT}px` }} /></tr>
            )}
            {visibleLines.map((line, i) => {
              const idx = startIdx + i
              const isOverride = line._hsn_override
              const lineQty    = toNum(line.qty)
              const availQty   = stockMap && line.product_id ? (stockMap[line.product_id] ?? null) : null
              const isShort    = availQty !== null && lineQty > availQty

              // Determine margin display colour
              const marginNum = parseFloat(line._margin_pct)
              const marginColor = isNaN(marginNum) ? C.textMuted
                : marginNum > 0  ? '#1a5c30'
                : marginNum < 0  ? C.danger
                : C.textMuted

              return (
                <tr key={line._id || idx} style={{ background: idx % 2 === 0 ? '#fffdf6' : '#faf6ed' }}>

                  <td style={{ ...td, textAlign: 'center', color: C.textMuted, fontSize: '11px' }}>{idx + 1}</td>

                  <td style={td}>
                    {products.length > 0 && !readOnly && (
                      <ProductPicker products={products} value={line.product_id || ''} onSelect={id => onProductSelect(idx, id)} inp={inp} />
                    )}
                    {readOnly
                      ? <span style={{ fontSize: '12px' }}>{line.description}</span>
                      : <input value={line.description} onChange={e => updateLine(idx, 'description', e.target.value)} placeholder='Description' style={inp} />
                    }
                  </td>

                  <td style={td}>
                    {readOnly
                      ? <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{line.hsn_code || '—'}</span>
                      : <input value={line.hsn_code} onChange={e => updateLine(idx, 'hsn_code', e.target.value)} placeholder='HSN' style={{ ...inp, fontFamily: 'monospace' }} />
                    }
                    {!readOnly && line._hsn_resolved_rate !== null && !isOverride && (
                      <div style={{ marginTop: '3px', fontSize: '10px', fontWeight: 600, color: '#1a5c30', background: '#e8f3ec', padding: '1px 5px', borderRadius: '3px', display: 'inline-block' }}>
                        🔒 {line._hsn_source === 'hsn_fixed' ? 'HSN fixed' : 'HSN slab'}
                      </div>
                    )}
                  </td>

                  <td style={td}>
                    {readOnly
                      ? <span style={{ fontSize: '12px' }}>{formatQty(line.qty)}</span>
                      : <input type='number' value={line.qty} onChange={e => updateLine(idx, 'qty', e.target.value)}
                          style={{ ...inp, textAlign: 'right', borderColor: isShort ? '#c0820a' : C.border, background: isShort ? '#fff8e8' : '#fffdf6' }} />
                    }
                    {isShort && !readOnly && (
                      <div style={{ fontSize: '10px', fontWeight: 600, color: '#7a5000', background: '#fff3cc', border: '1px solid #e6c040', padding: '2px 5px', borderRadius: '3px', marginTop: '3px', lineHeight: 1.3 }}>
                        ⚠ Stock: {availQty} {line.unit || ''}
                      </div>
                    )}
                  </td>

                  <td style={td}>
                    {readOnly
                      ? <span style={{ fontSize: '12px' }}>{line.unit}</span>
                      : <select value={line.unit} onChange={e => updateLine(idx, 'unit', e.target.value)} style={inp}>
                          {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                        </select>
                    }
                  </td>

                  {/* Rate — shows sell price; cost shown below when locked */}
                  <td style={td}>
                    {readOnly
                      ? <span style={{ fontSize: '12px' }}>{formatINR(line.rate)}</span>
                      : <input type='number' value={line.rate} onChange={e => updateLine(idx, 'rate', e.target.value)} placeholder='0' style={{ ...inp, textAlign: 'right' }} />
                    }
                    {showMargin && line._cost_rate !== null && line._cost_rate > 0 && (
                      <div style={{ fontSize: '10px', color: C.textMuted, marginTop: '2px' }}>
                        Purchase: {formatINR(line._cost_rate)}
                      </div>
                    )}
                  </td>

                  {/* Margin % — free text input, supports negative */}
                  {showMargin && (
                    <td style={td}>
                      {readOnly
                        ? (
                          <span style={{ fontSize: '12px', fontWeight: 600, color: marginColor }}>
                            {line._margin_pct !== '' && line._margin_pct != null
                              ? `${parseFloat(line._margin_pct) >= 0 ? '+' : ''}${parseFloat(line._margin_pct).toFixed(1)}%`
                              : '—'}
                          </span>
                        )
                        : (
                          <>
                            {/* FIX: text input (not number) so "-" can be typed without being swallowed */}
                            <input
                              type='text'
                              inputMode='decimal'
                              value={line._margin_pct != null ? line._margin_pct : ''}
                              onChange={e => updateLineMargin(idx, e.target.value)}
                              placeholder='e.g. 5 or -3'
                              style={{
                                ...inp,
                                textAlign: 'right',
                                width: '80px',
                                color: marginColor,
                                fontWeight: isNaN(parseFloat(line._margin_pct)) ? undefined : 600,
                              }}
                            />
                            {/* Show computed sell rate below when cost is locked */}
                            {line._cost_rate !== null && line._cost_rate > 0 && !isNaN(parseFloat(line._margin_pct)) && parseFloat(line._margin_pct) !== 0 && (
                              <div style={{ fontSize: '10px', color: marginColor, marginTop: '2px', fontWeight: 600 }}>
                                → {formatINR(toNum(line.rate))}
                              </div>
                            )}
                          </>
                        )
                      }
                    </td>
                  )}

                  <td style={td}>
                    {readOnly
                      ? <span style={{ fontSize: '12px' }}>{line.gst_rate}%</span>
                      : <>
                          <select value={line.gst_rate} onChange={e => updateLine(idx, 'gst_rate', Number(e.target.value))}
                            style={{ ...inp, borderColor: isOverride ? '#c0820a' : C.border, background: isOverride ? '#fffbf0' : '#fffdf6' }}>
                            {![0,3,5,12,18,28].includes(Number(line.gst_rate)) && <option value={line.gst_rate}>{line.gst_rate}%</option>}
                            {GST_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                          </select>
                          {isOverride && (
                            <div style={{ marginTop: '3px', fontSize: '10px', fontWeight: 600, color: '#7a5000', background: '#fff3cc', border: '1px solid #e6c040', padding: '2px 5px', borderRadius: '3px', lineHeight: 1.3 }}>
                              ⚠️ Override — HSN says {line._hsn_resolved_rate}%
                            </div>
                          )}
                        </>
                    }
                  </td>

                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: '12px', color: C.textMid }}>
                    {formatINR(line.taxable_amount)}
                  </td>

                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: '12px', color: C.textSoft }}>
                    {interstate
                      ? <span title={`IGST ${line.igst_rate}%`}>{formatINR(line.igst_amount)}</span>
                      : <span title={`CGST ${line.cgst_rate}% + SGST ${line.sgst_rate}%`}>{formatINR((line.cgst_amount || 0) + (line.sgst_amount || 0))}</span>
                    }
                  </td>

                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, fontSize: '13px' }}>
                    {formatINR(line.total_amount)}
                  </td>

                  {!readOnly && (
                    <td style={{ ...td, textAlign: 'center' }}>
                      <button onClick={() => removeLine(idx)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.danger, fontSize: '16px', padding: '2px 6px' }}>×</button>
                    </td>
                  )}
                </tr>
              )
            })}
            {isVirtualized && endIdx < lines.length && (
              <tr><td colSpan={colCount} style={{ padding: 0, border: 'none', height: `${(lines.length - endIdx) * ROW_HEIGHT}px` }} /></tr>
            )}
          </tbody>
        </table>
      </div>

      {!readOnly && (
        <div style={{ marginTop: '8px' }}>
          <Btn size='sm' variant='ghost' onClick={addLine}>+ Add Line</Btn>
        </div>
      )}

      {lines.length > 0 && (
        <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'flex-end' }}>
          <TotalsBar totals={totals} interstate={interstate} roundOffOverride={roundOffOverride} onRoundOffOverrideChange={!readOnly ? onRoundOffOverrideChange : undefined} />
        </div>
      )}
    </div>
  )
}

function TotRow({ label, val }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: C.textSoft, marginBottom: '5px' }}>
      <span>{label}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{val}</span>
    </div>
  )
}
