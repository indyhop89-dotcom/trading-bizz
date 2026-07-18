-- ============================================================================
-- resync_converted_pi_status.sql
--
-- Root cause for PI/LS/01 (and any other PI stuck on status='converted' with
-- no matching invoice): deleting an invoice only ever set invoices.is_deleted
-- = true — it never reverted the source PI's status or cleared
-- converted_to_invoice_id. Every invoice list/detail query filters
-- is_deleted=false, so the PI looks "converted" with nothing to show for it.
-- Fixed going forward in src/pages/Invoices/index.jsx (handleDelete /
-- handleBulkDelete now reopen the PI). This script repairs PIs already
-- affected by the historical bug.
--
-- Wrapped in a transaction. Check the PREVIEW rows, then COMMIT (or ROLLBACK).
-- ============================================================================

begin;

-- ── PREVIEW: PIs marked converted with no live invoice behind them ──────────
select p.id, p.pi_no, p.status, p.converted_to_invoice_id,
       i.id as invoice_id, i.is_deleted as invoice_is_deleted
from proforma_invoices p
left join invoices i on i.id = p.converted_to_invoice_id and i.is_deleted = false
where p.status = 'converted' and p.is_deleted = false and i.id is null;

-- ── FIX: reopen those PIs so they show up as needing conversion again ───────
update proforma_invoices p set
  status = 'accepted',
  converted_to_invoice_id = null,
  updated_at = now()
where p.status = 'converted' and p.is_deleted = false
  and not exists (
    select 1 from invoices i
    where i.id = p.converted_to_invoice_id and i.is_deleted = false
  );

-- ── VERIFY: should return zero rows ──────────────────────────────────────────
select p.id, p.pi_no, p.status
from proforma_invoices p
left join invoices i on i.id = p.converted_to_invoice_id and i.is_deleted = false
where p.status = 'converted' and p.is_deleted = false and i.id is null;

commit;   -- or:  rollback;
