-- ============================================================================
-- resync_cargo_status_from_eway_bill.sql
--
-- order_legs.cargo_status (shown on Document Database) was never touched by
-- the E-way Bill save flow — only movement_status was. So a leg whose invoice
-- already has an E-way Bill on file (i.e. cargo has actually left the seller)
-- could still read 'awaiting_cargo' forever, unless someone remembered to
-- edit the leg by hand. Fixed going forward in
-- src/pages/Invoices/index.jsx (saveEwbForm now also sets cargo_status).
-- This backfills legs already affected.
--
-- Only bumps legs still sitting on the default 'awaiting_cargo' — never
-- downgrades a leg that's already progressed further (cargo_received,
-- ready_for_pi, ready_for_invoice, completed).
--
-- Wrapped in a transaction. Check the PREVIEW rows, then COMMIT (or ROLLBACK).
-- ============================================================================

begin;

-- ── PREVIEW: legs stuck on 'awaiting_cargo' despite an EWB already on file ──
select l.id, l.order_id, l.leg_no, l.cargo_status, l.movement_status,
       i.invoice_no, i.eway_bill_no, i.eway_bill_date
from order_legs l
join invoices i on i.order_leg_id = l.id
where l.cargo_status = 'awaiting_cargo'
  and i.eway_bill_no is not null
  and i.is_deleted = false;

-- ── FIX ───────────────────────────────────────────────────────────────────
update order_legs l set
  cargo_status = 'cargo_dispatched'
from invoices i
where i.order_leg_id = l.id
  and l.cargo_status = 'awaiting_cargo'
  and i.eway_bill_no is not null
  and i.is_deleted = false;

-- ── VERIFY: should return zero rows ──────────────────────────────────────────
select l.id, l.order_id, l.leg_no, l.cargo_status
from order_legs l
join invoices i on i.order_leg_id = l.id
where l.cargo_status = 'awaiting_cargo'
  and i.eway_bill_no is not null
  and i.is_deleted = false;

commit;   -- or:  rollback;
