-- 051: stock_actual_position was summing stock_opening_balance across every
-- financial year an entity+product has ever had an opening entry, instead of
-- using only the latest one.
--
-- stock_opening_balance is a RESTATED SNAPSHOT re-entered per financial year
-- (UNIQUE(entity_id, product_name, financial_year_id) — see 001_phase1.sql),
-- not a per-year delta to be added up. Stock Position's own Opening column
-- (src/pages/Stock/index.jsx loadPosition()) already knows this and
-- explicitly keeps only the latest FY's row per entity+product ("opening
-- balances aren't re-entered every FY... keep only the latest entry" — see
-- that function's own comment). stock_actual_position's `opening` CTE never
-- got the same treatment: it does SUM(sob.qty) GROUP BY entity_id,
-- product_name over EVERY matching row, so an entity/product with an opening
-- entry in more than one FY (e.g. FY24 restated again at the start of FY25)
-- gets that stock counted once per FY it was ever entered in. This is what
-- inflated Actual Stock/Actual Value (and every view built on
-- fetchActualStockPosition — Stock Position's headline Actual Stock column,
-- the entity/category group-by totals, LineItemsEditor's available-stock
-- check, notifications' negative-stock check) while the Opening column right
-- next to it — computed with the correct dedup — showed the right number.
--
-- Fix: DISTINCT ON (entity_id, product_name), latest as_of_date wins — same
-- "latest restated balance" contract as the client-side Opening column,
-- expressed via as_of_date (the field this function already filters p_as_of
-- against) instead of financial_year_id start_date. Ties (same as_of_date)
-- broken by created_at so the result is deterministic.
--
-- CREATE OR REPLACE is fine here — only the `opening` CTE's internals change,
-- the function's own signature (params/return columns) is untouched.
CREATE OR REPLACE FUNCTION stock_actual_position(p_as_of date DEFAULT NULL)
RETURNS TABLE (
  entity_id          uuid,
  product_name       text,
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
    SELECT sa.entity_id, sa.product_name, SUM(sa.qty_delta) AS qty
    FROM stock_adjustments sa
    WHERE p_as_of IS NULL OR sa.adjustment_date IS NULL OR sa.adjustment_date <= p_as_of
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
  )
  SELECT
    k.entity_id,
    k.product_name,
    COALESCE(o.qty, 0)  AS opening_qty,
    COALESCE(i.qty, 0)  AS invoiced_in,
    COALESCE(ot.qty, 0) AS invoiced_out,
    COALESCE(a.qty, 0)  AS adjustment_qty,
    COALESCE(o.qty, 0) + COALESCE(i.qty, 0) - COALESCE(ot.qty, 0) + COALESCE(a.qty, 0) AS actual_qty,
    COALESCE(r.rate, 0) AS last_purchase_rate
  FROM keys k
  LEFT JOIN opening o      ON o.entity_id  = k.entity_id AND o.product_name  IS NOT DISTINCT FROM k.product_name
  LEFT JOIN inflow i       ON i.entity_id  = k.entity_id AND i.product_name  IS NOT DISTINCT FROM k.product_name
  LEFT JOIN outflow ot     ON ot.entity_id = k.entity_id AND ot.product_name IS NOT DISTINCT FROM k.product_name
  LEFT JOIN adj a          ON a.entity_id  = k.entity_id AND a.product_name  IS NOT DISTINCT FROM k.product_name
  LEFT JOIN ranked_rates r ON r.entity_id  = k.entity_id AND r.product_name  IS NOT DISTINCT FROM k.product_name AND r.rn = 1
$$;

GRANT EXECUTE ON FUNCTION stock_actual_position(date) TO authenticated;
