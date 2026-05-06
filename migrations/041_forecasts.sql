-- Migration 041 — forecasts table
CREATE TABLE IF NOT EXISTS forecasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  horizon_days INTEGER,
  roas_forecast JSONB,
  spend_forecast JSONB,
  revenue_forecast JSONB,
  ltv_forecast JSONB,
  budget_allocation_recommendation JSONB,
  narrative TEXT,
  caveats JSONB DEFAULT '[]',
  data_quality TEXT CHECK (data_quality IN ('good','limited','insufficient')),
  sample_size_days INTEGER,
  currency TEXT,
  primary_language TEXT,
  country TEXT,
  short_circuited BOOLEAN DEFAULT FALSE,
  short_circuit_reason TEXT,
  plan_used TEXT
);
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS horizon_days INTEGER;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS roas_forecast JSONB;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS spend_forecast JSONB;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS revenue_forecast JSONB;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS ltv_forecast JSONB;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS budget_allocation_recommendation JSONB;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS narrative TEXT;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS caveats JSONB DEFAULT '[]';
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS data_quality TEXT;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS sample_size_days INTEGER;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS primary_language TEXT;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS short_circuited BOOLEAN DEFAULT FALSE;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS short_circuit_reason TEXT;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS plan_used TEXT;

CREATE INDEX IF NOT EXISTS idx_forecasts_business ON forecasts(business_id);
CREATE INDEX IF NOT EXISTS idx_forecasts_generated_at ON forecasts(generated_at DESC);

ALTER TABLE forecasts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_full_forecasts" ON forecasts;
CREATE POLICY "service_full_forecasts" ON forecasts FOR ALL USING (true) WITH CHECK (true);
