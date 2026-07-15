-- Manual stock adjustments — corrections for shortfalls, damage, recounts,
-- found stock, etc. that don't come from a PI/PO/Invoice. Follows the exact
-- shape/RLS convention of stock_opening_balance and stock_movements
-- (001_phase1.sql) rather than inventing a new pattern.
--
-- qty_delta is signed: positive = stock increase (found/recount-up),
-- negative = stock decrease (shortfall/damage/recount-down). This mirrors how
-- src/utils/stock.js already folds opening_qty + invoiced_in - invoiced_out
-- into actual_qty — one more signed source, no separate in/out columns needed.
CREATE TABLE stock_adjustments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid REFERENCES entities NOT NULL,
  product_id      uuid REFERENCES products NOT NULL,
  qty_delta       numeric(15,3) NOT NULL CHECK (qty_delta <> 0),
  reason          text NOT NULL CHECK (reason IN ('shortfall', 'damage', 'found', 'recount', 'other')),
  notes           text,
  adjustment_date date NOT NULL DEFAULT current_date,
  created_by      uuid REFERENCES profiles,
  created_at      timestamptz DEFAULT now()
);

ALTER TABLE stock_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "stock_adj_access" ON stock_adjustments FOR ALL
  USING (user_has_entity_access(entity_id));
