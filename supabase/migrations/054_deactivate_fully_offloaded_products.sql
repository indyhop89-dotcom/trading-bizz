-- 054: one-time backfill — deactivate products that are already fully
-- offloaded everywhere, now that the corrupted stock_adjustments data for
-- Siddhi (duplicate 'offloaded' rows, a bogus 'recount' zero-out batch, and a
-- matching 'found' compensation batch — all inserted directly against the DB
-- outside the app on 2026-08-07/08, not real user actions) has been deleted.
--
-- Going forward, src/utils/stock.js's deactivateFullyOffloadedProducts() does
-- this automatically the moment an 'offloaded' adjustment is saved through
-- the app. This migration is only needed to catch products that were already
-- fully offloaded BEFORE that auto-deactivation code existed.
--
-- Scoped to products that have at least one 'offloaded' adjustment (avoids a
-- full-table scan over every product), computed once via CTE so
-- stock_actual_position() runs a single time rather than per-row.
WITH position AS (
  SELECT * FROM stock_actual_position(NULL)
),
offloaded_products AS (
  SELECT DISTINCT product_name FROM stock_adjustments WHERE reason = 'offloaded'
),
zero_everywhere AS (
  SELECT op.product_name
  FROM offloaded_products op
  WHERE NOT EXISTS (
    SELECT 1 FROM position pos
    WHERE pos.product_name = op.product_name
      AND ABS(pos.actual_qty + pos.offloaded_qty) > 0.001
  )
)
UPDATE products
SET is_active = false, updated_at = now()
WHERE name IN (SELECT product_name FROM zero_everywhere)
  AND is_active = true;
