-- ============================================================================
-- 027_expense_invoice_link.sql
--
-- Expenses could already be linked to an order (expenses.order_id), but not to
-- a specific invoice under that order. This adds an optional invoice_id so an
-- expense (freight, brokerage, bank charges, …) can be tagged to the exact
-- invoice it belongs to. The Expenses form only offers the invoice dropdown
-- once an order is chosen, and lists just that order's invoices.
--
-- Nullable and ON DELETE SET NULL: tagging an invoice is optional, and if the
-- invoice is later hard-deleted the expense record survives with the link
-- simply cleared. Idempotent so a re-run (or partial earlier apply) is a no-op.
-- ============================================================================

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_invoice ON expenses(invoice_id) WHERE invoice_id IS NOT NULL;
