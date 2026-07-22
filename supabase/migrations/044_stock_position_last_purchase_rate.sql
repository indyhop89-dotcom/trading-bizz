-- 044: value stock at the LAST PURCHASE rate, not a weighted average
--
-- stock_actual_position (migration 041) returned avg_in_rate — a weighted
-- average of opening-balance rate and every purchased-in invoice rate ever
-- recorded for that entity+product. Averaging blends old and new prices
-- together, so a product bought cheaply a year ago and again recently at a
-- higher rate showed a blended figure that matched neither purchase. The
-- user wants current-facing valuation to reflect the LATEST known rate, not
-- a historical blend.
--
-- Replaces avg_in_rate with last_purchase_rate: for each entity+product,
-- whichever is more recent — the entity's own opening-balance entry (dated
-- by as_of_date) or its most recent real purchase-in invoice line (dated by
-- E-way Bill date, falling back to invoice date, same as every other
-- as-of-date rule in this app) — using THAT single row's rate. Zero/null
-- rates are never eligible (a real purchase is never free), and an
-- as-of-date query (p_as_of) only considers candidates dated on or before
-- that day, same as every other figure this function returns.
--
-- DROP + CREATE (not CREATE OR REPLACE) because Postgres won't let a
-- function's OUTPUT COLUMN be renamed in place (avg_in_rate ->
-- last_purchase_rate) via CREATE OR REPLACE — that's a signature change.

DROP FUNCTION IF EXISTS stock_actual_position(date);

CREATE FUNCTION stock_actual_position(p_as_of date DEFAULT NULL)
RETURNS TABLE (
  entity_id          uuid,
  product_id         uuid,
  opening_qty        numeric,
  invoiced_in        numeric,
  invoiced_out       numeric,
  adjustment_qty     numeric,
  actual_qty         numeric,
  last_purchase_rate numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH opening AS (
    SELECT sob.entity_id, sob.product_id, SUM(sob.qty) AS qty
    FROM stock_opening_balance sob
    WHERE p_as_of IS NULL OR sob.as_of_date IS NULL OR sob.as_of_date <= p_as_of
    GROUP BY sob.entity_id, sob.product_id
  ),
  mov AS (
    SELECT il.product_id, i.seller_entity_id, i.buyer_entity_id, il.qty,
           il.rate, COALESCE(i.eway_bill_date, i.invoice_date) AS rate_date
    FROM invoice_lines il
    JOIN invoices i ON i.id = il.invoice_id
    WHERE i.is_deleted = false
      AND i.status NOT IN ('draft', 'cancelled')
      AND i.eway_bill_no IS NOT NULL AND i.eway_bill_no <> ''
      AND NOT (i.invoice_type = 'purchase' AND i.source_invoice_id IS NOT NULL)
      AND (p_as_of IS NULL OR COALESCE(i.eway_bill_date, i.invoice_date) IS NULL
           OR COALESCE(i.eway_bill_date, i.invoice_date) <= p_as_of)
  ),
  inflow AS (
    SELECT m.buyer_entity_id AS entity_id, m.product_id, SUM(m.qty) AS qty
    FROM mov m GROUP BY m.buyer_entity_id, m.product_id
  ),
  outflow AS (
    SELECT m.seller_entity_id AS entity_id, m.product_id, SUM(m.qty) AS qty
    FROM mov m GROUP BY m.seller_entity_id, m.product_id
  ),
  adj AS (
    SELECT sa.entity_id, sa.product_id, SUM(sa.qty_delta) AS qty
    FROM stock_adjustments sa
    WHERE p_as_of IS NULL OR sa.adjustment_date IS NULL OR sa.adjustment_date <= p_as_of
    GROUP BY sa.entity_id, sa.product_id
  ),
  -- Every candidate "we acquired this at rate R on date D" event, from either
  -- source, tagged with a source priority so a same-day tie prefers the real
  -- purchase invoice over the opening-balance estimate.
  rate_candidates AS (
    SELECT sob.entity_id, sob.product_id, sob.rate, sob.as_of_date AS rate_date, 0 AS src_priority
    FROM stock_opening_balance sob
    WHERE sob.rate IS NOT NULL AND sob.rate <> 0
      AND (p_as_of IS NULL OR sob.as_of_date IS NULL OR sob.as_of_date <= p_as_of)
    UNION ALL
    SELECT m.buyer_entity_id, m.product_id, m.rate, m.rate_date, 1 AS src_priority
    FROM mov m
    WHERE m.rate IS NOT NULL AND m.rate <> 0
  ),
  ranked_rates AS (
    SELECT entity_id, product_id, rate,
           ROW_NUMBER() OVER (
             PARTITION BY entity_id, product_id
             ORDER BY rate_date DESC NULLS LAST, src_priority DESC
           ) AS rn
    FROM rate_candidates
  ),
  keys AS (
    SELECT o.entity_id, o.product_id FROM opening o
    UNION SELECT i.entity_id, i.product_id FROM inflow i
    UNION SELECT ot.entity_id, ot.product_id FROM outflow ot
    UNION SELECT a.entity_id, a.product_id FROM adj a
  )
  SELECT
    k.entity_id,
    k.product_id,
    COALESCE(o.qty, 0)  AS opening_qty,
    COALESCE(i.qty, 0)  AS invoiced_in,
    COALESCE(ot.qty, 0) AS invoiced_out,
    COALESCE(a.qty, 0)  AS adjustment_qty,
    COALESCE(o.qty, 0) + COALESCE(i.qty, 0) - COALESCE(ot.qty, 0) + COALESCE(a.qty, 0) AS actual_qty,
    COALESCE(r.rate, 0) AS last_purchase_rate
  FROM keys k
  LEFT JOIN opening o      ON o.entity_id  = k.entity_id AND o.product_id  IS NOT DISTINCT FROM k.product_id
  LEFT JOIN inflow i       ON i.entity_id  = k.entity_id AND i.product_id  IS NOT DISTINCT FROM k.product_id
  LEFT JOIN outflow ot     ON ot.entity_id = k.entity_id AND ot.product_id IS NOT DISTINCT FROM k.product_id
  LEFT JOIN adj a          ON a.entity_id  = k.entity_id AND a.product_id  IS NOT DISTINCT FROM k.product_id
  LEFT JOIN ranked_rates r ON r.entity_id  = k.entity_id AND r.product_id  IS NOT DISTINCT FROM k.product_id AND r.rn = 1
$$;

GRANT EXECUTE ON FUNCTION stock_actual_position(date) TO authenticated;
