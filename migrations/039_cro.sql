-- Migration 039 — CRO audits + rewrites
-- Two tables: cro_audits (score + issues), cro_rewrites (hero/CTA/bullets).

CREATE TABLE IF NOT EXISTS cro_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  audited_at TIMESTAMPTZ DEFAULT NOW(),
  audit_score INTEGER CHECK (audit_score >= 0 AND audit_score <= 100),
  dimension_scores JSONB DEFAULT '{}',
  critical_issues JSONB DEFAULT '[]',
  warnings JSONB DEFAULT '[]',
  opportunities JSONB DEFAULT '[]',
  primary_language TEXT,
  country TEXT,
  current_estimated_conv_rate_band TEXT CHECK (current_estimated_conv_rate_band IN ('low','average','strong')),
  expected_lift_band TEXT CHECK (expected_lift_band IN ('low','medium','high')),
  citations JSONB DEFAULT '[]',
  short_circuited BOOLEAN DEFAULT FALSE,
  short_circuit_reason TEXT,
  plan_used TEXT
);
ALTER TABLE cro_audits ADD COLUMN IF NOT EXISTS audited_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE cro_audits ADD COLUMN IF NOT EXISTS audit_score INTEGER;
ALTER TABLE cro_audits ADD COLUMN IF NOT EXISTS dimension_scores JSONB DEFAULT '{}';
ALTER TABLE cro_audits ADD COLUMN IF NOT EXISTS critical_issues JSONB DEFAULT '[]';
ALTER TABLE cro_audits ADD COLUMN IF NOT EXISTS warnings JSONB DEFAULT '[]';
ALTER TABLE cro_audits ADD COLUMN IF NOT EXISTS opportunities JSONB DEFAULT '[]';
ALTER TABLE cro_audits ADD COLUMN IF NOT EXISTS primary_language TEXT;
ALTER TABLE cro_audits ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE cro_audits ADD COLUMN IF NOT EXISTS current_estimated_conv_rate_band TEXT;
ALTER TABLE cro_audits ADD COLUMN IF NOT EXISTS expected_lift_band TEXT;
ALTER TABLE cro_audits ADD COLUMN IF NOT EXISTS citations JSONB DEFAULT '[]';
ALTER TABLE cro_audits ADD COLUMN IF NOT EXISTS short_circuited BOOLEAN DEFAULT FALSE;
ALTER TABLE cro_audits ADD COLUMN IF NOT EXISTS short_circuit_reason TEXT;
ALTER TABLE cro_audits ADD COLUMN IF NOT EXISTS plan_used TEXT;

CREATE INDEX IF NOT EXISTS idx_cro_audits_business    ON cro_audits(business_id);
CREATE INDEX IF NOT EXISTS idx_cro_audits_audited_at  ON cro_audits(audited_at DESC);

ALTER TABLE cro_audits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_full_cro_audits" ON cro_audits;
CREATE POLICY "service_full_cro_audits" ON cro_audits FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS cro_rewrites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  hero_headline_variants JSONB DEFAULT '[]',
  hero_subhead_variants JSONB DEFAULT '[]',
  primary_cta_variants JSONB DEFAULT '[]',
  value_prop_bullets JSONB DEFAULT '[]',
  social_proof_template JSONB,
  form_simplification JSONB,
  llm_used BOOLEAN DEFAULT FALSE,
  plan_used TEXT
);
ALTER TABLE cro_rewrites ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE cro_rewrites ADD COLUMN IF NOT EXISTS hero_headline_variants JSONB DEFAULT '[]';
ALTER TABLE cro_rewrites ADD COLUMN IF NOT EXISTS hero_subhead_variants JSONB DEFAULT '[]';
ALTER TABLE cro_rewrites ADD COLUMN IF NOT EXISTS primary_cta_variants JSONB DEFAULT '[]';
ALTER TABLE cro_rewrites ADD COLUMN IF NOT EXISTS value_prop_bullets JSONB DEFAULT '[]';
ALTER TABLE cro_rewrites ADD COLUMN IF NOT EXISTS social_proof_template JSONB;
ALTER TABLE cro_rewrites ADD COLUMN IF NOT EXISTS form_simplification JSONB;
ALTER TABLE cro_rewrites ADD COLUMN IF NOT EXISTS llm_used BOOLEAN DEFAULT FALSE;
ALTER TABLE cro_rewrites ADD COLUMN IF NOT EXISTS plan_used TEXT;

CREATE INDEX IF NOT EXISTS idx_cro_rewrites_business    ON cro_rewrites(business_id);
CREATE INDEX IF NOT EXISTS idx_cro_rewrites_generated_at ON cro_rewrites(generated_at DESC);

ALTER TABLE cro_rewrites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_full_cro_rewrites" ON cro_rewrites;
CREATE POLICY "service_full_cro_rewrites" ON cro_rewrites FOR ALL USING (true) WITH CHECK (true);
