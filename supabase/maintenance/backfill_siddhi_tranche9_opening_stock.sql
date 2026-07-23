-- One-off data backfill — NOT a schema migration, run manually once.
--
-- Context: "tranche 9" — 1,06,461.5 Mtrs of fabric that Siddhi sold to VRVPL
-- via SR/26-27/003, SR/26-27/004, SR/26-27/005 (25 Jun 2026) and which then
-- circulated Siddhi -> VRVPL -> MVL -> Anugan -> Siddhi (twice, with a KLB
-- detour on the second pass) before landing back with Siddhi on 6 Jul 2026.
-- User confirmed this invoice chain is real and correct.
--
-- Because Siddhi's very first sale in that chain (25 Jun) was recorded
-- against zero opening stock — no purchase-in or opening-balance row ever
-- established where the batch originally came from — Actual Stock's running
-- total for these 4 products nets to exactly zero for every entity in the
-- loop, including Siddhi, even though Siddhi is really holding the goods
-- right now. Backfilling Siddhi's true starting balance shifts the whole
-- ledger so it correctly lands on Siddhi instead of washing out to zero.
--
-- Values: qty is what Siddhi's own first-sale invoice lines record for each
-- product (they sum to exactly 1,06,461.5); rate is each invoice line's own
-- rate (real cost basis at the time, not a generic product default);
-- as_of_date is FY 2026-27's start (2026-04-01) — any date before
-- 2026-06-25 works, since that's when the chain began.
--
-- Safe to re-run: ON CONFLICT targets the (entity_id, product_name,
-- financial_year_id) unique constraint added in migration 046, so a second
-- run is a no-op rather than a duplicate-key error or a doubled quantity.
INSERT INTO stock_opening_balance
  (entity_id, product_name, financial_year_id, qty, unit, rate, hsn_code, gst_rate, as_of_date, notes)
VALUES
  ((SELECT id FROM entities WHERE short_name = 'Siddhi' LIMIT 1),
   'Fabrics (Alabaster, Alice Blue, Almond Green',
   (SELECT id FROM financial_years WHERE name = 'FY 2026-27' LIMIT 1),
   47608.68, 'Mtr', 97.85, '52114200', 5, '2026-04-01',
   'Initial stock — tranche 9 opening balance (reconstructed)'),

  ((SELECT id FROM entities WHERE short_name = 'Siddhi' LIMIT 1),
   'Fabrics (White, Canary Yellow, Dusty Pink, LGreen',
   (SELECT id FROM financial_years WHERE name = 'FY 2026-27' LIMIT 1),
   19569.82, 'Mtr', 180.25, '52091111', 5, '2026-04-01',
   'Initial stock — tranche 9 opening balance (reconstructed)'),

  ((SELECT id FROM entities WHERE short_name = 'Siddhi' LIMIT 1),
   'FABRICS ASSORTED - (L Blue, L Pink, White, P Green, D Blue',
   (SELECT id FROM financial_years WHERE name = 'FY 2026-27' LIMIT 1),
   25000, 'Mtr', 139.15, '52081220', 5, '2026-04-01',
   'Initial stock — tranche 9 opening balance (reconstructed)'),

  ((SELECT id FROM entities WHERE short_name = 'Siddhi' LIMIT 1),
   'Suitings',
   (SELECT id FROM financial_years WHERE name = 'FY 2026-27' LIMIT 1),
   14283, 'Mtr', 419.75, '540752', 5, '2026-04-01',
   'Initial stock — tranche 9 opening balance (reconstructed)')

ON CONFLICT (entity_id, product_name, financial_year_id) DO NOTHING;
