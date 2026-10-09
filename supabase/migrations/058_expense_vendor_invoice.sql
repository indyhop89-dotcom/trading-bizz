-- ============================================================================
-- 058_expense_vendor_invoice.sql
--
-- Expenses get the vendor's own bill reference: the invoice number printed on
-- the vendor's bill, and its date. The vendor invoice number is the main
-- identifier shown for an expense; the system number (expense_no, e.g.
-- SIDDHI-2627-001) stays as the secondary internal reference.
--
--   * Both columns are optional. Existing expenses are left blank.
--   * Nothing on `expenses` is dropped, renamed or altered.
--   * Idempotent — safe to run again.
-- ============================================================================

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS vendor_invoice_no   text,
  ADD COLUMN IF NOT EXISTS vendor_invoice_date date;

-- Make the API see the new columns straight away (avoids a "schema cache" error).
NOTIFY pgrst, 'reload schema';
