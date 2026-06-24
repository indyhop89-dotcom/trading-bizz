import { C, Btn } from './UI/index'
import { formatINR, toNum, round2, roundRupees } from '../utils/money'
import { calcLineTax } from '../utils/tax'
import { resolveGSTRate } from '../utils/hsn'

const GST_RATES = [0, 3, 5, 12, 18, 28]
const UNITS     = ['Nos', 'Kg', 'Pcs', 'Box', 'Mtr', 'Ltr', 'Set']

/**
 * Compute a single line's amounts — all in rupees, final amounts whole rupees.
 *
 * line.rate  = rupees per unit (numeric, may have 2dp e.g. 250.50)
 * line.qty   = quantity (may have 3dp e.g. 10.500)
 *
 * taxable_amount = round2(qty × rate)          — kept 2dp for accuracy
 * gst amounts   = roundRupees(taxable × rate%) — whole rupee
 * total_amount  = taxable + tax                 — whole rupee
 */
export function computeLine(line, interstate) {
  const qty      = Number(line.qty)  || 0
  const rate     = Number(line.rate) || 0
  const taxable  = round2(qty * rate)
  const tax      = calcLineTax(taxable, line.gst_rate, interstate)
  return {
    ...line,
    taxable_amount: roundRupees(taxable),
    ...tax,
    total_amount: roundRupees(taxable) + tax.total_tax,
  }
}

/** Sum totals across computed lines */
export function computeTotals(lines) {
  return lines.reduce((acc, l) => ({
    taxable_amount: acc.taxable_amount + (Number(l.taxable_amount) || 0),
    cgst_amount:    acc.cgst_amount    + (Number(l.cgst_amount)    || 0),
    sgst_amount:    acc.sgst_amount    + (Number(l.sgst_amount)    || 0),
    igst_amount:    acc.igst_amount    + (Number(l.igst_amount)    || 0),
    total_amount:   acc.total_amount   + (Number(l.total_amount)   || 0),
  }), { taxable_amount: 0, cgst_amount: 0, sgst_amount: 0, igst_amount: 0, total_amount: 0 })
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
 *   readOnly   - boolean
 *
 * All monetary values (rate, taxable_amount, total_amount etc.) are plain rupees.
 * No paise anywhere.
 */
export default function LineItemsEditor({ lines, setLines, interstate, products = [], hsnMap, readOnly }) {

  function addLine() {
    setLines(prev => [...prev, {
      _id:         Date.now(),
      line_no:     prev.length + 1,
      product_id:  '', description: '', hsn_code: '',
      qty:         '', unit: 'Nos',
      rate:        '',          // rupees, typed directly
      gst_rate:    18,
      taxable_amount: 0,
      cgst_rate: 0, cgst_amount: 0,
      sgst_rate: 0, sgst_amount: 0,
      igst_rate: 0, igst_amount: 0,
      total_amount: 0,
      _hsn_resolved_rate: null,
      _hsn_override:      false,
      _hsn_manually_set:  false,
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
        const resolved = updated._hsn_resolved_rate
        updated._hsn_override = resolved !== null && Number(val) !== resolved
        next[idx] = computeLine(updated, interstate)
        return next
      }

      if (key === 'hsn_code' || key === 'rate') {
        const rateForLookup = key === 'rate' ? toNum(val) : toNum(updated.rate)
        const hsnForLookup  = key === 'hsn_code' ? val : updated.hsn_code

        const { gst_rate, source } = hsnMap
          ? resolveGSTRate(hsnForLookup, rateForLookup, hsnMap)
          : { gst_rate: null, source: 'default' }

        if (gst_rate !== null) {
          if (!updated._hsn_manually_set) updated.gst_rate = gst_rate
          updated._hsn_resolved_rate = gst_rate
          updated._hsn_source        = source
          updated._hsn_override      = updated._hsn_manually_set && Number(updated.gst_rate) !== gst_rate
        } else {
          updated._hsn_resolved_rate = null
          updated._hsn_override      = false
          if (key === 'hsn_code' && !val) updated._hsn_manually_set = false
        }

        next[idx] = computeLine(updated, interstate)
        return next
      }

      next[idx] = computeLine(updated, interstate)
      return next
    })
  }

  function onProductSelect(idx, productId) {
    const p = products.find(p => p.id === productId)
    if (!p) { updateLine(idx, 'product_id', productId); return }

    setLines(prev => {
      const next    = [...prev]
      const updated = {
        ...next[idx],
        product_id:        p.id,
        description:       p.name,
        hsn_code:          p.hsn_code || '',
        unit:              p.unit || 'Nos',
        rate:              p.default_rate != null ? String(p.default_rate) : '',
        _hsn_manually_set: false,
      }

      const { gst_rate, source } = hsnMap
        ? resolveGSTRate(updated.hsn_code, toNum(updated.rate), hsnMap)
        : { gst_rate: null }

      if (gst_rate !== null) {
        updated.gst_rate           = gst_rate
        updated._hsn_resolved_rate = gst_rate
        updated._hsn_source        = source
      } else {
        updated.gst_rate           = p.gst_rate || 18
        updated._hsn_resolved_rate = null
      }

      next[idx] = computeLine(updated, interstate)
      return next
    })
  }

  const totals = computeTotals(lines)

  // ── styles ────────────────────────────────────────────────────────────────
  const th = {
    padding: '8px 10px', fontSize: '11px', fontWeight: 700, color: C.textSoft,
    textTransform: 'uppercase', letterSpacing: '0.04em',
    background: C.bg, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap',
  }
  const td = { padding: '6px 8px', borderBottom: `1px solid #f0e8d8`, verticalAlign: 'top' }
  const inp = {
    padding: '5px 7px', border: `1px solid ${C.border}`, borderRadius: '4px',
    background: '#fffdf6', fontSize: '12px', width: '100%',
    fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
  }

  return (
    <div>
      <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: '8px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '860px' }}>
          <thead>
            <tr>
              <th style={{ ...th, width: '28px' }}>#</th>
              <th style={{ ...th, minWidth: '160px' }}>Description</th>
              <th style={{ ...th, width: '90px' }}>HSN</th>
              <th style={{ ...th, width: '80px' }}>Qty</th>
              <th style={{ ...th, width: '65px' }}>Unit</th>
              <th style={{ ...th, width: '110px' }}>Rate (₹)</th>
              <th style={{ ...th, width: '80px' }}>GST %</th>
              <th style={{ ...th, textAlign: 'right', width: '110px' }}>Taxable</th>
              <th style={{ ...th, textAlign: 'right', width: '100px' }}>Tax</th>
              <th style={{ ...th, textAlign: 'right', width: '115px' }}>Total</th>
              {!readOnly && <th style={{ ...th, width: '32px' }}></th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((line, idx) => {
              const hasHSN     = !!line._hsn_resolved_rate
              const isOverride = line._hsn_override

              return (
                <tr key={line._id || idx} style={{ background: idx % 2 === 0 ? '#fffdf6' : '#faf6ed' }}>

                  {/* # */}
                  <td style={{ ...td, textAlign: 'center', color: C.textMuted, fontSize: '11px' }}>{idx + 1}</td>

                  {/* Description */}
                  <td style={td}>
                    {products.length > 0 && !readOnly && (
                      <select value={line.product_id || ''} onChange={e => onProductSelect(idx, e.target.value)}
                        style={{ ...inp, marginBottom: '4px' }}>
                        <option value=''>— product —</option>
                        {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    )}
                    {readOnly
                      ? <span style={{ fontSize: '12px' }}>{line.description}</span>
                      : <input value={line.description} onChange={e => updateLine(idx, 'description', e.target.value)}
                          placeholder='Description' style={inp} />
                    }
                  </td>

                  {/* HSN */}
                  <td style={td}>
                    {readOnly
                      ? <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{line.hsn_code || '—'}</span>
                      : <input value={line.hsn_code} onChange={e => updateLine(idx, 'hsn_code', e.target.value)}
                          placeholder='HSN' style={{ ...inp, fontFamily: 'monospace' }} />
                    }
                    {!readOnly && hasHSN && !isOverride && (
                      <div style={{
                        marginTop: '3px', fontSize: '10px', fontWeight: 600,
                        color: '#1a5c30', background: '#e8f3ec',
                        padding: '1px 5px', borderRadius: '3px', display: 'inline-block',
                      }}>
                        🔒 {line._hsn_source === 'hsn_fixed' ? 'HSN fixed' : 'HSN slab'}
                      </div>
                    )}
                  </td>

                  {/* Qty */}
                  <td style={td}>
                    {readOnly
                      ? <span style={{ fontSize: '12px' }}>{line.qty}</span>
                      : <input type='number' value={line.qty} onChange={e => updateLine(idx, 'qty', e.target.value)}
                          style={{ ...inp, textAlign: 'right' }} />
                    }
                  </td>

                  {/* Unit */}
                  <td style={td}>
                    {readOnly
                      ? <span style={{ fontSize: '12px' }}>{line.unit}</span>
                      : <select value={line.unit} onChange={e => updateLine(idx, 'unit', e.target.value)} style={inp}>
                          {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                        </select>
                    }
                  </td>

                  {/* Rate — plain rupees */}
                  <td style={td}>
                    {readOnly
                      ? <span style={{ fontSize: '12px' }}>{formatINR(line.rate)}</span>
                      : <input type='number' value={line.rate} onChange={e => updateLine(idx, 'rate', e.target.value)}
                          placeholder='0' style={{ ...inp, textAlign: 'right' }} />
                    }
                  </td>

                  {/* GST % */}
                  <td style={td}>
                    {readOnly
                      ? <span style={{ fontSize: '12px' }}>{line.gst_rate}%</span>
                      : <>
                          <select value={line.gst_rate} onChange={e => updateLine(idx, 'gst_rate', Number(e.target.value))}
                            style={{
                              ...inp,
                              borderColor: isOverride ? '#c0820a' : C.border,
                              background:  isOverride ? '#fffbf0' : '#fffdf6',
                            }}>
                            {/* keep current value visible even if non-standard */}
                            {![0,3,5,12,18,28].includes(Number(line.gst_rate)) && (
                              <option value={line.gst_rate}>{line.gst_rate}%</option>
                            )}
                            {GST_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                          </select>
                          {isOverride && (
                            <div style={{
                              marginTop: '3px', fontSize: '10px', fontWeight: 600,
                              color: '#7a5000', background: '#fff3cc',
                              border: '1px solid #e6c040',
                              padding: '2px 5px', borderRadius: '3px', lineHeight: 1.3,
                            }}>
                              ⚠️ Override — HSN says {line._hsn_resolved_rate}%
                            </div>
                          )}
                        </>
                    }
                  </td>

                  {/* Taxable */}
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: '12px', color: C.textMid }}>
                    {formatINR(line.taxable_amount)}
                  </td>

                  {/* Tax */}
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: '12px', color: C.textSoft }}>
                    {interstate
                      ? <span title={`IGST ${line.igst_rate}%`}>{formatINR(line.igst_amount)}</span>
                      : <span title={`CGST ${line.cgst_rate}% + SGST ${line.sgst_rate}%`}>{formatINR((line.cgst_amount || 0) + (line.sgst_amount || 0))}</span>
                    }
                  </td>

                  {/* Total */}
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, fontSize: '13px' }}>
                    {formatINR(line.total_amount)}
                  </td>

                  {/* Remove */}
                  {!readOnly && (
                    <td style={{ ...td, textAlign: 'center' }}>
                      <button onClick={() => removeLine(idx)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.danger, fontSize: '16px', padding: '2px 6px' }}>
                        ×
                      </button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {!readOnly && (
        <div style={{ marginTop: '8px' }}>
          <Btn size='sm' variant='ghost' onClick={addLine}>+ Add Line</Btn>
        </div>
      )}

      {/* Totals */}
      {lines.length > 0 && (
        <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '8px', padding: '14px 20px', minWidth: '280px' }}>
            <TotRow label='Taxable Amount' val={formatINR(totals.taxable_amount)} />
            {interstate
              ? <TotRow label='IGST' val={formatINR(totals.igst_amount)} />
              : <>
                  <TotRow label='CGST' val={formatINR(totals.cgst_amount)} />
                  <TotRow label='SGST' val={formatINR(totals.sgst_amount)} />
                </>
            }
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontWeight: 700, fontSize: '15px', color: C.text,
              paddingTop: '8px', marginTop: '4px', borderTop: `1px solid ${C.border}`,
            }}>
              <span>Total</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatINR(totals.total_amount)}</span>
            </div>
          </div>
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
