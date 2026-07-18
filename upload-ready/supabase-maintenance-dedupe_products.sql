-- ============================================================================
-- dedupe_products.sql
--
-- Fixes the "stock won't reconcile" problem caused by duplicate product records
-- whose only difference is trailing junk in the name, e.g.
--   'Braided Jute Spiral Sun Placemats Set of 4'     (opening stock is here)
--   'Braided Jute Spiral Sun Placemats Set of 4))'   (the invoice booked here)
--
-- For each group of products that are identical once trailing ')' and spaces
-- are removed, it picks ONE canonical keeper (preferring the product that
-- already holds opening stock, then the cleanest name, then the oldest id),
-- repoints every child table from the duplicates to the keeper, cleans the
-- keeper's name, and deletes the duplicates.
--
-- Wrapped in a transaction. Inspect the preview counts, then COMMIT (or
-- ROLLBACK to back out with zero changes).
-- ============================================================================

begin;

-- 1. Build dup -> keeper map, grouping by name with trailing ')'/space removed
create temp table product_merge on commit drop as
with cleaned as (
  select p.id, p.name,
    lower(btrim(regexp_replace(p.name, '[)[:space:]]+$', ''))) as ckey,
    exists(select 1 from stock_opening_balance o where o.product_id = p.id) as has_opening
  from products p
),
ranked as (
  select id, name, ckey, has_opening,
    row_number() over (
      partition by ckey
      order by has_opening desc,                       -- keep the one with opening stock
               (name ~ '[)[:space:]]$')::int asc,       -- then the already-clean name
               id asc                                   -- then oldest
    ) as rn
  from cleaned
),
keepers as (select ckey, id as keeper_id from ranked where rn = 1)
select r.id as dup_id, k.keeper_id, r.ckey
from ranked r
join keepers k on k.ckey = r.ckey
where r.id <> k.keeper_id;

-- PREVIEW — how many products collapse
select count(*) as duplicate_products_to_remove,
       count(distinct keeper_id) as canonical_products_kept
from product_merge;

-- 2. Repoint every table that references products
update invoice_lines           t set product_id = m.keeper_id from product_merge m where t.product_id = m.dup_id;
update proforma_invoice_lines   t set product_id = m.keeper_id from product_merge m where t.product_id = m.dup_id;
update purchase_order_lines     t set product_id = m.keeper_id from product_merge m where t.product_id = m.dup_id;
update credit_debit_note_lines  t set product_id = m.keeper_id from product_merge m where t.product_id = m.dup_id;
update stock_movements          t set product_id = m.keeper_id from product_merge m where t.product_id = m.dup_id;
update leg_stock_items          t set product_id = m.keeper_id from product_merge m where t.product_id = m.dup_id;

-- stock_opening_balance has a UNIQUE(entity_id, product_id, financial_year_id);
-- only repoint where it won't collide, then drop any leftover dup rows.
update stock_opening_balance o set product_id = m.keeper_id
from product_merge m
where o.product_id = m.dup_id
  and not exists (
    select 1 from stock_opening_balance o2
    where o2.product_id = m.keeper_id
      and o2.entity_id = o.entity_id
      and o2.financial_year_id = o.financial_year_id
  );
delete from stock_opening_balance o using product_merge m where o.product_id = m.dup_id;

-- 3. Clean the keeper names (strip trailing ')' and spaces)
update products
set name = btrim(regexp_replace(name, '[)[:space:]]+$', ''))
where name ~ '[)[:space:]]$';

-- 4. Delete the now-unreferenced duplicate products
delete from products p using product_merge m where p.id = m.dup_id;

-- 5. VERIFY — total should now equal distinct names, and the sample product
--    should show opening + invoice on the SAME product_id
select count(*) as total_products, count(distinct lower(btrim(name))) as distinct_names from products;

select 'opening' as src, o.product_id, o.qty, p.name
from stock_opening_balance o join products p on p.id = o.product_id
where lower(p.name) like 'braided jute spiral%'
union all
select 'invoice' as src, il.product_id, il.qty, p.name
from invoice_lines il join products p on p.id = il.product_id
where lower(p.name) like 'braided jute spiral%';

commit;   -- or:  rollback;
