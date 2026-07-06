-- ============================================================================
-- dedupe_rate_markup_products.sql
--
-- Fixes the "billed beyond stock everywhere" problem caused by a specific
-- flavour of duplicate product: a PI/PO/Invoice line was raised at a rate
-- exactly 0.5% above an existing product's rate (e.g. a margin/markup step
-- during PI creation), and since product matching requires an EXACT rate
-- match (same name + HSN + rate + GST = same product, by design, so that
-- genuinely different designs sharing a name don't get merged), that 0.5%
-- difference silently spawned a brand-new "phantom" product with zero
-- opening stock instead of reusing the real one. Every line billed against
-- that phantom then looked like it was selling from nothing.
--
-- This only touches pairs where:
--   - names match once trailing ')'/space junk is stripped
--   - HSN codes match exactly
--   - the "phantom" has NO opening stock anywhere
--   - a "canonical" sibling with the same name+HSN DOES have opening stock
--   - phantom.default_rate is within a hair of canonical.default_rate * 1.005
-- That signature is specific enough that it won't catch genuinely different
-- designs that happen to share a name (those have unrelated rates), or
-- legitimate new products that simply haven't had opening stock uploaded
-- yet (their rate won't line up with the 1.005 ratio by coincidence).
--
-- Only product_id references are repointed — the rate/amount actually
-- billed on each line is a column on the line itself and is left untouched,
-- so no invoice/PI/PO totals change. Only which product the line is tied to
-- for stock-tracking purposes changes.
--
-- Wrapped in a transaction. Check the pairs_to_fix count and the verify
-- block (should be all zeros) before trusting the commit.
-- ============================================================================

begin;

create temp table phantom_fix on commit drop as
select
  phantom.id as phantom_id, canon.id as canon_id
from products phantom
join products canon
  on lower(btrim(regexp_replace(canon.name, '[)[:space:]]+$', '')))
   = lower(btrim(regexp_replace(phantom.name, '[)[:space:]]+$', '')))
 and canon.hsn_code = phantom.hsn_code
 and canon.id <> phantom.id
where not exists (select 1 from stock_opening_balance sob where sob.product_id = phantom.id)
  and exists (select 1 from stock_opening_balance sob where sob.product_id = canon.id)
  and abs(phantom.default_rate / nullif(canon.default_rate,0) - 1.005) < 0.0005;

-- PREVIEW
select count(*) as pairs_to_fix from phantom_fix;

update proforma_invoice_lines  l set product_id = f.canon_id from phantom_fix f where l.product_id = f.phantom_id;
update purchase_order_lines    l set product_id = f.canon_id from phantom_fix f where l.product_id = f.phantom_id;
update invoice_lines           l set product_id = f.canon_id from phantom_fix f where l.product_id = f.phantom_id;
update credit_debit_note_lines l set product_id = f.canon_id from phantom_fix f where l.product_id = f.phantom_id;
update stock_movements         m set product_id = f.canon_id from phantom_fix f where m.product_id = f.phantom_id;

-- VERIFY: all five counts should be zero
select 'proforma_invoice_lines' t, count(*) from proforma_invoice_lines l join phantom_fix f on f.phantom_id = l.product_id
union all
select 'purchase_order_lines', count(*) from purchase_order_lines l join phantom_fix f on f.phantom_id = l.product_id
union all
select 'invoice_lines', count(*) from invoice_lines l join phantom_fix f on f.phantom_id = l.product_id
union all
select 'credit_debit_note_lines', count(*) from credit_debit_note_lines l join phantom_fix f on f.phantom_id = l.product_id
union all
select 'stock_movements', count(*) from stock_movements m join phantom_fix f on f.phantom_id = m.product_id;

-- now safe to delete the phantom product rows
delete from products p using phantom_fix f where p.id = f.phantom_id;

commit;   -- or: rollback
