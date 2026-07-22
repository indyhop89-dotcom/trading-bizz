-- 043: open SELECT on stock_opening_balance, invoice_lines and
-- stock_adjustments to every authenticated user (same principle as 042's
-- entities_select fix — read visibility for aggregate reporting is a
-- different concern from write access, and this app's own reporting
-- features (Stock Position's "Group by entity"/cross-entity totals, GST/P&L/
-- Ledger/Ageing reports, Reconciliation) already assume org-wide read
-- visibility exists; only entities_select had actually been fixed).
--
-- Root cause: stock_select and invoice_lines_select (both from
-- 014_child_and_missing_table_rls.sql) restrict SELECT to
--   has_entity_grant(entity_id)                                  -- opening balance
--   has_entity_grant(seller_entity_id)
--     OR (has_entity_grant(buyer_entity_id) AND status <> 'draft') -- invoice lines
-- A user granted on entity A cannot see entity B's opening-stock rows at
-- all, and cannot see invoice_lines for a transaction where NEITHER side is
-- a grant they hold. Actual Stock (utils/stock.js's fetchActualStockPosition,
-- and the stock_actual_position RPC from migration 041) computes ONE
-- combined running total across every entity+product in a single query —
-- when RLS silently drops rows the current viewer isn't entitled to based on
-- entities_select's old scoping, those movements vanish from the
-- aggregation entirely, understating (or zeroing) opening/actual/planned
-- stock for the very entities the user IS supposed to see, and misattributing
-- what qty belongs to which entity once one side of a transfer goes missing.
-- This is very likely the direct cause of "stock values and their entities
-- shown is wrong" / added opening stock invoiced out across several tranches
-- "not visible".
--
-- Fix: SELECT is opened to all authenticated users on all three tables.
-- WRITE stays exactly as scoped today:
--   - stock_write (stock_opening_balance) — untouched, still has_entity_grant(entity_id)
--   - invoice_lines_write — untouched, still has_entity_grant(seller_entity_id)
--   - stock_adjustments was a single FOR ALL policy gated on
--     user_has_entity_access(entity_id) — split into stock_adj_select (open)
--     and stock_adj_write (same grant check as before, for INSERT/UPDATE/DELETE).

DROP POLICY IF EXISTS stock_select ON stock_opening_balance;
CREATE POLICY stock_select ON stock_opening_balance FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS invoice_lines_select ON invoice_lines;
CREATE POLICY invoice_lines_select ON invoice_lines FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "stock_adj_access" ON stock_adjustments;
CREATE POLICY stock_adj_select ON stock_adjustments FOR SELECT TO authenticated USING (true);
CREATE POLICY stock_adj_write ON stock_adjustments FOR INSERT WITH CHECK (user_has_entity_access(entity_id));
CREATE POLICY stock_adj_update ON stock_adjustments FOR UPDATE USING (user_has_entity_access(entity_id)) WITH CHECK (user_has_entity_access(entity_id));
CREATE POLICY stock_adj_delete ON stock_adjustments FOR DELETE USING (user_has_entity_access(entity_id));
