// Document checklist slots per leg type
// order matters — defines display order in checklist

export const DOMESTIC_DOCS = [
  { slot: 'invoice',      label: 'Invoice',               canBeNA: false, order: 1 },
  { slot: 'packing_list', label: 'Packing List',          canBeNA: true,  order: 2 },
  { slot: 'pi',           label: 'PI (Proforma Invoice)', canBeNA: true,  order: 3 },
  { slot: 'eway_bill',    label: 'E-way Bill',            canBeNA: true,  order: 4 },
  { slot: 'einvoice',     label: 'E-invoice',             canBeNA: true,  order: 5 },
  { slot: 'lr',           label: 'LR (Lorry Receipt)',    canBeNA: true,  order: 6 },
  { slot: 'other',        label: 'Others',                canBeNA: false, order: 7, multiple: true },
]

export const EXPORT_DOCS = [
  { slot: 'pi',                    label: 'PI (Proforma Invoice)',   canBeNA: false, order: 1 },
  { slot: 'po',                    label: 'PO (Purchase Order)',     canBeNA: true,  order: 2 },
  { slot: 'invoice',               label: 'Invoice',                 canBeNA: false, order: 3 },
  { slot: 'packing_list',          label: 'Packing List',           canBeNA: false, order: 4 },
  { slot: 'airway_bill',           label: 'Airway Bill',            canBeNA: false, order: 5 },
  { slot: 'coo',                   label: 'COO (Country of Origin)',canBeNA: true,  order: 6 },
  { slot: 'boe',                   label: 'BOE (Bill of Entry)',    canBeNA: true,  order: 7 },
  { slot: 'air_freight_clearance', label: 'Air Freight Clearance',  canBeNA: true,  order: 8 },
  { slot: 'other',                 label: 'Others',                  canBeNA: false, order: 9, multiple: true },
]

export function getDocSlots(legType) {
  return legType === 'export' ? EXPORT_DOCS : DOMESTIC_DOCS
}

export function getDocLabel(slot, legType) {
  const docs = getDocSlots(legType)
  const doc = docs.find(d => d.slot === slot)
  return doc ? doc.label : slot
}

// Status options
export const DOC_STATUS = {
  PENDING:  'pending',
  UPLOADED: 'uploaded',
  NA:       'na',
}

export const DOC_STATUS_LABELS = {
  pending:  'Pending',
  uploaded: 'Uploaded',
  na:       'N/A',
}
