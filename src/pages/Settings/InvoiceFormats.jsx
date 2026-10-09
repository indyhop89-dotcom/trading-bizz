// Settings → Invoice Formats
//
// Shows every print format available in the system (the layouts used for the
// Proforma Invoice, Purchase Order and Tax Invoice), lets you preview each
// one with any entity's details, rename it, and choose which format each
// entity uses. The formats themselves are built into the app; this screen
// only names them and assigns them (entities.document_format).
import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../../supabaseClient'
import { C, Card, Btn, Modal, Select, Input, Toast } from '../../components/UI/index'
import { useAuth } from '../../hooks/useAuth'
import { hasFullAccess } from '../../utils/roles'
import { DOCUMENT_FORMATS } from '../../utils/entityDocumentThemes'
import { ENTITY_DOC_COLUMNS, buildDocumentHTML, getDocumentStyles, resolveThemeOrThrow } from '../../utils/documentTemplate'
import { fetchFormatNames, formatName, automaticFormatKey, effectiveFormatKey, saveFormatName } from '../../utils/documentFormats'
import { getDriveViewUrl } from '../../utils/drive'
import { today } from '../../utils/dates'

const DOC_TYPES = [{ value: 'INVOICE', label: 'Tax Invoice' }, { value: 'PI', label: 'Proforma Invoice' }, { value: 'PO', label: 'Purchase Order' }]

// A made-up document used only for the preview — two lines, intra-state GST.
function sampleDoc(docType, sellerEntity) {
  const lines = [
    { description: 'Sample Product A', product_name: 'Sample Product A', hsn_code: '6109', qty: 100, unit: 'Nos', rate: 250, gst_rate: 5, taxable_amount: 25000, cgst_rate: 2.5, sgst_rate: 2.5, igst_rate: 0, cgst_amount: 625, sgst_amount: 625, igst_amount: 0, total_amount: 26250 },
    { description: 'Sample Product B', product_name: 'Sample Product B', hsn_code: '5208', qty: 40, unit: 'Mtr', rate: 180, gst_rate: 5, taxable_amount: 7200, cgst_rate: 2.5, sgst_rate: 2.5, igst_rate: 0, cgst_amount: 180, sgst_amount: 180, igst_amount: 0, total_amount: 7560 },
  ]
  return {
    docType,
    docNo: docType === 'PI' ? 'PI/26-27/0001' : docType === 'PO' ? 'PO/26-27/0001' : 'INV/26-27/0001',
    docDate: today(), validOrDueDate: today(),
    paymentTerms: '30 days', deliveryTimeline: '7 days', modeOfTransport: 'Road',
    sellerEntity,
    buyerEntity: { name: 'Sample Customer Pvt Ltd', short_name: 'Sample', address: '12 Sample Road', city: 'Bengaluru', state_name: 'Karnataka', pincode: '560001', gstin: '29AAAAA0000A1Z5', pan: 'AAAAA0000A' },
    lines,
    totals: { taxable_amount: 32200, cgst_amount: 805, sgst_amount: 805, igst_amount: 0, round_off_amount: 0, total_amount: 33810 },
    interstate: false,
    bankDetails: { bank_name: sellerEntity?.bank_name, bank_account_no: sellerEntity?.bank_account_no, bank_ifsc: sellerEntity?.bank_ifsc, bank_branch: sellerEntity?.bank_branch },
    termsAndConditions: sellerEntity?.terms_and_conditions || '',
    ...(docType === 'INVOICE' ? { ewayBill: { eway_bill_no: '1234 5678 9012', eway_bill_date: today(), vehicle_no: 'KA01AB1234', transporter_name: 'Sample Transport' } } : {}),
  }
}

export default function InvoiceFormats() {
  const { profile } = useAuth()
  const canManage = hasFullAccess(profile)
  const [entities, setEntities] = useState([])
  const [names, setNames]       = useState({})
  const [loading, setLoading]   = useState(true)
  const [loadError, setLoadError] = useState('')
  const [toast, setToast]       = useState(null)
  const [renaming, setRenaming] = useState(null)  // { key, value }
  const [savingKey, setSavingKey] = useState('')
  const [preview, setPreview]   = useState(null)  // { key, entityId, docType }
  const [previewHtml, setPreviewHtml] = useState('')
  const [previewError, setPreviewError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data, error }, nm] = await Promise.all([
      supabase.from('entities').select('id,name,short_name,gstin,type,document_format').eq('is_deleted', false).order('name'),
      fetchFormatNames(),
    ])
    setLoadError(error ? error.message : '')
    setEntities(data || [])
    setNames(nm)
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const usedBy = useMemo(() => {
    const map = Object.fromEntries(DOCUMENT_FORMATS.map(f => [f.value, []]))
    for (const e of entities) map[effectiveFormatKey(e)]?.push(e)
    return map
  }, [entities])

  async function rename() {
    const { key, value } = renaming
    setSavingKey(key)
    const { error } = await saveFormatName(key, value, profile?.id)
    setSavingKey('')
    if (error) return setToast({ message: error.message, type: 'error' })
    setRenaming(null)
    setNames(await fetchFormatNames())
    setToast({ message: value.trim() ? 'Format renamed' : 'Name reset to the original', type: 'success' })
  }

  async function assign(entity, value) {
    const { data, error } = await supabase.from('entities').update({ document_format: value || null, updated_at: new Date() }).eq('id', entity.id).select('id')
    if (error || !data?.length) return setToast({ message: error?.message || 'Not saved — you do not have edit access to this entity.', type: 'error' })
    setEntities(list => list.map(e => (e.id === entity.id ? { ...e, document_format: value || null } : e)))
    setToast({ message: `${entity.short_name || entity.name} now uses ${formatName(value || automaticFormatKey(entity.gstin), names)}`, type: 'success' })
  }

  // Build the preview whenever the format, entity or document type changes.
  useEffect(() => {
    if (!preview) return
    let cancelled = false
    setPreviewHtml(''); setPreviewError('')
    ;(async () => {
      try {
        let seller = { name: 'Your Entity Name', address: 'Address line', city: 'City', state_name: 'State', pincode: '000000', gstin: '', pan: '' }
        if (preview.entityId) {
          const { data, error } = await supabase.from('entities').select(ENTITY_DOC_COLUMNS).eq('id', preview.entityId).single()
          if (error) throw error
          let logoSrc = null
          if (data?.logo_file_id) { try { logoSrc = await getDriveViewUrl(data.logo_file_id) } catch { /* no logo — text-only header */ } }
          seller = { ...data, logoSrc }
        }
        const doc = sampleDoc(preview.docType, { ...seller, document_format: preview.key })
        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${getDocumentStyles(resolveThemeOrThrow(doc.sellerEntity))}</style></head><body>${buildDocumentHTML(doc)}</body></html>`
        if (!cancelled) setPreviewHtml(html)
      } catch (e) { if (!cancelled) setPreviewError(e.message || 'Could not build the preview') }
    })()
    return () => { cancelled = true }
  }, [preview])

  const th = { padding: '9px 12px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em', textAlign: 'left', whiteSpace: 'nowrap' }
  const td = { padding: '10px 12px', borderBottom: `1px solid ${C.border}`, fontSize: '13px', verticalAlign: 'middle' }
  const openPreview = (key, entityId) => setPreview({ key, entityId: entityId || usedBy[key]?.[0]?.id || entities[0]?.id || '', docType: 'INVOICE' })

  if (loading) return <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
  if (loadError) return <div style={{ padding: '16px', color: C.danger, fontSize: '13px' }}>Could not load: {loadError}</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* ── Formats ── */}
      <div>
        <div style={{ fontSize: '14px', fontWeight: 700, marginBottom: '4px' }}>Available formats</div>
        <div style={{ fontSize: '12px', color: C.textSoft, marginBottom: '10px' }}>The layouts used for the Proforma Invoice, Purchase Order and Tax Invoice. Preview one, rename it, or assign it to an entity below.</div>
        <Card>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Format</th><th style={th}>Originally built for</th><th style={th}>Used by</th><th style={th} /></tr></thead>
            <tbody>
              {DOCUMENT_FORMATS.map(f => (
                <tr key={f.value}>
                  <td style={{ ...td, minWidth: '260px' }}>
                    {renaming?.key === f.value ? (
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <Input value={renaming.value} onChange={e => setRenaming({ key: f.value, value: e.target.value })} placeholder={f.label} />
                        <Btn size='sm' onClick={rename} disabled={savingKey === f.value}>{savingKey === f.value ? 'Saving…' : 'Save'}</Btn>
                        <Btn size='sm' variant='ghost' onClick={() => setRenaming(null)}>Cancel</Btn>
                      </div>
                    ) : (
                      <>
                        <span style={{ fontWeight: 700 }}>{formatName(f.value, names)}</span>
                        {names[f.value] && <span style={{ display: 'block', fontSize: '11px', color: C.textMuted }}>Original name: {f.label}</span>}
                      </>
                    )}
                  </td>
                  <td style={{ ...td, color: C.textSoft }}>{f.builtFor}</td>
                  <td style={{ ...td, color: usedBy[f.value].length ? C.text : C.textMuted }}>{usedBy[f.value].length ? usedBy[f.value].map(e => e.short_name || e.name).join(', ') : 'No entity'}</td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Btn size='sm' variant='ghost' onClick={() => openPreview(f.value)}>Preview</Btn>{' '}
                    {canManage && renaming?.key !== f.value && <Btn size='sm' variant='ghost' onClick={() => setRenaming({ key: f.value, value: names[f.value] || '' })}>Rename</Btn>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      {/* ── Assignment ── */}
      <div>
        <div style={{ fontSize: '14px', fontWeight: 700, marginBottom: '4px' }}>Format used by each entity</div>
        <div style={{ fontSize: '12px', color: C.textSoft, marginBottom: '10px' }}>"Automatic" uses the entity's own format if it has one, otherwise the Tally style. Changing it here affects documents printed from now on; nothing already issued is altered.</div>
        <Card>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Entity</th><th style={th}>GSTIN</th><th style={th}>Format</th><th style={th} /></tr></thead>
            <tbody>
              {entities.map(e => (
                <tr key={e.id}>
                  <td style={td}><span style={{ fontWeight: 600 }}>{e.short_name || e.name}</span>{e.short_name && <span style={{ display: 'block', fontSize: '11px', color: C.textMuted }}>{e.name}</span>}</td>
                  <td style={{ ...td, fontFamily: 'monospace', fontSize: '12px', color: C.textSoft }}>{e.gstin || '—'}</td>
                  <td style={{ ...td, minWidth: '280px' }}>
                    <Select value={e.document_format || ''} onChange={ev => assign(e, ev.target.value)} disabled={!canManage}>
                      <option value=''>Automatic — {formatName(automaticFormatKey(e.gstin), names)}</option>
                      {DOCUMENT_FORMATS.map(f => <option key={f.value} value={f.value}>{formatName(f.value, names)}</option>)}
                    </Select>
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}><Btn size='sm' variant='ghost' onClick={() => openPreview(effectiveFormatKey(e), e.id)}>Preview</Btn></td>
                </tr>
              ))}
              {entities.length === 0 && <tr><td colSpan={4} style={{ ...td, textAlign: 'center', color: C.textMuted }}>No entities.</td></tr>}
            </tbody>
          </table>
        </Card>
      </div>

      {/* ── Preview ── */}
      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview ? `Preview — ${formatName(preview.key, names)}` : ''} width={980}>
        {preview && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', color: C.textSoft }}>Format</span>
              <Select value={preview.key} onChange={e => setPreview(p => ({ ...p, key: e.target.value }))} style={{ minWidth: '220px' }}>
                {DOCUMENT_FORMATS.map(f => <option key={f.value} value={f.value}>{formatName(f.value, names)}</option>)}
              </Select>
              <span style={{ fontSize: '12px', color: C.textSoft }}>Document</span>
              <Select value={preview.docType} onChange={e => setPreview(p => ({ ...p, docType: e.target.value }))} style={{ minWidth: '160px' }}>
                {DOC_TYPES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
              </Select>
              <span style={{ fontSize: '12px', color: C.textSoft }}>With details of</span>
              <Select value={preview.entityId} onChange={e => setPreview(p => ({ ...p, entityId: e.target.value }))} style={{ minWidth: '200px' }}>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </div>
            <div style={{ fontSize: '11px', color: C.textMuted }}>Sample items and a sample customer — only the layout and the entity's own details are real.</div>
            {previewError
              ? <div style={{ padding: '16px', color: C.danger, fontSize: '13px' }}>Could not build the preview: {previewError}</div>
              : previewHtml
                ? <iframe title='Format preview' srcDoc={previewHtml} style={{ width: '100%', height: '70vh', border: `1px solid ${C.border}`, borderRadius: '6px', background: '#fff' }} />
                : <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Building preview…</div>}
          </div>
        )}
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}
