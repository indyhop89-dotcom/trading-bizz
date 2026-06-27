-- ─── Migration 010: Bill From/To, Ship From/To, Eway Bill Date, Document fixes ───

-- ── 1. Add bill_from / bill_to / ship_from / ship_to to proforma_invoices ──
ALTER TABLE proforma_invoices
  ADD COLUMN IF NOT EXISTS bill_from       text,   -- free-text billing address (from entity override)
  ADD COLUMN IF NOT EXISTS bill_to         text,   -- free-text billing address (to entity override)
  ADD COLUMN IF NOT EXISTS ship_from       text,   -- free-text shipping address
  ADD COLUMN IF NOT EXISTS ship_to         text;   -- free-text shipping address

-- ── 2. Add bill_from / bill_to / ship_from / ship_to to purchase_orders ──
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS bill_from       text,
  ADD COLUMN IF NOT EXISTS bill_to         text,
  ADD COLUMN IF NOT EXISTS ship_from       text,
  ADD COLUMN IF NOT EXISTS ship_to         text;

-- ── 3. Add bill_from / bill_to / ship_from / ship_to + eway_bill_date to invoices ──
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS bill_from       text,
  ADD COLUMN IF NOT EXISTS bill_to         text,
  ADD COLUMN IF NOT EXISTS ship_from       text,
  ADD COLUMN IF NOT EXISTS ship_to         text,
  ADD COLUMN IF NOT EXISTS eway_bill_date  date,
  ADD COLUMN IF NOT EXISTS eway_bill_no    text;

-- ── 4. Fix leg_document_checklist — add doc_key alias so old code still works ──
-- The checklist component was using 'document_checklist' table with 'doc_key'
-- Real table is leg_document_checklist with 'doc_slot'
-- Add doc_key as generated column alias, or just rename usage in code.
-- We'll fix in code, no column change needed.

-- ── 5. Add doc_category column to documents for 'other' free-form uploads ──
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS doc_category    text DEFAULT 'standard';
  -- 'standard' = slot-linked, 'other' = free-form additional

-- ── 6. Ensure RLS disabled on all relevant tables ──
ALTER TABLE proforma_invoices DISABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders DISABLE ROW LEVEL SECURITY;
ALTER TABLE invoices DISABLE ROW LEVEL SECURITY;
ALTER TABLE leg_document_checklist DISABLE ROW LEVEL SECURITY;
ALTER TABLE documents DISABLE ROW LEVEL SECURITY;

