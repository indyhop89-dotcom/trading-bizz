-- ─── Seed Data for Testing ────────────────────────────────────────────────────
-- Run this ONLY on development / local. Do not run on production.

-- ── Financial Years ───────────────────────────────────────────────────────────
INSERT INTO financial_years (name, start_date, end_date, is_active) VALUES
  ('FY 2024-25', '2024-04-01', '2025-03-31', false),
  ('FY 2025-26', '2025-04-01', '2026-03-31', true)
ON CONFLICT DO NOTHING;

-- ── Entity Groups ─────────────────────────────────────────────────────────────
INSERT INTO entity_groups (id, name, description) VALUES
  ('11111111-0000-0000-0000-000000000001', 'Vananam Group', 'Main holding group')
ON CONFLICT DO NOTHING;

-- ── Entities ──────────────────────────────────────────────────────────────────
INSERT INTO entities (id, group_id, name, short_name, type, gstin, pan, state_code, state_name, city, phone, email, is_active) VALUES
  ('22222222-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'Siddhi Garments Pvt Ltd',        'Siddi',  'associate', '29AABCS1234A1Z5', 'AABCS1234A', '29', 'Karnataka', 'Bangalore', '9876543210', 'siddi@vananam.in',  true),
  ('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'Vananam Retail Solutions LLP',   'Retail', 'associate', '29AABCR5678A1Z5', 'AABCR5678A', '29', 'Karnataka', 'Bangalore', '9876543211', 'retail@vananam.in', true),
  ('22222222-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000001', 'MVL Trading Pvt Ltd',            'MVL',    'associate', '24AABCM9012A1Z5', 'AABCM9012A', '24', 'Gujarat',   'Ahmedabad', '9876543212', 'mvl@vananam.in',    true),
  ('22222222-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000001', 'Vananam Group Holdings',         'VG',     'group',     '29AABCV3456A1Z5', 'AABCV3456A', '29', 'Karnataka', 'Bangalore', '9876543200', 'vg@vananam.in',     true),
  ('22222222-0000-0000-0000-000000000005', NULL,                                  'Creative Vision Textiles LLC',   'CVT',    'external',  '',               '',           '',   '',          'Dubai',     '+971501234567', 'cvt@example.com', true),
  ('22222222-0000-0000-0000-000000000006', NULL,                                  'Reliance Retail Ltd',            'Reliance','external', '27AABCR1122A1Z5', 'AABCR1122A', '27', 'Maharashtra','Mumbai',   '9876543220', 'reliance@example.com', true)
ON CONFLICT DO NOTHING;

-- ── Products ──────────────────────────────────────────────────────────────────
INSERT INTO products (id, name, hsn_code, gst_rate, unit, default_rate, is_active) VALUES
  ('33333333-0000-0000-0000-000000000001', 'T-Shirt Basic Round Neck',  '6109', 12, 'Nos', 250.00, true),
  ('33333333-0000-0000-0000-000000000002', 'Polo T-Shirt',              '6110', 12, 'Nos', 450.00, true),
  ('33333333-0000-0000-0000-000000000003', 'Cotton Woven Fabric',       '5208',  5, 'Mtr', 180.00, true),
  ('33333333-0000-0000-0000-000000000004', 'Mens Formal Shirt',         '6205', 12, 'Nos', 550.00, true),
  ('33333333-0000-0000-0000-000000000005', 'Denim Jeans',               '6203', 12, 'Nos', 800.00, true)
ON CONFLICT DO NOTHING;

-- ── HSN Master ────────────────────────────────────────────────────────────────
INSERT INTO hsn_master (hsn_code, description, rate_type, fixed_rate, slabs, is_active) VALUES
  ('6109', 'T-shirts, singlets and vests, knitted', 'slab', NULL,
   '[{"max_rate": 1000, "gst_rate": 5}, {"max_rate": null, "gst_rate": 12}]'::jsonb, true),
  ('6110', 'Jerseys, pullovers, sweatshirts, knitted', 'slab', NULL,
   '[{"max_rate": 1000, "gst_rate": 5}, {"max_rate": null, "gst_rate": 12}]'::jsonb, true),
  ('5208', 'Cotton woven fabric >= 85%, <= 200g/m2', 'fixed', 5, NULL, true),
  ('6205', 'Mens shirts', 'slab', NULL,
   '[{"max_rate": 1000, "gst_rate": 5}, {"max_rate": null, "gst_rate": 12}]'::jsonb, true),
  ('6203', 'Mens trousers, bib-overalls, jeans', 'slab', NULL,
   '[{"max_rate": 1000, "gst_rate": 5}, {"max_rate": null, "gst_rate": 12}]'::jsonb, true)
ON CONFLICT (hsn_code) DO NOTHING;

-- ── Opening Stock ─────────────────────────────────────────────────────────────
INSERT INTO stock_opening_balance (entity_id, product_id, financial_year_id, qty, rate, as_of_date)
SELECT
  e.id, p.id, fy.id,
  CASE
    WHEN e.short_name = 'Siddi'  AND p.name = 'T-Shirt Basic Round Neck' THEN 2000
    WHEN e.short_name = 'Siddi'  AND p.name = 'Polo T-Shirt'             THEN 800
    WHEN e.short_name = 'Retail' AND p.name = 'T-Shirt Basic Round Neck' THEN 500
    WHEN e.short_name = 'Retail' AND p.name = 'Mens Formal Shirt'        THEN 300
    WHEN e.short_name = 'MVL'    AND p.name = 'Denim Jeans'              THEN 400
    ELSE 0
  END AS qty,
  p.default_rate AS rate,
  '2025-04-01'::date
FROM entities e
CROSS JOIN products p
CROSS JOIN financial_years fy
WHERE e.short_name IN ('Siddi','Retail','MVL')
  AND p.name IN ('T-Shirt Basic Round Neck','Polo T-Shirt','Cotton Woven Fabric','Mens Formal Shirt','Denim Jeans')
  AND fy.name = 'FY 2025-26'
ON CONFLICT (entity_id, product_id, financial_year_id) DO NOTHING;

-- ── Orders ────────────────────────────────────────────────────────────────────
INSERT INTO orders (id, name, movement_type, status, origin_entity_id, destination_entity_id, financial_year_id) VALUES
  ('44444444-0000-0000-0000-000000000001',
   'Siddi → Retail → MVL Jun-25', 'domestic', 'in_progress',
   '22222222-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000003',
   (SELECT id FROM financial_years WHERE name = 'FY 2025-26')),
  ('44444444-0000-0000-0000-000000000002',
   'Siddi → Reliance May-25', 'export', 'open',
   '22222222-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000006',
   (SELECT id FROM financial_years WHERE name = 'FY 2025-26'))
ON CONFLICT DO NOTHING;

-- ── Order Legs ────────────────────────────────────────────────────────────────
INSERT INTO order_legs (id, order_id, leg_no, from_entity_id, to_entity_id, movement_status, cargo_status, is_interstate) VALUES
  ('55555555-0000-0000-0000-000000000001',
   '44444444-0000-0000-0000-000000000001', 1,
   '22222222-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000002',
   'delivered', 'ready_for_invoice', false),
  ('55555555-0000-0000-0000-000000000002',
   '44444444-0000-0000-0000-000000000001', 2,
   '22222222-0000-0000-0000-000000000002',
   '22222222-0000-0000-0000-000000000003',
   'in_transit', 'cargo_dispatched', true),
  ('55555555-0000-0000-0000-000000000003',
   '44444444-0000-0000-0000-000000000002', 1,
   '22222222-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000006',
   'pending', 'awaiting_cargo', true)
ON CONFLICT DO NOTHING;

-- ── Proforma Invoices ─────────────────────────────────────────────────────────
INSERT INTO proforma_invoices (id, order_id, order_leg_id, from_entity_id, to_entity_id, pi_date, valid_upto, is_interstate, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, status) VALUES
  ('66666666-0000-0000-0000-000000000001',
   '44444444-0000-0000-0000-000000000001',
   '55555555-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000002',
   '2025-06-01', '2025-07-01', false,
   185000, 11100, 11100, 0, 207200, 'accepted'),
  ('66666666-0000-0000-0000-000000000002',
   '44444444-0000-0000-0000-000000000001',
   '55555555-0000-0000-0000-000000000002',
   '22222222-0000-0000-0000-000000000002',
   '22222222-0000-0000-0000-000000000003',
   '2025-06-05', '2025-07-05', true,
   185000, 0, 0, 22200, 207200, 'sent'),
  ('66666666-0000-0000-0000-000000000003',
   '44444444-0000-0000-0000-000000000002',
   '55555555-0000-0000-0000-000000000003',
   '22222222-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000006',
   '2025-06-10', '2025-07-10', true,
   90000, 0, 0, 10800, 100800, 'draft')
ON CONFLICT DO NOTHING;

-- ── PI Lines ──────────────────────────────────────────────────────────────────
INSERT INTO proforma_invoice_lines (pi_id, line_no, product_id, description, hsn_code, qty, unit, rate, gst_rate, taxable_amount, cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount, total_amount) VALUES
  ('66666666-0000-0000-0000-000000000001', 1, '33333333-0000-0000-0000-000000000001', 'T-Shirt Basic Round Neck', '6109', 500, 'Nos', 250, 12, 125000, 6, 7500, 6, 7500, 0, 0, 140000),
  ('66666666-0000-0000-0000-000000000001', 2, '33333333-0000-0000-0000-000000000002', 'Polo T-Shirt',             '6110', 100, 'Nos', 450, 12,  45000, 6, 2700, 6, 2700, 0, 0,  50400),
  ('66666666-0000-0000-0000-000000000001', 3, '33333333-0000-0000-0000-000000000004', 'Mens Formal Shirt',        '6205',  20, 'Nos', 550, 12,  11000, 6,  660, 6,  660, 0, 0,  12320),
  ('66666666-0000-0000-0000-000000000001', 4, '33333333-0000-0000-0000-000000000003', 'Cotton Woven Fabric',      '5208',  22, 'Mtr', 180,  5,   3960, 0,    0, 0,    0, 0, 0,   4158),
  ('66666666-0000-0000-0000-000000000002', 1, '33333333-0000-0000-0000-000000000001', 'T-Shirt Basic Round Neck', '6109', 500, 'Nos', 300, 12, 150000, 0,    0, 0,    0, 12, 18000, 168000),
  ('66666666-0000-0000-0000-000000000002', 2, '33333333-0000-0000-0000-000000000002', 'Polo T-Shirt',             '6110',  50, 'Nos', 500, 12,  25000, 0,    0, 0,    0, 12,  3000,  28000),
  ('66666666-0000-0000-0000-000000000003', 1, '33333333-0000-0000-0000-000000000001', 'T-Shirt Basic Round Neck', '6109', 300, 'Nos', 250, 12,  75000, 0,    0, 0,    0, 12,  9000,  84000),
  ('66666666-0000-0000-0000-000000000003', 2, '33333333-0000-0000-0000-000000000005', 'Denim Jeans',              '6203',  10, 'Nos', 800, 12,   8000, 0,    0, 0,    0, 12,   960,   8960)
ON CONFLICT DO NOTHING;

-- ── Purchase Orders ───────────────────────────────────────────────────────────
INSERT INTO purchase_orders (id, order_id, order_leg_id, pi_id, buyer_entity_id, seller_entity_id, po_date, is_interstate, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, status) VALUES
  ('77777777-0000-0000-0000-000000000001',
   '44444444-0000-0000-0000-000000000001',
   '55555555-0000-0000-0000-000000000001',
   '66666666-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000002',
   '22222222-0000-0000-0000-000000000001',
   '2025-06-02', false, 185000, 11100, 11100, 0, 207200, 'completed')
ON CONFLICT DO NOTHING;

INSERT INTO purchase_order_lines (po_id, line_no, product_id, description, hsn_code, qty, unit, rate, gst_rate, taxable_amount, cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount, total_amount, qty_received) VALUES
  ('77777777-0000-0000-0000-000000000001', 1, '33333333-0000-0000-0000-000000000001', 'T-Shirt Basic Round Neck', '6109', 500, 'Nos', 250, 12, 125000, 6, 7500, 6, 7500, 0, 0, 140000, 500),
  ('77777777-0000-0000-0000-000000000001', 2, '33333333-0000-0000-0000-000000000002', 'Polo T-Shirt',             '6110', 100, 'Nos', 450, 12,  45000, 6, 2700, 6, 2700, 0, 0,  50400, 100)
ON CONFLICT DO NOTHING;

-- ── Invoices ──────────────────────────────────────────────────────────────────
INSERT INTO invoices (id, order_id, order_leg_id, pi_id, po_id, seller_entity_id, buyer_entity_id, invoice_date, due_date, is_interstate, invoice_type, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, paid_amount, outstanding_amount, status) VALUES
  ('88888888-0000-0000-0000-000000000001',
   '44444444-0000-0000-0000-000000000001',
   '55555555-0000-0000-0000-000000000001',
   '66666666-0000-0000-0000-000000000001',
   '77777777-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000002',
   '2025-06-10', '2025-07-10', false, 'sales',
   185000, 11100, 11100, 0, 207200, 100000, 107200, 'partial'),
  ('88888888-0000-0000-0000-000000000002',
   '44444444-0000-0000-0000-000000000002',
   '55555555-0000-0000-0000-000000000003',
   NULL, NULL,
   '22222222-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000006',
   '2025-06-15', '2025-08-15', true, 'sales',
   90000, 0, 0, 10800, 100800, 0, 100800, 'submitted')
ON CONFLICT DO NOTHING;

INSERT INTO invoice_lines (invoice_id, line_no, product_id, description, hsn_code, qty, unit, rate, gst_rate, taxable_amount, cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount, total_amount) VALUES
  ('88888888-0000-0000-0000-000000000001', 1, '33333333-0000-0000-0000-000000000001', 'T-Shirt Basic Round Neck', '6109', 500, 'Nos', 250, 12, 125000, 6, 7500, 6, 7500, 0, 0, 140000),
  ('88888888-0000-0000-0000-000000000001', 2, '33333333-0000-0000-0000-000000000002', 'Polo T-Shirt',             '6110', 100, 'Nos', 450, 12,  45000, 6, 2700, 6, 2700, 0, 0,  50400),
  ('88888888-0000-0000-0000-000000000001', 3, '33333333-0000-0000-0000-000000000004', 'Mens Formal Shirt',        '6205',  20, 'Nos', 550, 12,  11000, 6,  660, 6,  660, 0, 0,  12320),
  ('88888888-0000-0000-0000-000000000002', 1, '33333333-0000-0000-0000-000000000001', 'T-Shirt Basic Round Neck', '6109', 300, 'Nos', 250, 12,  75000, 0,    0, 0,    0, 12,  9000,  84000),
  ('88888888-0000-0000-0000-000000000002', 2, '33333333-0000-0000-0000-000000000005', 'Denim Jeans',              '6203',  10, 'Nos', 800, 12,   8000, 0,    0, 0,    0, 12,   960,   8960)
ON CONFLICT DO NOTHING;

-- ── Mark PI as converted ──────────────────────────────────────────────────────
UPDATE proforma_invoices
SET status = 'converted', converted_to_invoice_id = '88888888-0000-0000-0000-000000000001'
WHERE id = '66666666-0000-0000-0000-000000000001';

-- ── Expenses ──────────────────────────────────────────────────────────────────
INSERT INTO expenses (entity_id, order_id, expense_date, expense_type, description, amount, gst_rate, gst_amount, total_amount, vendor_name, status) VALUES
  ('22222222-0000-0000-0000-000000000001', '44444444-0000-0000-0000-000000000001', '2025-06-10', 'freight',         'Freight charges Bangalore to Ahmedabad', 15000, 18, 2700, 17700, 'FastWay Logistics', 'paid'),
  ('22222222-0000-0000-0000-000000000001', '44444444-0000-0000-0000-000000000001', '2025-06-11', 'loading',         'Loading charges at warehouse',           2500,  18,  450,  2950, 'Local Labour',      'paid'),
  ('22222222-0000-0000-0000-000000000001', '44444444-0000-0000-0000-000000000002', '2025-06-15', 'handling',        'Port handling charges Dubai export',     8000,  18, 1440,  9440, 'Port Authority',    'unpaid'),
  ('22222222-0000-0000-0000-000000000002', NULL,                                  '2025-06-12', 'brokerage',       'Brokerage for Reliance deal',            5000,  18,  900,  5900, 'Trade Brokers Ltd', 'unpaid'),
  ('22222222-0000-0000-0000-000000000001', NULL,                                  '2025-06-01', 'bank charges',    'LC charges HDFC Bank',                   3200,  18,  576,  3776, 'HDFC Bank',         'paid')
ON CONFLICT DO NOTHING;

-- ── Invoice Payments ──────────────────────────────────────────────────────────
INSERT INTO invoice_payments (entity_id, party_entity_id, invoice_id, invoice_no, invoice_date, currency, amount, advance_amount, advance_date, adjustments, due_date, actual_payment_date, exchange_rate, notes) VALUES
  ('22222222-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000002',
   '88888888-0000-0000-0000-000000000001',
   'INV-2526-001', '2025-06-10', 'INR',
   207200, 100000, '2025-06-10', 0,
   '2025-07-10', NULL, 1,
   'Partial advance received'),
  ('22222222-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000006',
   '88888888-0000-0000-0000-000000000002',
   'INV-2526-002', '2025-06-15', 'AED',
   4500, 2250, '2025-06-15', 0,
   '2025-08-15', NULL, 22.5,
   'Export invoice — AED payment')
ON CONFLICT DO NOTHING;

-- ── Expense Payments ──────────────────────────────────────────────────────────
INSERT INTO expense_payments (expense_category, expense_type, expense_tag, from_name, to_name, location, invoice_no, invoice_date, currency, amount, advance_amount, advance_date, adjustments, due_date, actual_payment_date, usd_rate, notes) VALUES
  ('Hangtags',  'Indirect', 'GiorVan', 'Creative Vision Textiles LLC', 'VVGTL', 'DXB', 'TSI-0004564', '2025-05-24', 'AED', 4200, 2100, '2025-05-24', 0, '2025-06-23', '2025-05-29', 3.67, 'Hangtag supply for summer collection'),
  ('Freight',   'Direct',   NULL,      'FastWay Logistics',            'Siddi', 'BLR', 'FW-2025-0891', '2025-06-10', 'INR', 17700, 0, NULL, 0, '2025-07-10', NULL, NULL, 'Bangalore freight charges'),
  ('Brokerage', 'Indirect', NULL,      'Trade Brokers Ltd',            'VG',    'BLR', NULL,           '2025-06-12', 'INR',  5900, 0, NULL, 0, '2025-07-12', NULL, NULL, 'Reliance deal brokerage')
ON CONFLICT DO NOTHING;

-- ── Bill Discounting ─────────────────────────────────────────────────────────
INSERT INTO bill_discounting_events (entity_id, invoice_id, bank_name, invoice_amount, discount_rate, discount_amount, net_proceeds, outstanding_amount, discounting_date, maturity_date, status, notes) VALUES
  ('22222222-0000-0000-0000-000000000001',
   '88888888-0000-0000-0000-000000000001',
   'HDFC Bank', 207200, 12.5, 6475, 200725, 200725,
   '2025-06-12', '2025-09-12', 'active',
   'Invoice discounting for working capital'),
  ('22222222-0000-0000-0000-000000000002',
   NULL,
   'ICICI Bank', 100000, 13.0, 3250, 96750, 48375,
   '2025-05-01', '2025-08-01', 'active',
   'Partially repaid')
ON CONFLICT DO NOTHING;

-- Repayment for ICICI
INSERT INTO bill_discounting_repayments (event_id, repayment_date, amount, interest_amount, total_payment, payment_mode, reference_no)
SELECT id, '2025-06-01', 48375, 1625, 50000, 'bank_transfer', 'UTR2025060112345'
FROM bill_discounting_events WHERE bank_name = 'ICICI Bank'
ON CONFLICT DO NOTHING;

-- ── Notifications ─────────────────────────────────────────────────────────────
INSERT INTO notifications (title, message, notification_type, is_read, is_dismissed, due_date) VALUES
  ('Invoice payment due soon',      'Invoice INV-2526-001 — ₹1,07,200 due on 10 Jul 2025', 'payment_due',          false, false, '2025-07-10'),
  ('Export invoice outstanding',    'Invoice INV-2526-002 — AED 4,500 due on 15 Aug 2025', 'payment_due',          false, false, '2025-08-15'),
  ('Bill discounting matures soon', 'HDFC Bank — ₹2,00,725 outstanding matures 12 Sep 2025', 'bill_discounting_due', false, false, '2025-09-12')
ON CONFLICT DO NOTHING;

