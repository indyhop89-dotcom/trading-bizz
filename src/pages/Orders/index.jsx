import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, SectionDivider, StatCard,
} from '../../components/UI/index'
import DocumentAttachments from '../../components/DocumentAttachments'
import { fmtDate, today, fyOptions } from '../../utils/dates'

// ─── constants ────────────────────────────────────────────────────────────────
const MOVEMENT_TYPES    = ['domestic', 'export', 'blended']
const ORDER_STATUSES    = ['open', 'in_progress', 'completed', 'cancelled']
const CARGO_STATUSES    = ['awaiting_cargo', 'cargo_dispatched', 'cargo_received', 'ready_for_pi', 'ready_for_invoice', 'completed']
const MOVEMENT_STATUSES = ['pending', 'in_transit', 'delivered']

const EMPTY_ORDER = {
  name: '', movement_type: 'domestic', status: 'open',
  origin_entity_id: '', destination_entity_id: '',
  financial_year_id: '', notes: '',
}

const EMPTY_LEG = {
  from_entity_id: '', to_entity_id: '',
  movement_status: 'pending', cargo_status: 'awaiting_cargo',
  dispatch_date: '', delivery_date: '', notes: '',
}

// ─── Orders List ─────────────────────────────────────────────────────────────
function OrdersList() {
  const navigate = useNavigate()
  const [orders, setOrders]     = useState([])
  const [entities, setEntities] = useState([])
  const [fys, setFys]           = useState([])
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm]         = useState(EMPTY_ORDER)
  const [saving, setSaving]     = useState(false)
  const [toast, setToast]       = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: os }, { data: es }, { data: fyData }] = await Promise.all([
      supabase.from('orders')
        .select('*, origin:origin_entity_id(name,short_name), destination:destination_entity_id(name,short_name), financial_years(name)')
        .eq('is_deleted', false).order('created_at', { ascending: false }),
      supabase.from('entities').select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('financial_years').select('*').order('start_date', { ascending: false }),
    ])
    setOrders(os || [])
    setEntities(es || [])
    setFys(fyData || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function setF(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function handleSave() {
    if (!form.name.trim()) return setToast({ message: 'Order name is required', type: 'error' })
    setSaving(true)
    const payload = { ...form }
    if (!payload.origin_entity_id)      delete payload.origin_entity_id
    if (!payload.destination_entity_id) delete payload.destination_entity_id
    if (!payload.financial_year_id)     delete payload.financial_year_id
    const { data, error } = await supabase.from('orders').insert(payload).select().single()
    setSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: 'Order created', type: 'success' })
    setModalOpen(false)
    navigate(`/orders/${data.id}`)
  }

  const filtered = orders.filter(o => {
    const ms = !search || o.name.toLowerCase().includes(search.toLowerCase()) ||
      (o.tranche_no || '').toLowerCase().includes(search.toLowerCase())
    const mst = statusFilter === 'all' || o.status === statusFilter
    return ms && mst
  })

  const entityName = e => e?.short_name || e?.name || '—'

  const columns = [
    {
      label: 'Order', render: o => (
        <div>
          <div style={{ fontWeight: 600 }}>{o.name}</div>
          {o.tranche_no && <div style={{ fontSize: '11px', color: C.textMuted, fontFamily: 'monospace' }}>{o.tranche_no}</div>}
        </div>
      ),
    },
    { label: 'Type',   render: o => <Badge status={o.movement_type} /> },
    { label: 'From',   render: o => <span style={{ fontSize: '12px' }}>{entityName(o.origin)}</span> },
    { label: 'To',     render: o => <span style={{ fontSize: '12px' }}>{entityName(o.destination)}</span> },
    { label: 'FY',     render: o => <span style={{ fontSize: '12px', color: C.textSoft }}>{o.financial_years?.name || '—'}</span> },
    { label: 'Status', render: o => <Badge status={o.status} /> },
    { label: 'Date',   render: o => <span style={{ fontSize: '12px', color: C.textSoft }}>{fmtDate(o.created_at)}</span> },
  ]

  return (
    <div>
      <PageHeader
        title='Orders'
        subtitle='Track every movement of goods end-to-end'
        action={<Btn onClick={() => { setForm(EMPTY_ORDER); setModalOpen(true) }}>+ New Order</Btn>}
      />

      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder='Search orders…'
          style={{
            padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px',
            background: C.surface, fontSize: '13px', outline: 'none', flex: 1, minWidth: '180px', fontFamily: 'inherit',
          }}
        />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value='all'>All statuses</option>
          {ORDER_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={filtered} onRowClick={o => navigate(`/orders/${o.id}`)}
              emptyState={<EmptyState icon='↗' title='No orders yet' message='Create your first order to track a movement.' action={<Btn onClick={() => setModalOpen(true)}>+ New Order</Btn>} />}
            />
        }
      </Card>

      {/* New Order Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title='New Order' width={600}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <FormRow label='Order Name' required hint='e.g. "Siddi → Retail → MVL Jun-25"'>
            <Input value={form.name} onChange={e => setF('name', e.target.value)} placeholder='Descriptive name' />
          </FormRow>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Movement Type' required>
              <Select value={form.movement_type} onChange={e => setF('movement_type', e.target.value)}>
                {MOVEMENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Financial Year'>
              <Select value={form.financial_year_id} onChange={e => setF('financial_year_id', e.target.value)}>
                <option value=''>Select FY</option>
                {fys.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Origin Entity'>
              <Select value={form.origin_entity_id} onChange={e => setF('origin_entity_id', e.target.value)}>
                <option value=''>Select entity</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Destination Entity'>
              <Select value={form.destination_entity_id} onChange={e => setF('destination_entity_id', e.target.value)}>
                <option value=''>Select entity</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
          </div>
          <FormRow label='Notes'>
            <Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} />
          </FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Creating…' : 'Create Order'}</Btn>
          </div>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Order Detail (with legs) ─────────────────────────────────────────────────
function OrderDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [order, setOrder]         = useState(null)
  const [legs, setLegs]           = useState([])
  const [entities, setEntities]   = useState([])
  const [loading, setLoading]     = useState(true)
  const [legModal, setLegModal]   = useState(false)
  const [editingLeg, setEditingLeg] = useState(null)
  const [legForm, setLegForm]     = useState(EMPTY_LEG)
  const [saving, setSaving]       = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [editOrderModal, setEditOrderModal] = useState(false)
  const [orderForm, setOrderForm] = useState({})
  const [fys, setFys]             = useState([])
  const [toast, setToast]         = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: o }, { data: ls }, { data: es }, { data: fyData }] = await Promise.all([
      supabase.from('orders').select('*, origin:origin_entity_id(name,short_name), destination:destination_entity_id(name,short_name), financial_years(name)').eq('id', id).single(),
      supabase.from('order_legs').select('*, from_entity:from_entity_id(name,short_name), to_entity:to_entity_id(name,short_name)').eq('order_id', id).order('leg_no'),
      supabase.from('entities').select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('financial_years').select('*').order('start_date', { ascending: false }),
    ])
    setOrder(o)
    setLegs(ls || [])
    setEntities(es || [])
    setFys(fyData || [])
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  function setLF(k, v) { setLegForm(f => ({ ...f, [k]: v })) }
  function setOF(k, v) { setOrderForm(f => ({ ...f, [k]: v })) }

  function openNewLeg() {
    setEditingLeg(null)
    setLegForm({ ...EMPTY_LEG, leg_no: legs.length + 1 })
    setLegModal(true)
  }

  function openEditLeg(leg) {
    setEditingLeg(leg)
    setLegForm({
      from_entity_id:  leg.from_entity_id || '',
      to_entity_id:    leg.to_entity_id || '',
      movement_status: leg.movement_status || 'pending',
      cargo_status:    leg.cargo_status || 'awaiting_cargo',
      dispatch_date:   leg.dispatch_date || '',
      delivery_date:   leg.delivery_date || '',
      notes:           leg.notes || '',
    })
    setLegModal(true)
  }

  async function handleSaveLeg() {
    if (!legForm.from_entity_id || !legForm.to_entity_id)
      return setToast({ message: 'From and To entities are required', type: 'error' })
    setSaving(true)
    const payload = { ...legForm, order_id: id }
    if (!payload.dispatch_date)  delete payload.dispatch_date
    if (!payload.delivery_date)  delete payload.delivery_date

    // auto-detect interstate
    const from = entities.find(e => e.id === legForm.from_entity_id)
    const to   = entities.find(e => e.id === legForm.to_entity_id)
    // We'll need GSTIN for full interstate detection; set null for now, updateable later
    payload.is_interstate = null

    let error
    if (editingLeg) {
      const res = await supabase.from('order_legs').update(payload).eq('id', editingLeg.id)
      error = res.error
    } else {
      payload.leg_no = legs.length + 1
      const res = await supabase.from('order_legs').insert(payload)
      error = res.error
    }
    setSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: editingLeg ? 'Leg updated' : 'Leg added', type: 'success' })
    setLegModal(false)
    load()
  }

  async function handleDeleteLeg() {
    await supabase.from('order_legs').delete().eq('id', confirmDelete.id)
    setConfirmDelete(null)
    load()
  }

  async function handleSaveOrder() {
    const payload = { ...orderForm, updated_at: new Date() }
    if (!payload.origin_entity_id)      delete payload.origin_entity_id
    if (!payload.destination_entity_id) delete payload.destination_entity_id
    if (!payload.financial_year_id)     delete payload.financial_year_id
    await supabase.from('orders').update(payload).eq('id', id)
    setEditOrderModal(false)
    load()
  }

  if (loading) return <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
  if (!order)  return <div style={{ padding: '48px', textAlign: 'center', color: C.danger }}>Order not found.</div>

  const entityName = e => e?.short_name || e?.name || '—'

  return (
    <div>
      {/* back + header */}
      <div style={{ marginBottom: '4px' }}>
        <button onClick={() => navigate('/orders')} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: '13px', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
          ← Orders
        </button>
      </div>
      <PageHeader
        title={order.name}
        subtitle={`${order.tranche_no ? order.tranche_no + ' · ' : ''}${order.financial_years?.name || ''}`}
        action={
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn variant='ghost' onClick={() => { setOrderForm({ name: order.name, movement_type: order.movement_type, status: order.status, origin_entity_id: order.origin_entity_id || '', destination_entity_id: order.destination_entity_id || '', financial_year_id: order.financial_year_id || '', notes: order.notes || '' }); setEditOrderModal(true) }}>Edit Order</Btn>
            <Btn onClick={openNewLeg}>+ Add Leg</Btn>
          </div>
        }
      />

      {/* order summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '24px' }}>
        <StatCard label='Status'        value={<Badge status={order.status} />} />
        <StatCard label='Movement Type' value={<Badge status={order.movement_type} />} />
        <StatCard label='Origin'        value={entityName(order.origin)} />
        <StatCard label='Destination'   value={entityName(order.destination)} />
        <StatCard label='Legs'          value={legs.length} />
      </div>

      {/* Legs */}
      <div style={{ marginBottom: '16px', fontWeight: 700, fontSize: '15px', color: C.text }}>
        Order Legs
      </div>

      {legs.length === 0
        ? (
          <Card style={{ padding: '0' }}>
            <EmptyState icon='↗' title='No legs yet' message='Add the first leg to this order.' action={<Btn onClick={openNewLeg}>+ Add Leg</Btn>} />
          </Card>
        )
        : legs.map((leg, idx) => (
          <Card key={leg.id} style={{ marginBottom: '12px' }}>
            <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '26px', height: '26px', borderRadius: '50%', background: C.accent, color: '#f5f0e8', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, flexShrink: 0 }}>
                  {leg.leg_no}
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '14px' }}>
                    {entityName(leg.from_entity)} → {entityName(leg.to_entity)}
                  </div>
                  <div style={{ fontSize: '12px', color: C.textMuted, marginTop: '2px' }}>
                    {leg.is_interstate === true ? 'Interstate (IGST)' : leg.is_interstate === false ? 'Intrastate (CGST+SGST)' : 'Tax type TBD'}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Badge status={leg.movement_status} />
                <Badge status={leg.cargo_status?.replace(/_/g, ' ')} label={leg.cargo_status?.replace(/_/g, ' ')} />
                <Btn size='sm' variant='ghost' onClick={() => openEditLeg(leg)}>Edit</Btn>
                <Btn size='sm' variant='ghost' onClick={() => setConfirmDelete(leg)} style={{ color: C.danger }}>Remove</Btn>
              </div>
            </div>
            <div style={{ padding: '12px 18px', display: 'flex', gap: '24px', flexWrap: 'wrap', fontSize: '13px', color: C.textSoft }}>
              {leg.dispatch_date && <div><span style={{ fontWeight: 600 }}>Dispatched:</span> {fmtDate(leg.dispatch_date)}</div>}
              {leg.delivery_date && <div><span style={{ fontWeight: 600 }}>Delivered:</span> {fmtDate(leg.delivery_date)}</div>}
              {leg.notes && <div style={{ color: C.textMuted }}>{leg.notes}</div>}
            </div>
            <div style={{ padding: '0 18px 14px' }}>
              <DocumentAttachments
                sourceType='order_legs'
                sourceId={leg.id}
                entityName={leg.from_entity?.name || 'General'}
              />
            </div>
          </Card>
        ))
      }

      {/* Edit Order Modal */}
      <Modal open={editOrderModal} onClose={() => setEditOrderModal(false)} title='Edit Order' width={560}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <FormRow label='Name' required><Input value={orderForm.name || ''} onChange={e => setOF('name', e.target.value)} /></FormRow>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Movement Type'>
              <Select value={orderForm.movement_type || 'domestic'} onChange={e => setOF('movement_type', e.target.value)}>
                {MOVEMENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Status'>
              <Select value={orderForm.status || 'open'} onChange={e => setOF('status', e.target.value)}>
                {ORDER_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Origin Entity'>
              <Select value={orderForm.origin_entity_id || ''} onChange={e => setOF('origin_entity_id', e.target.value)}>
                <option value=''>Select</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Destination Entity'>
              <Select value={orderForm.destination_entity_id || ''} onChange={e => setOF('destination_entity_id', e.target.value)}>
                <option value=''>Select</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
          </div>
          <FormRow label='Notes'><Textarea value={orderForm.notes || ''} onChange={e => setOF('notes', e.target.value)} rows={2} /></FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setEditOrderModal(false)}>Cancel</Btn>
            <Btn onClick={handleSaveOrder}>Save Changes</Btn>
          </div>
        </div>
      </Modal>

      {/* Leg Modal */}
      <Modal open={legModal} onClose={() => setLegModal(false)} title={editingLeg ? 'Edit Leg' : 'Add Leg'} width={540}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='From Entity' required>
              <Select value={legForm.from_entity_id} onChange={e => setLF('from_entity_id', e.target.value)}>
                <option value=''>Select</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='To Entity' required>
              <Select value={legForm.to_entity_id} onChange={e => setLF('to_entity_id', e.target.value)}>
                <option value=''>Select</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Movement Status'>
              <Select value={legForm.movement_status} onChange={e => setLF('movement_status', e.target.value)}>
                {MOVEMENT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Cargo Status'>
              <Select value={legForm.cargo_status} onChange={e => setLF('cargo_status', e.target.value)}>
                {CARGO_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Dispatch Date'>
              <Input type='date' value={legForm.dispatch_date} onChange={e => setLF('dispatch_date', e.target.value)} />
            </FormRow>
            <FormRow label='Delivery Date'>
              <Input type='date' value={legForm.delivery_date} onChange={e => setLF('delivery_date', e.target.value)} />
            </FormRow>
          </div>
          <FormRow label='Notes'><Textarea value={legForm.notes} onChange={e => setLF('notes', e.target.value)} rows={2} /></FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setLegModal(false)}>Cancel</Btn>
            <Btn onClick={handleSaveLeg} disabled={saving}>{saving ? 'Saving…' : editingLeg ? 'Save Changes' : 'Add Leg'}</Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDeleteLeg}
        title='Remove Leg' message={`Remove Leg ${confirmDelete?.leg_no}? This cannot be undone.`} danger />

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Router ───────────────────────────────────────────────────────────────────
export default function Orders() {
  return (
    <Routes>
      <Route index   element={<OrdersList />} />
      <Route path=':id' element={<OrderDetail />} />
    </Routes>
  )
}
