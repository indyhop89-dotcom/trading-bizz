-- ============================================================================
-- 039_purchase_orders_updated_at.sql
--
-- purchase_orders was missing `updated_at`, even though the original
-- 002_accounting.sql CREATE TABLE defined it (`updated_at timestamptz
-- DEFAULT now()`) and every other document table in the app (proforma_
-- invoices, invoices, orders, entities, profiles, products, invoice_
-- payments, expense_payments, bill_discounting_events — confirmed via
-- information_schema) already has it. PO's post-save edit flow
-- (handleSaveEdit, PO/index.jsx) writes `updated_at: new Date()` on every
-- save, same as all those other tables' edit flows, so this was a hard
-- failure: "Could not find the 'updated_at' column of 'purchase_orders'
-- in the schema cache" on every PO edit.
--
-- Idempotent — safe to re-run.
-- ============================================================================

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
