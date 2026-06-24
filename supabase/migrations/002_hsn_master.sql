-- HSN Master table
CREATE TABLE IF NOT EXISTS hsn_master (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hsn_code    text NOT NULL,
  description text,
  rate_type   text NOT NULL DEFAULT 'fixed',
  fixed_rate  numeric(5,2),
  slabs       jsonb,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  CONSTRAINT hsn_master_hsn_code_unique UNIQUE (hsn_code),
  CONSTRAINT hsn_master_rate_type_check CHECK (rate_type IN ('fixed', 'slab'))
);

CREATE INDEX IF NOT EXISTS idx_hsn_master_code ON hsn_master(hsn_code);

ALTER TABLE hsn_master ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hsn_master_read_all" ON hsn_master
  FOR SELECT USING (true);

CREATE POLICY "hsn_master_write_master" ON hsn_master
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role = 'master'
    )
  );

-- Seed examples (max_rate in PAISE — 100000 paise = ₹1000)
INSERT INTO hsn_master (hsn_code, description, rate_type, fixed_rate, slabs) VALUES
  ('6109', 'T-shirts, singlets and vests, knitted', 'slab', NULL,
   '[{"max_rate": 100000, "gst_rate": 5}, {"max_rate": null, "gst_rate": 12}]'::jsonb),
  ('6110', 'Jerseys, pullovers, sweatshirts, knitted', 'slab', NULL,
   '[{"max_rate": 100000, "gst_rate": 5}, {"max_rate": null, "gst_rate": 12}]'::jsonb),
  ('6201', 'Mens overcoats, capes, anoraks', 'slab', NULL,
   '[{"max_rate": 100000, "gst_rate": 5}, {"max_rate": null, "gst_rate": 12}]'::jsonb),
  ('6204', 'Womens suits, dresses, skirts', 'slab', NULL,
   '[{"max_rate": 100000, "gst_rate": 5}, {"max_rate": null, "gst_rate": 12}]'::jsonb),
  ('5208', 'Woven fabrics of cotton >= 85%, <= 200g/m2', 'fixed', 5, NULL),
  ('5209', 'Woven fabrics of cotton >= 85%, > 200g/m2', 'fixed', 5, NULL),
  ('5407', 'Woven fabrics of synthetic filament yarn', 'fixed', 5, NULL)
ON CONFLICT (hsn_code) DO NOTHING;
