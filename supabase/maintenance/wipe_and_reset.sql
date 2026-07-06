-- ============================================================================
-- wipe_and_reset.sql  —  fresh start for Trading Bizz
--
-- KEEPS (master / config / users — untouched):
--   entities, entity_groups, financial_years, hsn_master, expense_categories,
--   banks, profiles, user_entity_access, audit_log
--
-- WIPES (all products + every transaction, and resets numbering counters).
--
-- The wipe is a DO block that truncates ONLY the tables that actually exist on
-- this database (via to_regclass), so it can't fail on a table that was never
-- created live (e.g. the old `bill_discounting`). It runs inside an explicit
-- transaction so you can inspect the STEP 3 verify counts and COMMIT or
-- ROLLBACK.
-- ============================================================================

-- ── STEP 1 — see what you have now ─────────────────────────────────────────
select 'products' t, count(*) n from products
union all select 'stock_opening_balance', count(*) from stock_opening_balance
union all select 'proforma_invoices', count(*) from proforma_invoices
union all select 'proforma_invoice_lines', count(*) from proforma_invoice_lines
union all select 'invoices', count(*) from invoices
union all select 'invoice_lines', count(*) from invoice_lines
union all select 'orders', count(*) from orders
union all select 'expenses', count(*) from expenses;

-- ── STEP 2 — the wipe (skips any table that doesn't exist) ──────────────────
begin;

do $$
declare
  t text;
  wanted text[] := array[
    'proforma_invoice_lines','proforma_invoices',
    'purchase_order_lines','purchase_orders',
    'invoice_lines','invoices','tds_tcs_entries',
    'credit_debit_note_lines','credit_debit_notes',
    'leg_stock_items','leg_document_checklist','order_legs','orders',
    'documents',
    'expense_payments','expenses',
    'invoice_payments','payment_allocations','payments',
    'bill_discounting_repayments','bill_discounting_invoices','bill_discounting_events','bill_discounting',
    'stock_movements','stock_opening_balance',
    'notifications',
    'products',
    'pi_sequence','po_sequence','inv_sequence','order_sequence','exp_sequence','pay_sequence','bd_sequence'
  ];
  present text[] := '{}';
begin
  foreach t in array wanted loop
    if to_regclass(t) is not null then
      present := array_append(present, t);
    end if;
  end loop;

  if array_length(present, 1) is not null then
    execute 'truncate table ' || array_to_string(present, ', ') || ' restart identity cascade';
    raise notice 'Truncated (% tables): %', array_length(present,1), array_to_string(present, ', ');
  else
    raise notice 'Nothing to truncate — no target tables found.';
  end if;
end $$;

-- ── STEP 3 — verify wiped = 0, masters intact ──────────────────────────────
select 'products (want 0)'            t, count(*) n from products
union all select 'invoices (want 0)',       count(*) from invoices
union all select 'proforma_invoices (0)',   count(*) from proforma_invoices
union all select 'stock_opening_balance(0)',count(*) from stock_opening_balance
union all select 'orders (want 0)',         count(*) from orders
union all select '--- KEPT BELOW ---',       0
union all select 'entities (keep)',          count(*) from entities
union all select 'financial_years (keep)',   count(*) from financial_years
union all select 'hsn_master (keep)',        count(*) from hsn_master
union all select 'profiles (keep)',          count(*) from profiles
union all select 'user_entity_access (keep)',count(*) from user_entity_access;

commit;   -- or:  rollback;  if anything above looks wrong
