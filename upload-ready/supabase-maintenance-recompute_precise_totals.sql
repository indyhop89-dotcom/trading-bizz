-- ============================================================================
-- recompute_precise_totals.sql
--
-- The app used to round every line's taxable_amount/cgst/sgst/igst/
-- total_amount to a whole rupee before storing them (roundRupees()), even
-- though the DB columns are numeric(15,2) and can hold real paise precision
-- (see migration 003_money_columns.sql). That per-line whole-rupee rounding
-- is what caused header totals to drift from the true value on documents
-- with many lines / fractional quantities.
--
-- The app now rounds to 2dp throughout (see src/utils/tax.js, src/components/
-- LineItemsEditor.jsx) and only applies a final round2() adjustment on the
-- summed header total. This script recomputes every EXISTING line's taxable/
-- tax/total amounts at full 2dp precision from its stored qty, rate, and
-- gst_rate (both already had adequate precision — qty is numeric(15,3), rate
-- is numeric(15,2) since migration 003 — only the derived amounts were
-- needlessly rounded away), then re-sums each parent header from the
-- corrected lines.
--
-- Wrapped in a transaction. Check the PREVIEW diffs, then COMMIT (or ROLLBACK).
-- ============================================================================

begin;

-- ── PREVIEW: how much each header's total_amount will change ────────────────
select 'proforma_invoices' t, count(*) changed, sum(abs(new_total - old_total)) total_drift
from (
  select p.id, p.total_amount old_total, coalesce(sum(
    round(l.qty * l.rate, 2)
    + case when p.is_interstate then round(round(l.qty*l.rate,2) * l.gst_rate / 100, 2)
           else 2 * round(round(l.qty*l.rate,2) * (l.gst_rate/2) / 100, 2) end
  ), 0) new_total
  from proforma_invoices p left join proforma_invoice_lines l on l.pi_id = p.id
  group by p.id, p.total_amount, p.is_interstate
) d where round(new_total,2) != round(old_total,2)
union all
select 'purchase_orders', count(*), sum(abs(new_total - old_total))
from (
  select p.id, p.total_amount old_total, coalesce(sum(
    round(l.qty * l.rate, 2)
    + case when p.is_interstate then round(round(l.qty*l.rate,2) * l.gst_rate / 100, 2)
           else 2 * round(round(l.qty*l.rate,2) * (l.gst_rate/2) / 100, 2) end
  ), 0) new_total
  from purchase_orders p left join purchase_order_lines l on l.po_id = p.id
  group by p.id, p.total_amount, p.is_interstate
) d where round(new_total,2) != round(old_total,2)
union all
select 'invoices', count(*), sum(abs(new_total - old_total))
from (
  select i.id, i.total_amount old_total, coalesce(sum(
    round(l.qty * l.rate, 2)
    + case when i.is_interstate then round(round(l.qty*l.rate,2) * l.gst_rate / 100, 2)
           else 2 * round(round(l.qty*l.rate,2) * (l.gst_rate/2) / 100, 2) end
  ), 0) new_total
  from invoices i left join invoice_lines l on l.invoice_id = i.id
  group by i.id, i.total_amount, i.is_interstate
) d where round(new_total,2) != round(old_total,2);

-- ── PROFORMA INVOICE LINES: recompute each line at full 2dp precision ───────
update proforma_invoice_lines l set
  taxable_amount = round(l.qty * l.rate, 2),
  cgst_rate = case when p.is_interstate then 0 else round(l.gst_rate/2, 2) end,
  cgst_amount = case when p.is_interstate then 0 else round(round(l.qty*l.rate,2) * (l.gst_rate/2) / 100, 2) end,
  sgst_rate = case when p.is_interstate then 0 else round(l.gst_rate/2, 2) end,
  sgst_amount = case when p.is_interstate then 0 else round(round(l.qty*l.rate,2) * (l.gst_rate/2) / 100, 2) end,
  igst_rate = case when p.is_interstate then l.gst_rate else 0 end,
  igst_amount = case when p.is_interstate then round(round(l.qty*l.rate,2) * l.gst_rate / 100, 2) else 0 end,
  total_amount = round(l.qty * l.rate, 2) + (
    case when p.is_interstate then round(round(l.qty*l.rate,2) * l.gst_rate / 100, 2)
         else 2 * round(round(l.qty*l.rate,2) * (l.gst_rate/2) / 100, 2) end
  )
from proforma_invoices p where p.id = l.pi_id;

update proforma_invoices p set
  taxable_amount=t.taxable, cgst_amount=t.cgst, sgst_amount=t.sgst, igst_amount=t.igst, total_amount=t.total
from (select pi_id,
        coalesce(sum(taxable_amount),0) taxable, coalesce(sum(cgst_amount),0) cgst,
        coalesce(sum(sgst_amount),0) sgst, coalesce(sum(igst_amount),0) igst,
        coalesce(sum(total_amount),0) total
      from proforma_invoice_lines group by pi_id) t
where p.id = t.pi_id;

-- ── PURCHASE ORDER LINES ─────────────────────────────────────────────────────
update purchase_order_lines l set
  taxable_amount = round(l.qty * l.rate, 2),
  cgst_rate = case when po.is_interstate then 0 else round(l.gst_rate/2, 2) end,
  cgst_amount = case when po.is_interstate then 0 else round(round(l.qty*l.rate,2) * (l.gst_rate/2) / 100, 2) end,
  sgst_rate = case when po.is_interstate then 0 else round(l.gst_rate/2, 2) end,
  sgst_amount = case when po.is_interstate then 0 else round(round(l.qty*l.rate,2) * (l.gst_rate/2) / 100, 2) end,
  igst_rate = case when po.is_interstate then l.gst_rate else 0 end,
  igst_amount = case when po.is_interstate then round(round(l.qty*l.rate,2) * l.gst_rate / 100, 2) else 0 end,
  total_amount = round(l.qty * l.rate, 2) + (
    case when po.is_interstate then round(round(l.qty*l.rate,2) * l.gst_rate / 100, 2)
         else 2 * round(round(l.qty*l.rate,2) * (l.gst_rate/2) / 100, 2) end
  )
from purchase_orders po where po.id = l.po_id;

update purchase_orders po set
  taxable_amount=t.taxable, cgst_amount=t.cgst, sgst_amount=t.sgst, igst_amount=t.igst, total_amount=t.total
from (select po_id,
        coalesce(sum(taxable_amount),0) taxable, coalesce(sum(cgst_amount),0) cgst,
        coalesce(sum(sgst_amount),0) sgst, coalesce(sum(igst_amount),0) igst,
        coalesce(sum(total_amount),0) total
      from purchase_order_lines group by po_id) t
where po.id = t.po_id;

-- ── INVOICE LINES ────────────────────────────────────────────────────────────
update invoice_lines l set
  taxable_amount = round(l.qty * l.rate, 2),
  cgst_rate = case when i.is_interstate then 0 else round(l.gst_rate/2, 2) end,
  cgst_amount = case when i.is_interstate then 0 else round(round(l.qty*l.rate,2) * (l.gst_rate/2) / 100, 2) end,
  sgst_rate = case when i.is_interstate then 0 else round(l.gst_rate/2, 2) end,
  sgst_amount = case when i.is_interstate then 0 else round(round(l.qty*l.rate,2) * (l.gst_rate/2) / 100, 2) end,
  igst_rate = case when i.is_interstate then l.gst_rate else 0 end,
  igst_amount = case when i.is_interstate then round(round(l.qty*l.rate,2) * l.gst_rate / 100, 2) else 0 end,
  total_amount = round(l.qty * l.rate, 2) + (
    case when i.is_interstate then round(round(l.qty*l.rate,2) * l.gst_rate / 100, 2)
         else 2 * round(round(l.qty*l.rate,2) * (l.gst_rate/2) / 100, 2) end
  )
from invoices i where i.id = l.invoice_id;

update invoices i set
  taxable_amount=t.taxable, cgst_amount=t.cgst, sgst_amount=t.sgst, igst_amount=t.igst,
  total_amount=t.total, outstanding_amount=greatest(0, t.total - coalesce(i.paid_amount,0))
from (select invoice_id,
        coalesce(sum(taxable_amount),0) taxable, coalesce(sum(cgst_amount),0) cgst,
        coalesce(sum(sgst_amount),0) sgst, coalesce(sum(igst_amount),0) igst,
        coalesce(sum(total_amount),0) total
      from invoice_lines group by invoice_id) t
where i.id = t.invoice_id;

commit;   -- or:  rollback;
