-- 049: stock_actual_position/stock_planned_position now time out instead of
-- truncating, once Max Rows was raised (see migration 048's own commit
-- history / chat context — the 1000-row PostgREST cap was silently cutting
-- entities like VRVPL out of Actual Stock; raising Max Rows in the Supabase
-- dashboard was the fix for that, but it surfaces the query's real cost:
-- returning every entity+product row (thousands, once nothing is truncated)
-- means the GROUP BYs, the rate window function, and the invoice_lines/
-- proforma_invoice_lines joins all run over their full row counts instead of
-- stopping at 1000 — long enough to hit the default statement_timeout
-- (error 57014).
--
-- Two-part fix:
--  1. Indexes on the columns these two functions actually filter/join/group
--     on — none of invoice_lines.product_name, proforma_invoice_lines.
--     product_name, proforma_invoices.to_entity_id, or stock_adjustments'
--     (entity_id, product_name) pair had one; every query against them was
--     a full sequential scan.
--  2. A per-function statement_timeout override — these two functions
--     legitimately scan more of the schema than a typical interactive
--     query, so they get more time than the project default rather than
--     raising the timeout for every query app-wide.
CREATE INDEX IF NOT EXISTS idx_invoice_lines_product_name ON invoice_lines(product_name);
CREATE INDEX IF NOT EXISTS idx_proforma_invoice_lines_product_name ON proforma_invoice_lines(product_name);
CREATE INDEX IF NOT EXISTS idx_proforma_invoices_to_entity ON proforma_invoices(to_entity_id);
CREATE INDEX IF NOT EXISTS idx_stock_adjustments_entity_product ON stock_adjustments(entity_id, product_name);

-- Partial index matching stock_actual_position's exact movement-qualifying
-- filter (real, non-cancelled, non-deleted, E-way-Billed, non-mirror
-- invoices) — the single most repeated condition in that function's `mov`
-- CTE, hit once per call.
CREATE INDEX IF NOT EXISTS idx_invoices_movement_qualifying
  ON invoices(seller_entity_id, buyer_entity_id)
  WHERE is_deleted = false AND status <> 'cancelled' AND eway_bill_no IS NOT NULL AND eway_bill_no <> '';

ALTER FUNCTION stock_actual_position(date)  SET statement_timeout = '30s';
ALTER FUNCTION stock_planned_position(date) SET statement_timeout = '30s';
