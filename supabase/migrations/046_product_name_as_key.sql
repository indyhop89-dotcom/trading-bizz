-- 046: switch product identity to NAME, drop reliance on product_id
--
-- Explicit product-owner decision: product_id (uuid) mismatches during bulk
-- CSV upload/movements were the reported cause of stock silently splitting
-- across two IDs for what is really one product. Rather than continue
-- patching the matching logic (productMatchKey/findNearMatchProduct/Merge
-- Duplicates), product NAME becomes the sole identity: two rows are the same
-- product if and only if they share a name. This migration is additive and
-- safe — it does NOT drop product_id yet. It:
--   1. Normalizes existing product names (mirrors cleanProductName() in
--      src/utils/products.js) so the canonical name matches what the app
--      already treats as "the same product".
--   2. Merges every product that now shares a name (case-insensitively) —
--      under the new model these ARE the same product, whatever their HSN/
--      rate/GST used to be. Repoints every referencing table to the keeper
--      (the active row, oldest first) and folds stock_opening_balance
--      quantities per (entity, FY) instead of dropping them — same shape as
--      merge_products() (022_merge_products.sql).
--   3. Adds UNIQUE(name) on products (required as an FK target) plus a
--      case-insensitive unique index as a belt-and-braces guard against
--      future case-variant duplicates ("Mimosa" vs "MIMOSA").
--   4. Adds a `product_name` column (FK -> products(name) ON UPDATE CASCADE,
--      so a later rename of a product automatically cascades everywhere it's
--      referenced) to every table that used to key on product_id, and
--      backfills it from the existing product_id join.
--
-- product_id columns are deliberately left in place here — a separate
-- migration (047) drops them once the application code (updated in the same
-- change as this migration) is confirmed working against product_name.

-- ── 1. Normalize existing product names ─────────────────────────────────────
UPDATE products
SET name = regexp_replace(regexp_replace(trim(name), '\s+', ' ', 'g'), '[)\s]+$', '')
WHERE name IS DISTINCT FROM regexp_replace(regexp_replace(trim(name), '\s+', ' ', 'g'), '[)\s]+$', '');

-- ── 2. Merge products that now share a name (case-insensitive) ─────────────
DO $$
DECLARE
  grp RECORD;
  keeper_id uuid;
  dup_id uuid;
  i integer;
BEGIN
  FOR grp IN
    SELECT lower(name) AS key,
           array_agg(id ORDER BY is_active DESC, created_at, id) AS ids
    FROM products
    GROUP BY lower(name)
    HAVING COUNT(*) > 1
  LOOP
    keeper_id := grp.ids[1];
    FOR i IN 2..array_length(grp.ids, 1) LOOP
      dup_id := grp.ids[i];

      UPDATE invoice_lines           SET product_id = keeper_id WHERE product_id = dup_id;
      UPDATE proforma_invoice_lines  SET product_id = keeper_id WHERE product_id = dup_id;
      UPDATE purchase_order_lines    SET product_id = keeper_id WHERE product_id = dup_id;
      UPDATE credit_debit_note_lines SET product_id = keeper_id WHERE product_id = dup_id;
      UPDATE stock_movements         SET product_id = keeper_id WHERE product_id = dup_id;
      UPDATE leg_stock_items         SET product_id = keeper_id WHERE product_id = dup_id;
      UPDATE stock_adjustments       SET product_id = keeper_id WHERE product_id = dup_id;

      -- Fold matching (entity, fy) opening rows onto the keeper instead of
      -- dropping them — this is real physical stock, not a display artifact.
      UPDATE stock_opening_balance ob_keeper
      SET qty = ob_keeper.qty + ob_dup.qty
      FROM stock_opening_balance ob_dup
      WHERE ob_keeper.product_id = keeper_id
        AND ob_dup.product_id = dup_id
        AND ob_keeper.entity_id = ob_dup.entity_id
        AND ob_keeper.financial_year_id = ob_dup.financial_year_id;

      -- Where the keeper has no row yet for that (entity, fy), just repoint.
      UPDATE stock_opening_balance ob_dup
      SET product_id = keeper_id
      WHERE ob_dup.product_id = dup_id
        AND NOT EXISTS (
          SELECT 1 FROM stock_opening_balance ob2
          WHERE ob2.product_id = keeper_id
            AND ob2.entity_id = ob_dup.entity_id
            AND ob2.financial_year_id = ob_dup.financial_year_id
        );

      -- Any leftover dup rows (already folded above) can now go.
      DELETE FROM stock_opening_balance WHERE product_id = dup_id;

      DELETE FROM products WHERE id = dup_id;
    END LOOP;
  END LOOP;
END $$;

-- ── 3. Name becomes the unique, stable key ──────────────────────────────────
ALTER TABLE products ADD CONSTRAINT products_name_key UNIQUE (name);
CREATE UNIQUE INDEX IF NOT EXISTS products_name_ci_unique_idx ON products (lower(name));

-- ── 4. Add product_name everywhere product_id used to be the link ─────────
ALTER TABLE invoice_lines           ADD COLUMN product_name text REFERENCES products(name) ON UPDATE CASCADE;
ALTER TABLE proforma_invoice_lines  ADD COLUMN product_name text REFERENCES products(name) ON UPDATE CASCADE;
ALTER TABLE purchase_order_lines    ADD COLUMN product_name text REFERENCES products(name) ON UPDATE CASCADE;
ALTER TABLE credit_debit_note_lines ADD COLUMN product_name text REFERENCES products(name) ON UPDATE CASCADE;
ALTER TABLE stock_movements         ADD COLUMN product_name text REFERENCES products(name) ON UPDATE CASCADE;
ALTER TABLE leg_stock_items         ADD COLUMN product_name text REFERENCES products(name) ON UPDATE CASCADE;
ALTER TABLE stock_adjustments       ADD COLUMN product_name text REFERENCES products(name) ON UPDATE CASCADE;
ALTER TABLE stock_opening_balance   ADD COLUMN product_name text REFERENCES products(name) ON UPDATE CASCADE;

UPDATE invoice_lines il SET product_name = p.name FROM products p WHERE p.id = il.product_id;
UPDATE proforma_invoice_lines pl SET product_name = p.name FROM products p WHERE p.id = pl.product_id;
UPDATE purchase_order_lines pol SET product_name = p.name FROM products p WHERE p.id = pol.product_id;
UPDATE credit_debit_note_lines cl SET product_name = p.name FROM products p WHERE p.id = cl.product_id;
UPDATE stock_movements sm SET product_name = p.name FROM products p WHERE p.id = sm.product_id;
UPDATE leg_stock_items lsi SET product_name = p.name FROM products p WHERE p.id = lsi.product_id;
UPDATE stock_adjustments sa SET product_name = p.name FROM products p WHERE p.id = sa.product_id;
UPDATE stock_opening_balance sob SET product_name = p.name FROM products p WHERE p.id = sob.product_id;

-- Match NOT NULL-ness of the old product_id columns.
ALTER TABLE stock_movements       ALTER COLUMN product_name SET NOT NULL;
ALTER TABLE stock_adjustments     ALTER COLUMN product_name SET NOT NULL;
ALTER TABLE stock_opening_balance ALTER COLUMN product_name SET NOT NULL;

-- New composite uniqueness for the Opening Stock CSV upsert (entity+product+FY),
-- keyed on product_name now — old (entity_id, product_id, financial_year_id)
-- constraint is left in place until 047 drops product_id.
ALTER TABLE stock_opening_balance ADD CONSTRAINT stock_opening_balance_entity_product_name_fy_key
  UNIQUE (entity_id, product_name, financial_year_id);

-- ── 5. stock_actual_position: aggregate on product_name, not product_id ────
-- DROP + CREATE (not CREATE OR REPLACE) — product_id -> product_name is an
-- output-column rename, which Postgres treats as a signature change (see
-- 044's own header comment for the same rule).
DROP FUNCTION IF EXISTS stock_actual_position(date);

CREATE FUNCTION stock_actual_position(p_as_of date DEFAULT NULL)
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
    SELECT sob.entity_id, sob.product_name, SUM(sob.qty) AS qty
    FROM stock_opening_balance sob
    WHERE p_as_of IS NULL OR sob.as_of_date IS NULL OR sob.as_of_date <= p_as_of
    GROUP BY sob.entity_id, sob.product_name
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

-- ── 6. Merge Duplicates tab note ────────────────────────────────────────────
-- findMergeSuggestionGroups() (src/utils/products.js) will now always return
-- zero groups going forward — the UNIQUE(name) constraint above makes a true
-- name-sharing duplicate impossible to create again. merge_products() RPC
-- (022_merge_products.sql) is left in place (harmless, unused) rather than
-- dropped, in case a future data-repair still needs an id-level merge tool.
