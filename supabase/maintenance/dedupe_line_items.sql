-- ============================================================================
-- dedupe_line_items.sql
--
-- Removes duplicate line rows that piled up on invoices / PIs / POs during the
-- earlier line-duplication + product-merge cascade. Keeps ONE line per
-- (parent, product), renumbers line_no, and recomputes each parent header's
-- tax/total amounts from the cleaned lines so the totals match reality.
--
-- Dedup key is (parent_id, product_id) with product_id NOT NULL — a product
-- should appear at most once per document, and every surviving copy of the
-- same product on the same document is identical (same qty/rate), so keeping
-- one is correct. Lines with a NULL product_id are left untouched.
--
-- Wrapped in a transaction. Check the PREVIEW counts, then COMMIT (or ROLLBACK).
-- ============================================================================

begin;

-- ── PREVIEW: how many duplicate lines each table will lose ──────────────────
select 'invoice_lines' t, count(*) dup_lines from invoice_lines a
  where exists (select 1 from invoice_lines b where b.invoice_id=a.invoice_id and b.product_id=a.product_id and b.ctid<a.ctid)
union all
select 'proforma_invoice_lines', count(*) from proforma_invoice_lines a
  where exists (select 1 from proforma_invoice_lines b where b.pi_id=a.pi_id and b.product_id=a.product_id and b.ctid<a.ctid)
union all
select 'purchase_order_lines', count(*) from purchase_order_lines a
  where exists (select 1 from purchase_order_lines b where b.po_id=a.po_id and b.product_id=a.product_id and b.ctid<a.ctid);

-- ── INVOICES ────────────────────────────────────────────────────────────────
delete from invoice_lines a using invoice_lines b
where a.invoice_id = b.invoice_id and a.product_id = b.product_id and a.ctid > b.ctid;

with r as (select id, row_number() over (partition by invoice_id order by line_no, id) rn from invoice_lines)
update invoice_lines il set line_no = r.rn from r where r.id = il.id;

update invoices i set
  taxable_amount=t.taxable, cgst_amount=t.cgst, sgst_amount=t.sgst, igst_amount=t.igst,
  total_amount=t.total, outstanding_amount=greatest(0, t.total - coalesce(i.paid_amount,0))
from (select invoice_id,
        coalesce(sum(taxable_amount),0) taxable, coalesce(sum(cgst_amount),0) cgst,
        coalesce(sum(sgst_amount),0) sgst, coalesce(sum(igst_amount),0) igst,
        coalesce(sum(total_amount),0) total
      from invoice_lines group by invoice_id) t
where i.id = t.invoice_id;

-- ── PROFORMA INVOICES ────────────────────────────────────────────────────────
delete from proforma_invoice_lines a using proforma_invoice_lines b
where a.pi_id = b.pi_id and a.product_id = b.product_id and a.ctid > b.ctid;

with r as (select id, row_number() over (partition by pi_id order by line_no, id) rn from proforma_invoice_lines)
update proforma_invoice_lines pil set line_no = r.rn from r where r.id = pil.id;

update proforma_invoices p set
  taxable_amount=t.taxable, cgst_amount=t.cgst, sgst_amount=t.sgst, igst_amount=t.igst, total_amount=t.total
from (select pi_id,
        coalesce(sum(taxable_amount),0) taxable, coalesce(sum(cgst_amount),0) cgst,
        coalesce(sum(sgst_amount),0) sgst, coalesce(sum(igst_amount),0) igst,
        coalesce(sum(total_amount),0) total
      from proforma_invoice_lines group by pi_id) t
where p.id = t.pi_id;

-- ── PURCHASE ORDERS ──────────────────────────────────────────────────────────
delete from purchase_order_lines a using purchase_order_lines b
where a.po_id = b.po_id and a.product_id = b.product_id and a.ctid > b.ctid;

with r as (select id, row_number() over (partition by po_id order by line_no, id) rn from purchase_order_lines)
update purchase_order_lines pol set line_no = r.rn from r where r.id = pol.id;

update purchase_orders p set
  taxable_amount=t.taxable, cgst_amount=t.cgst, sgst_amount=t.sgst, igst_amount=t.igst, total_amount=t.total
from (select po_id,
        coalesce(sum(taxable_amount),0) taxable, coalesce(sum(cgst_amount),0) cgst,
        coalesce(sum(sgst_amount),0) sgst, coalesce(sum(igst_amount),0) igst,
        coalesce(sum(total_amount),0) total
      from purchase_order_lines group by po_id) t
where p.id = t.po_id;

-- ── VERIFY: all three should return ZERO rows ────────────────────────────────
select 'invoice_lines' t, invoice_id::text parent, product_id, count(*) copies
  from invoice_lines group by invoice_id, product_id having count(*) > 1
union all
select 'proforma_invoice_lines', pi_id::text, product_id, count(*)
  from proforma_invoice_lines group by pi_id, product_id having count(*) > 1
union all
select 'purchase_order_lines', po_id::text, product_id, count(*)
  from purchase_order_lines group by po_id, product_id having count(*) > 1;

commit;   -- or:  rollback;
