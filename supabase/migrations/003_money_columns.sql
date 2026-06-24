-- Migration: Convert all money columns from bigint (paise) to numeric(15,2) (rupees)
-- Run this in Supabase SQL Editor BEFORE deploying the new frontend code.
-- If you have existing data, values will be divided by 100 automatically.
-- If database is fresh (no real data), just run as-is.

-- ── proforma_invoices ──────────────────────────────────────────────────────
ALTER TABLE proforma_invoices
  ALTER COLUMN taxable_amount  TYPE numeric(15,2) USING ROUND(taxable_amount::numeric / 100, 2),
  ALTER COLUMN cgst_amount     TYPE numeric(15,2) USING ROUND(cgst_amount::numeric / 100, 2),
  ALTER COLUMN sgst_amount     TYPE numeric(15,2) USING ROUND(sgst_amount::numeric / 100, 2),
  ALTER COLUMN igst_amount     TYPE numeric(15,2) USING ROUND(igst_amount::numeric / 100, 2),
  ALTER COLUMN total_amount    TYPE numeric(15,2) USING ROUND(total_amount::numeric / 100, 2);

-- ── proforma_invoice_lines ─────────────────────────────────────────────────
ALTER TABLE proforma_invoice_lines
  ALTER COLUMN rate            TYPE numeric(15,2) USING ROUND(rate::numeric / 100, 2),
  ALTER COLUMN taxable_amount  TYPE numeric(15,2) USING ROUND(taxable_amount::numeric / 100, 2),
  ALTER COLUMN cgst_amount     TYPE numeric(15,2) USING ROUND(cgst_amount::numeric / 100, 2),
  ALTER COLUMN sgst_amount     TYPE numeric(15,2) USING ROUND(sgst_amount::numeric / 100, 2),
  ALTER COLUMN igst_amount     TYPE numeric(15,2) USING ROUND(igst_amount::numeric / 100, 2),
  ALTER COLUMN total_amount    TYPE numeric(15,2) USING ROUND(total_amount::numeric / 100, 2);

-- ── purchase_orders ────────────────────────────────────────────────────────
ALTER TABLE purchase_orders
  ALTER COLUMN taxable_amount  TYPE numeric(15,2) USING ROUND(taxable_amount::numeric / 100, 2),
  ALTER COLUMN cgst_amount     TYPE numeric(15,2) USING ROUND(cgst_amount::numeric / 100, 2),
  ALTER COLUMN sgst_amount     TYPE numeric(15,2) USING ROUND(sgst_amount::numeric / 100, 2),
  ALTER COLUMN igst_amount     TYPE numeric(15,2) USING ROUND(igst_amount::numeric / 100, 2),
  ALTER COLUMN total_amount    TYPE numeric(15,2) USING ROUND(total_amount::numeric / 100, 2);

-- ── purchase_order_lines ───────────────────────────────────────────────────
ALTER TABLE purchase_order_lines
  ALTER COLUMN rate            TYPE numeric(15,2) USING ROUND(rate::numeric / 100, 2),
  ALTER COLUMN taxable_amount  TYPE numeric(15,2) USING ROUND(taxable_amount::numeric / 100, 2),
  ALTER COLUMN cgst_amount     TYPE numeric(15,2) USING ROUND(cgst_amount::numeric / 100, 2),
  ALTER COLUMN sgst_amount     TYPE numeric(15,2) USING ROUND(sgst_amount::numeric / 100, 2),
  ALTER COLUMN igst_amount     TYPE numeric(15,2) USING ROUND(igst_amount::numeric / 100, 2),
  ALTER COLUMN total_amount    TYPE numeric(15,2) USING ROUND(total_amount::numeric / 100, 2);

-- ── invoices ───────────────────────────────────────────────────────────────
ALTER TABLE invoices
  ALTER COLUMN taxable_amount      TYPE numeric(15,2) USING ROUND(taxable_amount::numeric / 100, 2),
  ALTER COLUMN cgst_amount         TYPE numeric(15,2) USING ROUND(cgst_amount::numeric / 100, 2),
  ALTER COLUMN sgst_amount         TYPE numeric(15,2) USING ROUND(sgst_amount::numeric / 100, 2),
  ALTER COLUMN igst_amount         TYPE numeric(15,2) USING ROUND(igst_amount::numeric / 100, 2),
  ALTER COLUMN tds_amount          TYPE numeric(15,2) USING ROUND(tds_amount::numeric / 100, 2),
  ALTER COLUMN tcs_amount          TYPE numeric(15,2) USING ROUND(tcs_amount::numeric / 100, 2),
  ALTER COLUMN total_amount        TYPE numeric(15,2) USING ROUND(total_amount::numeric / 100, 2),
  ALTER COLUMN paid_amount         TYPE numeric(15,2) USING ROUND(paid_amount::numeric / 100, 2),
  ALTER COLUMN outstanding_amount  TYPE numeric(15,2) USING ROUND(outstanding_amount::numeric / 100, 2);

-- ── invoice_lines ──────────────────────────────────────────────────────────
ALTER TABLE invoice_lines
  ALTER COLUMN rate            TYPE numeric(15,2) USING ROUND(rate::numeric / 100, 2),
  ALTER COLUMN taxable_amount  TYPE numeric(15,2) USING ROUND(taxable_amount::numeric / 100, 2),
  ALTER COLUMN cgst_amount     TYPE numeric(15,2) USING ROUND(cgst_amount::numeric / 100, 2),
  ALTER COLUMN sgst_amount     TYPE numeric(15,2) USING ROUND(sgst_amount::numeric / 100, 2),
  ALTER COLUMN igst_amount     TYPE numeric(15,2) USING ROUND(igst_amount::numeric / 100, 2),
  ALTER COLUMN total_amount    TYPE numeric(15,2) USING ROUND(total_amount::numeric / 100, 2);

-- ── payments ───────────────────────────────────────────────────────────────
ALTER TABLE payments
  ALTER COLUMN amount      TYPE numeric(15,2) USING ROUND(amount::numeric / 100, 2),
  ALTER COLUMN tds_amount  TYPE numeric(15,2) USING ROUND(tds_amount::numeric / 100, 2),
  ALTER COLUMN tcs_amount  TYPE numeric(15,2) USING ROUND(tcs_amount::numeric / 100, 2),
  ALTER COLUMN net_amount  TYPE numeric(15,2) USING ROUND(net_amount::numeric / 100, 2);

-- ── expenses ───────────────────────────────────────────────────────────────
ALTER TABLE expenses
  ALTER COLUMN amount        TYPE numeric(15,2) USING ROUND(amount::numeric / 100, 2),
  ALTER COLUMN gst_amount    TYPE numeric(15,2) USING ROUND(gst_amount::numeric / 100, 2),
  ALTER COLUMN total_amount  TYPE numeric(15,2) USING ROUND(total_amount::numeric / 100, 2);

-- ── credit_debit_notes ─────────────────────────────────────────────────────
ALTER TABLE credit_debit_notes
  ALTER COLUMN taxable_amount  TYPE numeric(15,2) USING ROUND(taxable_amount::numeric / 100, 2),
  ALTER COLUMN cgst_amount     TYPE numeric(15,2) USING ROUND(cgst_amount::numeric / 100, 2),
  ALTER COLUMN sgst_amount     TYPE numeric(15,2) USING ROUND(sgst_amount::numeric / 100, 2),
  ALTER COLUMN igst_amount     TYPE numeric(15,2) USING ROUND(igst_amount::numeric / 100, 2),
  ALTER COLUMN total_amount    TYPE numeric(15,2) USING ROUND(total_amount::numeric / 100, 2);

-- ── credit_debit_note_lines ────────────────────────────────────────────────
ALTER TABLE credit_debit_note_lines
  ALTER COLUMN rate            TYPE numeric(15,2) USING ROUND(rate::numeric / 100, 2),
  ALTER COLUMN taxable_amount  TYPE numeric(15,2) USING ROUND(taxable_amount::numeric / 100, 2),
  ALTER COLUMN cgst_amount     TYPE numeric(15,2) USING ROUND(cgst_amount::numeric / 100, 2),
  ALTER COLUMN sgst_amount     TYPE numeric(15,2) USING ROUND(sgst_amount::numeric / 100, 2),
  ALTER COLUMN igst_amount     TYPE numeric(15,2) USING ROUND(igst_amount::numeric / 100, 2),
  ALTER COLUMN total_amount    TYPE numeric(15,2) USING ROUND(total_amount::numeric / 100, 2);

-- ── bill_discounting ───────────────────────────────────────────────────────
ALTER TABLE bill_discounting
  ALTER COLUMN invoice_amount     TYPE numeric(15,2) USING ROUND(invoice_amount::numeric / 100, 2),
  ALTER COLUMN discounted_amount  TYPE numeric(15,2) USING ROUND(discounted_amount::numeric / 100, 2),
  ALTER COLUMN discount_charges   TYPE numeric(15,2) USING ROUND(discount_charges::numeric / 100, 2),
  ALTER COLUMN net_received       TYPE numeric(15,2) USING ROUND(net_received::numeric / 100, 2),
  ALTER COLUMN repaid_amount      TYPE numeric(15,2) USING ROUND(repaid_amount::numeric / 100, 2),
  ALTER COLUMN outstanding_amount TYPE numeric(15,2) USING ROUND(outstanding_amount::numeric / 100, 2);

-- ── bill_discounting_repayments ────────────────────────────────────────────
ALTER TABLE bill_discounting_repayments
  ALTER COLUMN amount  TYPE numeric(15,2) USING ROUND(amount::numeric / 100, 2);

-- ── stock_opening_balance ──────────────────────────────────────────────────
ALTER TABLE stock_opening_balance
  ALTER COLUMN rate  TYPE numeric(15,2) USING ROUND(rate::numeric / 100, 2);

-- ── stock_ledger ───────────────────────────────────────────────────────────
ALTER TABLE stock_ledger
  ALTER COLUMN rate  TYPE numeric(15,2) USING ROUND(rate::numeric / 100, 2);

-- ── general_ledger ─────────────────────────────────────────────────────────
ALTER TABLE general_ledger
  ALTER COLUMN debit   TYPE numeric(15,2) USING ROUND(debit::numeric / 100, 2),
  ALTER COLUMN credit  TYPE numeric(15,2) USING ROUND(credit::numeric / 100, 2);

-- ── journal_entries ────────────────────────────────────────────────────────
ALTER TABLE journal_entries
  ALTER COLUMN total_debit   TYPE numeric(15,2) USING ROUND(total_debit::numeric / 100, 2),
  ALTER COLUMN total_credit  TYPE numeric(15,2) USING ROUND(total_credit::numeric / 100, 2);

-- ── journal_entry_lines ────────────────────────────────────────────────────
ALTER TABLE journal_entry_lines
  ALTER COLUMN debit   TYPE numeric(15,2) USING ROUND(debit::numeric / 100, 2),
  ALTER COLUMN credit  TYPE numeric(15,2) USING ROUND(credit::numeric / 100, 2);

-- ── products ───────────────────────────────────────────────────────────────
ALTER TABLE products
  ALTER COLUMN default_rate  TYPE numeric(15,2) USING ROUND(default_rate::numeric / 100, 2);

-- ── HSN master slabs: update max_rate from paise to rupees ─────────────────
-- Convert existing slab max_rate values from paise to rupees
UPDATE hsn_master
SET slabs = (
  SELECT jsonb_agg(
    CASE
      WHEN (slab->>'max_rate') IS NULL
        THEN slab
      ELSE jsonb_build_object(
        'max_rate', ROUND((slab->>'max_rate')::numeric / 100, 2),
        'gst_rate', (slab->>'gst_rate')::numeric
      )
    END
  )
  FROM jsonb_array_elements(slabs) AS slab
)
WHERE rate_type = 'slab' AND slabs IS NOT NULL;

