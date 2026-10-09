// Entity form → Document Numbering.
//
// One row per document type (Sales Invoice, Purchase Order, Proforma Invoice,
// Service Invoice). Switching a row on gives that document its own number
// format for this entity; leaving it off keeps the standard numbering
// (SHORTNAME-2627-001). The example on the right shows the first number the
// format would produce. Stored in entities.numbering — see utils/numbering.js.
import { C, Input, Select } from './UI/index'
import { NUMBERED_DOCS, FY_FORMATS, effectiveFormat, formatDocNo } from '../utils/numbering'
import { today } from '../utils/dates'

export default function NumberingSettings({ value, onChange, shortName }) {
  const set = (docKey, patch) => onChange({ ...(value || {}), [docKey]: { ...(value?.[docKey] || { enabled: false }), ...patch } })
  const lbl = { fontSize: '10px', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '3px' }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {NUMBERED_DOCS.map(d => {
        const f = effectiveFormat(value, d.key, shortName)
        return (
          <div key={d.key} style={{ border: `1px solid ${C.border}`, borderRadius: '6px', padding: '10px 12px', background: f.enabled ? C.surface : C.bg }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', minWidth: '170px' }}>
                <input type='checkbox' checked={!!f.enabled} onChange={e => set(d.key, { enabled: e.target.checked })} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                {d.label}
              </label>
              <span style={{ fontSize: '12px', color: C.textSoft }}>
                {f.enabled ? <>Next number looks like <b style={{ fontFamily: 'monospace', color: C.text }}>{formatDocNo(f, today(), f.start)}</b></> : 'Standard numbering'}
              </span>
            </div>
            {f.enabled && (
              <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 0.6fr 0.8fr 0.7fr 0.8fr', gap: '8px', marginTop: '10px', alignItems: 'end' }}>
                <div><div style={lbl}>Prefix</div><Input value={f.prefix} onChange={e => set(d.key, { prefix: e.target.value })} /></div>
                <div><div style={lbl}>Financial year</div>
                  <Select value={f.fy_format} onChange={e => set(d.key, { fy_format: e.target.value })}>
                    {FY_FORMATS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                </div>
                <div><div style={lbl}>Separator</div>
                  <Select value={f.separator} onChange={e => set(d.key, { separator: e.target.value })}>
                    <option value='/'>/</option><option value='-'>-</option><option value=''>none</option>
                  </Select>
                </div>
                <div><div style={lbl}>Start at</div><Input type='number' value={f.start} onChange={e => set(d.key, { start: e.target.value })} /></div>
                <div><div style={lbl}>Digits</div>
                  <Select value={String(f.padding)} onChange={e => set(d.key, { padding: Number(e.target.value) })}>
                    {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n}</option>)}
                  </Select>
                </div>
                <div><div style={lbl}>Suffix</div><Input value={f.suffix} onChange={e => set(d.key, { suffix: e.target.value })} placeholder='optional' /></div>
                <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: C.textSoft, cursor: 'pointer' }}>
                  <input type='checkbox' checked={f.reset_each_fy !== false} disabled={f.fy_format === 'none'} onChange={e => set(d.key, { reset_each_fy: e.target.checked })} style={{ width: '13px', height: '13px' }} />
                  Start again from {f.start || 1} every financial year
                </label>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
