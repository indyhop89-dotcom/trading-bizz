-- 053: expose offloaded_qty separately from stock_actual_position
--
-- Migration 052 excluded 'offloaded' adjustments from actual_qty (marking
-- something offloaded is a reporting statement, not a stock movement — see
-- that migration's header). That broke a real, separate feature: Opening
-- Stock's "hide offloaded stock" toggle and Stock Position's "hide sold-out
-- products" toggle both decide what to hide by checking whether actual_qty
-- is (approximately) zero — that was offloaded's entire mechanism for
-- disappearing from those lists. With offloaded excluded from actual_qty, a
-- product that's only ever been offloaded (never actually invoiced out)
-- keeps sitting at its pre-offload quantity and never gets hidden.
--
-- Fix: return offloaded_qty (sum of qty_delta where reason = 'offloaded',
-- always <= 0) as its own column, so callers can compute
-- actual_qty + offloaded_qty — exactly the pre-052 formula — as a purely
-- LOCAL "is there anything left once offloaded stock is accounted for"
-- check for those two toggles, without changing what actual_qty itself
-- means or is used for everywhere else (Stock Position's headline number,
-- the available-stock check when billing, notifications). This is
-- deliberately NOT the old "ever had an offloaded adjustment" boolean flag
-- (removed in an earlier fix, see Stock/index.jsx's OpeningStock comments)
-- — it's a live number, so a genuine restock after an offload still shows
-- up correctly instead of being permanently blacklisted.
--
-- DROP + CREATE (not CREATE OR REPLACE) — adding an output column is a
-- signature change (see 044's own header comment for the same rule).
DROP FUNCTION IF EXISTS stock_actual_position(date);

CREATE FUNCTION stock_actual_position(p_as_of date DEFAULT NULL)
RETURNS TABLE (
  entity_id          uuid,
  product_name       text,
  opening_qty        numeric,
  invoiced_in        numeric,
  invoiced_out       numeric,
  adjustment_qty     numeric,
  offloaded_qty      numeric,
  actual_qty         numeric,
  last_purchase_rate numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH opening AS (
    SELECT DISTINCT ON (sob.entity_id, sob.product_name)
           sob.entity_id, sob.product_name, sob.qty
    FROM stock_opening_balance sob
    WHERE p_as_of IS NULL OR sob.as_of_date IS NULL OR sob.as_of_date <= p_as_of
    ORDER BY sob.entity_id, sob.product_name, sob.as_of_date DESC NULLS LAST, sob.created_at DESC
  ),
  mov AS (
    SELECT il.product_name, i.seller_entity_id, i.buyer_entity_id, il.qty,
           il.rate, COALESCE(i.eway_bill_date, i.invoice_date) AS rate_date
    FROM invoice_lines il
    JOIN invoices i ON i.id = il.invoice_id
    WHERE i.is_deleted = false
      AND i.status <> 'cancelled'
      AND i.eway_bill_no IS NOT NULL AND i.eway_bill_no <> ''
      AND NOT (i.invoice_type = 'purchase' AND i.source_invoice_id IS NOT NULL)
      AND (p_as_of IS NULL OR COALESCE(i.eway_bill_date, i.invoice_date) IS NULL
           OR COALESCE(i.eway_bill_date, i.invoice_date) <= p_as_of)
  ),
  inflow AS (
    SELECT m.buyer_entity_id AS entity_id, m.product_name, SUM(m.qty) AS qty
    FROM mov m GROUP BY m.buyer_entity_id, m.product_name
  ),
  outflow AS (
    SELECT m.seller_entity_id AS entity_id, m.product_name, SUM(m.qty) AS qty
    FROM mov m GROUP BY m.seller_entity_id, m.product_name
  ),
  adj AS (
    -- 'offloaded' excluded — see migration 052.
    SELECT sa.entity_id, sa.product_name, SUM(sa.qty_delta) AS qty
    FROM stock_adjustments sa
    WHERE sa.reason <> 'offloaded'
      AND (p_as_of IS NULL OR sa.adjustment_date IS NULL OR sa.adjustment_date <= p_as_of)
    GROUP BY sa.entity_id, sa.product_name
  ),
  offloaded AS (
    SELECT sa.entity_id, sa.product_name, SUM(sa.qty_delta) AS qty
    FROM stock_adjustments sa
    WHERE sa.reason = 'offloaded'
      AND (p_as_of IS NULL OR sa.adjustment_date IS NULL OR sa.adjustment_date <= p_as_of)
    GROUP BY sa.entity_id, sa.product_name
  ),
  rate_candidates AS (
    SELECT sob.entity_id, sob.product_name, sob.rate, sob.as_of_date AS rate_date, 0 AS src_priority
    FROM stock_opening_balance sob
    WHERE sob.rate IS NOT NULL AND sob.rate <> 0
      AND (p_as_of IS NULL OR sob.as_of_date IS NULL OR sob.as_of_date <= p_as_of)
    UNION ALL
    SELECT m.buyer_entity_id, m.product_name, m.rate, m.rate_date, 1 AS src_priority
    FROM mov m
    WHERE m.rate IS NOT NULL AND m.rate <> 0
  ),
  ranked_rates AS (
    SELECT entity_id, product_name, rate,
           ROW_NUMBER() OVER (
             PARTITION BY entity_id, product_name
             ORDER BY rate_date DESC NULLS LAST, src_priority DESC
           ) AS rn
    FROM rate_candidates
  ),
  keys AS (
    SELECT o.entity_id, o.product_name FROM opening o
    UNION SELECT i.entity_id, i.product_name FROM inflow i
    UNION SELECT ot.entity_id, ot.product_name FROM outflow ot
    UNION SELECT a.entity_id, a.product_name FROM adj a
    UNION SELECT of2.entity_id, of2.product_name FROM offloaded of2
  )
  SELECT
    k.entity_id,
    k.product_name,
    COALESCE(o.qty, 0)   AS opening_qty,
    COALESCE(i.qty, 0)   AS invoiced_in,
    COALESCE(ot.qty, 0)  AS invoiced_out,
    COALESCE(a.qty, 0)   AS adjustment_qty,
    COALESCE(of2.qty, 0) AS offloaded_qty,
    COALESCE(o.qty, 0) + COALESCE(i.qty, 0) - COALESCE(ot.qty, 0) + COALESCE(a.qty, 0) AS actual_qty,
    COALESCE(r.rate, 0) AS last_purchase_rate
  FROM keys k
  LEFT JOIN opening o      ON o.entity_id  = k.entity_id AND o.product_name  IS NOT DISTINCT FROM k.product_name
  LEFT JOIN inflow i       ON i.entity_id  = k.entity_id AND i.product_name  IS NOT DISTINCT FROM k.product_name
  LEFT JOIN outflow ot     ON ot.entity_id = k.entity_id AND ot.product_name IS NOT DISTINCT FROM k.product_name
  LEFT JOIN adj a          ON a.entity_id  = k.entity_id AND a.product_name  IS NOT DISTINCT FROM k.product_name
  LEFT JOIN offloaded of2  ON of2.entity_id = k.entity_id AND of2.product_name IS NOT DISTINCT FROM k.product_name
  LEFT JOIN ranked_rates r ON r.entity_id  = k.entity_id AND r.product_name  IS NOT DISTINCT FROM k.product_name AND r.rn = 1
$$;

GRANT EXECUTE ON FUNCTION stock_actual_position(date) TO authenticated;
