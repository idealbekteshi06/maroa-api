-- Migration 085 — Industry marketing benchmarks (public reference data)
CREATE TABLE IF NOT EXISTS industry_benchmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  industry TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'GLOBAL',
  meta_avg_ctr NUMERIC(8, 6),
  google_avg_cpc_usd NUMERIC(10, 2),
  email_open_rate NUMERIC(8, 6),
  best_days_post TEXT[] DEFAULT '{}',
  best_times_post TEXT[] DEFAULT '{}',
  instagram_engagement_rate NUMERIC(8, 6),
  top_content_types JSONB DEFAULT '[]',
  benchmarks JSONB DEFAULT '{}',
  source TEXT DEFAULT 'public_benchmarks_2026',
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (industry, region)
);

CREATE INDEX IF NOT EXISTS idx_industry_benchmarks_industry ON industry_benchmarks(industry);

ALTER TABLE industry_benchmarks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "industry_benchmarks_service_full" ON industry_benchmarks;
CREATE POLICY "industry_benchmarks_service_full" ON industry_benchmarks FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Grounding + cold-start also persist anchors here (idempotent)
CREATE TABLE IF NOT EXISTS brand_voice_anchors (
  business_id UUID PRIMARY KEY,
  anchor JSONB NOT NULL,
  source TEXT DEFAULT 'seed',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE brand_voice_anchors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brand_voice_anchors_service_full" ON brand_voice_anchors;
CREATE POLICY "brand_voice_anchors_service_full" ON brand_voice_anchors FOR ALL TO service_role USING (true) WITH CHECK (true);
