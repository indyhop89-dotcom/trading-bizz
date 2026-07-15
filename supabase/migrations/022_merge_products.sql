-- merge_products(keeper, dup): the "Merge Stocks" tab (Stock > Adjustments
-- area) lets a user review same-name/same-HSN/different-rate product groups
-- (see findMergeSuggestionGroups in src/utils/products.js) and fold one
-- product into another. This function is the one-call, transactional version
-- of the manual dedupe_products.sql / merge_idle_rounding_duplicates.sql
-- maintenance scripts — same repoint-then-delete shape, but parameterized so
-- the UI can invoke it per pair without hand-chaining a dozen non-atomic
-- client-side updates for an operation this destructive (real inventory
-- quantities move, product rows get deleted).
--
-- Repoints every table that references products.id, folds
-- stock_opening_balance quantities into the keeper (per entity+FY) instead of
-- overwriting, then deletes the now-unreferenced duplicate. Restricted to
-- 'master' — unlike routine product edits (products_write allows
-- 'entity_user' too), this can move stock across entities the caller may not
-- otherwise have access to, so it needs the same trust level as cross-entity
-- reporting, checked here (not just in the UI) since this function runs
-- SECURITY DEFINER and therefore bypasses the per-entity RLS on
-- stock_opening_balance/stock_adjustments.
CREATE OR REPLACE FUNCTION merge_products(p_keeper_id uuid, p_dup_id uuid)
RETURNS jsonb AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'master') THEN
    RAISE EXCEPTION 'Only master users can merge products';
  END IF;

  IF p_keeper_id = p_dup_id THEN
    RAISE EXCEPTION 'keeper and duplicate product must be different';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM products WHERE id = p_keeper_id) THEN
    RAISE EXCEPTION 'keeper product % not found', p_keeper_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM products WHERE id = p_dup_id) THEN
    RAISE EXCEPTION 'duplicate product % not found', p_dup_id;
  END IF;

  UPDATE invoice_lines           SET product_id = p_keeper_id WHERE product_id = p_dup_id;
  UPDATE proforma_invoice_lines  SET product_id = p_keeper_id WHERE product_id = p_dup_id;
  UPDATE purchase_order_lines    SET product_id = p_keeper_id WHERE product_id = p_dup_id;
  UPDATE credit_debit_note_lines SET product_id = p_keeper_id WHERE product_id = p_dup_id;
  UPDATE stock_movements         SET product_id = p_keeper_id WHERE product_id = p_dup_id;
  UPDATE leg_stock_items         SET product_id = p_keeper_id WHERE product_id = p_dup_id;
  UPDATE stock_adjustments       SET product_id = p_keeper_id WHERE product_id = p_dup_id;

  -- Fold matching (entity, fy) opening rows: ADD dup's qty onto keeper's row
  -- rather than dropping it — this is real physical stock, not a display dup.
  UPDATE stock_opening_balance ob_keeper
  SET qty = ob_keeper.qty + ob_dup.qty
  FROM stock_opening_balance ob_dup
  WHERE ob_keeper.product_id = p_keeper_id
    AND ob_dup.product_id = p_dup_id
    AND ob_keeper.entity_id = ob_dup.entity_id
    AND ob_keeper.financial_year_id = ob_dup.financial_year_id;

  -- Where keeper has no row yet for that (entity, fy), just repoint dup's row
  UPDATE stock_opening_balance ob_dup
  SET product_id = p_keeper_id
  WHERE ob_dup.product_id = p_dup_id
    AND NOT EXISTS (
      SELECT 1 FROM stock_opening_balance ob2
      WHERE ob2.product_id = p_keeper_id
        AND ob2.entity_id = ob_dup.entity_id
        AND ob2.financial_year_id = ob_dup.financial_year_id
    );

  -- Any leftover dup rows (already folded above) can now go
  DELETE FROM stock_opening_balance WHERE product_id = p_dup_id;

  DELETE FROM products WHERE id = p_dup_id;

  SELECT jsonb_build_object('keeper_id', p_keeper_id, 'merged_id', p_dup_id) INTO v_result;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION merge_products(uuid, uuid) TO authenticated;
