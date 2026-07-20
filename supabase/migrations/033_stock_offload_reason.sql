-- Adds 'offloaded' as a stock_adjustments reason — for stock that has left
-- the system for reasons this tool doesn't track transactions for (sold
-- outside the tool, physically disposed of, given away, etc.), as opposed
-- to a correction of a miscount (shortfall/damage/found/recount). This tool
-- tracks transactions, not a full ERP's physical inventory lifecycle — once
-- a batch of stock is done being tracked here, this reason lets it be
-- removed from Actual Stock without mislabeling it as a "damage" or
-- "shortfall" correction.
--
-- P&L (Reports > P&L / Profitability) is unaffected by this or any other
-- stock_adjustments row — it's computed purely from invoice/expense
-- transaction data (see src/pages/Reports/index.jsx's PLReport), which
-- never reads stock_adjustments at all. Offloading only changes Actual
-- Stock (src/utils/stock.js's buildActualStockMap), same as every other
-- adjustment reason already does.
-- Idempotent — safe to run this file more than once (drops both
-- constraints by name pattern before re-adding them, rather than a plain
-- ADD CONSTRAINT that errors on a second run with "already exists").
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'stock_adjustments'::regclass AND contype = 'c'
      AND (conname LIKE '%reason%' OR conname LIKE '%offloaded%')
  LOOP
    EXECUTE format('ALTER TABLE stock_adjustments DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE stock_adjustments
  ADD CONSTRAINT stock_adjustments_reason_check
  CHECK (reason IN ('shortfall', 'damage', 'found', 'recount', 'offloaded', 'other'));

-- Offloading can only ever remove stock — an "offloaded" row with a
-- positive qty_delta would mean stock arrived from nowhere, which isn't
-- what this reason means (use 'found' for that).
ALTER TABLE stock_adjustments
  ADD CONSTRAINT stock_adjustments_offloaded_is_negative_check
  CHECK (reason <> 'offloaded' OR qty_delta < 0);
