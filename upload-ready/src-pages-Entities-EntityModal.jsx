import { useState, useEffect } from 'react'
import { Modal } from '../../components/UI/Modal'
import { supabase } from '../../supabaseClient'
import { GST_STATES, getStateFromGSTIN } from '../../constants/states'
import { toast } from '../../components/UI/Toast'

const EMPTY = {
  name: '',
  short_name: '',
  type: 'associate',
  group_id: '',
  gstin: '',
  pan: '',
  state_code: '',
  state_name: '',
  address: '',
  city: '',
  pincode: '',
  email: '',
  phone: '',
  bank_name: '',
  bank_account_no: '',
  bank_ifsc: '',
  bank_branch: '',
  reliance_vendor_id: '',
  reliance_sales_id: '',
  reliance_onboarded: false,
  reliance_notes: '',
  is_active: true,
}

export function EntityModal({ open, onClose, entity, groups, onSaved }) {
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('basic')

  const isEdit = !!entity

  useEffect(() => {
    if (open) {
      setForm(entity ? { ...EMPTY, ...entity } : EMPTY)
      setError('')
      setTab('basic')
    }
  }, [open, entity])

  function set(field, value) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  function handleGSTIN(val) {
    set('gstin', val.toUpperCase())
    if (val.length >= 2) {
      const state = getStateFromGSTIN(val)
      if (state) {
        set('state_code', state.code)
        set('state_name', state.name)
      }
    }
  }

  function handleStateCode(code) {
    set('state_code', code)
    const state = GST_STATES.find(s => s.code === code)
    if (state) set('state_name', state.name)
  }

  async function handleSave() {
    if (!form.name.trim()) { setError('Entity name is required.'); return }
    if (!form.type) { setError('Type is required.'); return }

    setSaving(true)
    setError('')

    const payload = {
      name: form.name.trim(),
      short_name: form.short_name.trim() || null,
      type: form.type,
      group_id: form.group_id || null,
      gstin: form.gstin.trim().toUpperCase() || null,
      pan: form.pan.trim().toUpperCase() || null,
      state_code: form.state_code || null,
      state_name: form.state_name || null,
      address: form.address.trim() || null,
      city: form.city.trim() || null,
      pincode: form.pincode.trim() || null,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      bank_name: form.bank_name.trim() || null,
      bank_account_no: form.bank_account_no.trim() || null,
      bank_ifsc: form.bank_ifsc.trim().toUpperCase() || null,
      bank_branch: form.bank_branch.trim() || null,
      reliance_vendor_id: form.reliance_vendor_id.trim() || null,
      reliance_sales_id: form.reliance_sales_id.trim() || null,
      reliance_onboarded: form.reliance_onboarded,
      reliance_notes: form.reliance_notes.trim() || null,
      is_active: form.is_active,
      updated_at: new Date().toISOString(),
    }

    try {
      let err
      if (isEdit) {
        ;({ error: err } = await supabase.from('entities').update(payload).eq('id', entity.id))
      } else {
        ;({ error: err } = await supabase.from('entities').insert(payload))
      }
      if (err) throw err
      toast(isEdit ? 'Entity updated.' : 'Entity created.', 'success')
      onSaved()
      onClose()
    } catch (e) {
      setError(e.message || 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  const TABS = [
    { id: 'basic',    label: 'Basic Details' },
    { id: 'address',  label: 'Address & Contact' },
    { id: 'bank',     label: 'Bank Details' },
    { id: 'reliance', label: 'Reliance Portal' },
  ]

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit — ${entity.name}` : 'New Entity'}
      size="lg"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Entity'}
          </button>
        </>
      }
    >
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '7px 14px',
              border: 'none',
              background: 'none',
              fontSize: 13,
              fontWeight: tab === t.id ? 700 : 500,
              color: tab === t.id ? 'var(--accent)' : 'var(--ink2)',
              borderBottom: tab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

      {/* Basic Details */}
      {tab === 'basic' && (
        <div>
          <div className="form-row">
            <div className="field">
              <label className="field-label">Entity Name *</label>
              <input className="field-input" value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Siddi Trading Co" />
            </div>
            <div className="field">
              <label className="field-label">Short Name</label>
              <input className="field-input" value={form.short_name} onChange={e => set('short_name', e.target.value)} placeholder="e.g. Siddi" />
            </div>
          </div>

          <div className="form-row">
            <div className="field">
              <label className="field-label">Type *</label>
              <select className="field-select" value={form.type} onChange={e => set('type', e.target.value)}>
                <option value="group">Group</option>
                <option value="associate">Associate</option>
                <option value="external">External</option>
              </select>
            </div>
            <div className="field">
              <label className="field-label">Group</label>
              <select className="field-select" value={form.group_id} onChange={e => set('group_id', e.target.value)}>
                <option value="">— None —</option>
                {groups.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="form-row">
            <div className="field">
              <label className="field-label">GSTIN</label>
              <input
                className="field-input"
                value={form.gstin}
                onChange={e => handleGSTIN(e.target.value)}
                placeholder="e.g. 29AABCU9603R1ZM"
                maxLength={15}
                style={{ fontFamily: 'monospace' }}
              />
              <div className="field-hint">Auto-fills state from first 2 digits</div>
            </div>
            <div className="field">
              <label className="field-label">PAN</label>
              <input
                className="field-input"
                value={form.pan}
                onChange={e => set('pan', e.target.value.toUpperCase())}
                placeholder="e.g. AABCU9603R"
                maxLength={10}
                style={{ fontFamily: 'monospace' }}
              />
            </div>
          </div>

          <div className="form-row">
            <div className="field">
              <label className="field-label">State</label>
              <select className="field-select" value={form.state_code} onChange={e => handleStateCode(e.target.value)}>
                <option value="">— Select State —</option>
                {GST_STATES.map(s => (
                  <option key={s.code} value={s.code}>{s.code} — {s.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label">Status</label>
              <select className="field-select" value={form.is_active ? 'active' : 'inactive'} onChange={e => set('is_active', e.target.value === 'active')}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Address & Contact */}
      {tab === 'address' && (
        <div>
          <div className="field">
            <label className="field-label">Address</label>
            <textarea className="field-textarea" value={form.address} onChange={e => set('address', e.target.value)} placeholder="Street address, landmark" rows={3} />
          </div>
          <div className="form-row-3">
            <div className="field">
              <label className="field-label">City</label>
              <input className="field-input" value={form.city} onChange={e => set('city', e.target.value)} placeholder="e.g. Bangalore" />
            </div>
            <div className="field">
              <label className="field-label">Pincode</label>
              <input className="field-input" value={form.pincode} onChange={e => set('pincode', e.target.value)} placeholder="e.g. 560001" maxLength={6} />
            </div>
            <div className="field">
              <label className="field-label">State</label>
              <input className="field-input" value={form.state_name} readOnly style={{ background: 'var(--surface3)', color: 'var(--ink2)' }} placeholder="Auto from GSTIN" />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label className="field-label">Email</label>
              <input className="field-input" type="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="accounts@example.com" />
            </div>
            <div className="field">
              <label className="field-label">Phone</label>
              <input className="field-input" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="+91 98765 43210" />
            </div>
          </div>
        </div>
      )}

      {/* Bank Details */}
      {tab === 'bank' && (
        <div>
          <div className="form-row">
            <div className="field">
              <label className="field-label">Bank Name</label>
              <input className="field-input" value={form.bank_name} onChange={e => set('bank_name', e.target.value)} placeholder="e.g. HDFC Bank" />
            </div>
            <div className="field">
              <label className="field-label">Branch</label>
              <input className="field-input" value={form.bank_branch} onChange={e => set('bank_branch', e.target.value)} placeholder="e.g. Indiranagar, Bangalore" />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label className="field-label">Account Number</label>
              <input className="field-input" value={form.bank_account_no} onChange={e => set('bank_account_no', e.target.value)} placeholder="e.g. 50100123456789" style={{ fontFamily: 'monospace' }} />
            </div>
            <div className="field">
              <label className="field-label">IFSC Code</label>
              <input
                className="field-input"
                value={form.bank_ifsc}
                onChange={e => set('bank_ifsc', e.target.value.toUpperCase())}
                placeholder="e.g. HDFC0001234"
                maxLength={11}
                style={{ fontFamily: 'monospace' }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Reliance Portal */}
      {tab === 'reliance' && (
        <div>
          <div className="form-row">
            <div className="field">
              <label className="field-label">Vendor ID (Reliance)</label>
              <input className="field-input" value={form.reliance_vendor_id} onChange={e => set('reliance_vendor_id', e.target.value)} placeholder="e.g. VND-0012345" />
            </div>
            <div className="field">
              <label className="field-label">Sales ID (Reliance)</label>
              <input className="field-input" value={form.reliance_sales_id} onChange={e => set('reliance_sales_id', e.target.value)} placeholder="e.g. SAL-0012345" />
            </div>
          </div>
          <div className="field">
            <label className="field-label">Onboarding Status</label>
            <select className="field-select" value={form.reliance_onboarded ? 'yes' : 'no'} onChange={e => set('reliance_onboarded', e.target.value === 'yes')}>
              <option value="no">Not Onboarded</option>
              <option value="yes">Onboarded</option>
            </select>
          </div>
          <div className="field">
            <label className="field-label">Notes</label>
            <textarea className="field-textarea" value={form.reliance_notes} onChange={e => set('reliance_notes', e.target.value)} placeholder="Any notes about Reliance portal registration..." rows={3} />
          </div>
        </div>
      )}
    </Modal>
  )
}
