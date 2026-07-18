-- ============================================================================
-- merge_idle_rounding_duplicates.sql
--
-- Fixes a second flavour of the "billed beyond stock" problem, distinct from
-- dedupe_rate_markup_products.sql's uniform-0.5%-markup case: two product
-- rows for the same real item ended up a hair apart in rate (e.g. 469.70 vs
-- 469.71 — a rounding artifact from different upload/calculation paths, not
-- a deliberate markup), splitting one item's stock across two SKUs. One row
-- sits idle holding some opening stock that was never sold; its sibling
-- holds the rest of the opening stock AND carries all the actual sales, so
-- it looks oversold even though the total physical stock was enough.
--
-- Criterion: a product is an "idle duplicate" if it has opening stock but
-- has NEVER appeared on any PI/PO/Invoice/credit-debit-note line, AND a
-- same-name (junk-stripped) + same-HSN sibling exists that HAS been used on
-- at least one such line, AND that sibling's rate is within 0.05% of the
-- idle product's rate (tight enough to only catch rounding noise — a
-- genuinely different design at a different price point differs by far
-- more than that and won't match).
--
-- For each match, the idle product's opening-stock quantity is ADDED onto
-- the active sibling's opening-stock row for the same (entity, financial
-- year) — not dropped, unlike a naive "keep one, delete the other" dedupe —
-- then the now-empty idle product is removed. No PI/PO/Invoice line is
-- touched: the active product was already the one every real document
-- refers to, so there's nothing to repoint.
--
-- Wrapped in a transaction. Check idle_products_to_merge, then COMMIT (or
-- ROLLBACK to back out with zero changes).
-- ============================================================================

begin;

create temp table idle_dupes on commit drop as
select distinct on (idle.id)
  idle.id as idle_id,
  active.id as active_id,
  idle.name, idle.default_rate as idle_rate, active.default_rate as active_rate
from products idle
join products active
  on lower(btrim(regexp_replace(active.name, '[)[:space:]]+$', '')))
   = lower(btrim(regexp_replace(idle.name, '[)[:space:]]+$', '')))
 and active.hsn_code = idle.hsn_code
 and active.id <> idle.id
where exists (select 1 from stock_opening_balance sob where sob.product_id = idle.id)
  and not exists (select 1 from proforma_invoice_lines l where l.product_id = idle.id)
  and not exists (select 1 from purchase_order_lines l where l.product_id = idle.id)
  and not exists (select 1 from invoice_lines l where l.product_id = idle.id)
  and not exists (select 1 from credit_debit_note_lines l where l.product_id = idle.id)
  and (
    exists (select 1 from proforma_invoice_lines l where l.product_id = active.id)
    or exists (select 1 from purchase_order_lines l where l.product_id = active.id)
    or exists (select 1 from invoice_lines l where l.product_id = active.id)
    or exists (select 1 from credit_debit_note_lines l where l.product_id = active.id)
  )
  and abs(idle.default_rate - active.default_rate) / nullif(active.default_rate, 0) < 0.0005
order by idle.id, abs(idle.default_rate - active.default_rate) asc;

-- PREVIEW
select * from idle_dupes order by name;
select count(*) as idle_products_to_merge from idle_dupes;

-- Fold matching (entity, fy) opening rows: ADD idle's qty onto active's row
update stock_opening_balance ob_active
set qty = ob_active.qty + ob_idle.qty
from stock_opening_balance ob_idle
join idle_dupes d on d.idle_id = ob_idle.product_id
where ob_active.product_id = d.active_id
  and ob_active.entity_id = ob_idle.entity_id
  and ob_active.financial_year_id = ob_idle.financial_year_id;

-- Where active has no row yet for that (entity, fy), just repoint idle's row
update stock_opening_balance ob_idle
set product_id = d.active_id
from idle_dupes d
where ob_idle.product_id = d.idle_id
  and not exists (
    select 1 from stock_opening_balance ob2
    where ob2.product_id = d.active_id
      and ob2.entity_id = ob_idle.entity_id
      and ob2.financial_year_id = ob_idle.financial_year_id
  );

-- Any leftover idle rows (already merged into active above) can now go
delete from stock_opening_balance ob using idle_dupes d where ob.product_id = d.idle_id;

-- Idle products are now fully unreferenced everywhere; remove them
delete from products p using idle_dupes d where p.id = d.idle_id;

commit;   -- or: rollback
