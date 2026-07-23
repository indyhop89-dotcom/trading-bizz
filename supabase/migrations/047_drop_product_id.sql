-- 047: drop product_id everywhere, now that product_name is live
--
-- DO NOT RUN THIS until 046 has been applied AND the application (updated in
-- the same change as 046) has been confirmed working end-to-end against
-- product_name — this is the irreversible half of the switch: once these
-- columns are dropped, the old uuid links are gone for good.

-- CASCADE so stock_opening_balance's composite UNIQUE(entity_id, product_id,
-- financial_year_id) — whose auto-generated name we don't want to guess at —
-- drops along with the column, instead of erroring. Nothing outside these
-- tables' own constraints depends on product_id (it's always the referencing
-- side of the FK to products.id, never referenced BY anything else), so
-- CASCADE has no wider blast radius here.
ALTER TABLE invoice_lines           DROP COLUMN product_id CASCADE;
ALTER TABLE proforma_invoice_lines  DROP COLUMN product_id CASCADE;
ALTER TABLE purchase_order_lines    DROP COLUMN product_id CASCADE;
ALTER TABLE credit_debit_note_lines DROP COLUMN product_id CASCADE;
ALTER TABLE stock_movements         DROP COLUMN product_id CASCADE;
ALTER TABLE leg_stock_items         DROP COLUMN product_id CASCADE;
ALTER TABLE stock_adjustments       DROP COLUMN product_id CASCADE;
ALTER TABLE stock_opening_balance   DROP COLUMN product_id CASCADE;
