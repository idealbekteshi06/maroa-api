-- Migration 038 — AI-SEO audits + artifacts
-- ----------------------------------------------------------------------------
-- Two tables:
--   ai_seo_audits     = audit results (score + gaps + opportunities)
--   ai_seo_artifacts  = generated artifacts (llms.txt + schemas + rewrites)

-- ─── Audits ───
CREATE TABLE IF NOT EXISTS ai_seo_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  audited_at TIMESTAMPTZ DEFAULT NOW(),
  audit_score INTEGER CHECK (audit_score >= 0 AND audit_score <= 100),
  dimension_scores JSONB DEFAULT '{}',
  critical_gaps JSONB DEFAULT '[]',
  warnings JSONB DEFAULT '[]',
  opportunities JSONB DEFAULT '[]',
  ai_search_readiness TEXT CHECK (ai_search_readiness IN ('minimal','partial','strong')),
  estimated_citation_potential TEXT CHECK (estimated_citation_potential IN ('low','medium','high')),
  primary_language TEXT,
  country TEXT,
  citations JSONB DEFAULT '[]',
  short_circuited BOOLEAN DEFAULT FALSE,
  short_circuit_reason TEXT,
  plan_used TEXT
);
ALTER TABLE ai_seo_audits ADD COLUMN IF NOT EXISTS audited_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE ai_seo_audits ADD COLUMN IF NOT EXISTS audit_score INTEGER;
ALTER TABLE ai_seo_audits ADD COLUMN IF NOT EXISTS dimension_scores JSONB DEFAULT '{}';
ALTER TABLE ai_seo_audits ADD COLUMN IF NOT EXISTS critical_gaps JSONB DEFAULT '[]';
ALTER TABLE ai_seo_audits ADD COLUMN IF NOT EXISTS warnings JSONB DEFAULT '[]';
ALTER TABLE ai_seo_audits ADD COLUMN IF NOT EXISTS opportunities JSONB DEFAULT '[]';
ALTER TABLE ai_seo_audits ADD COLUMN IF NOT EXISTS ai_search_readiness TEXT;
ALTER TABLE ai_seo_audits ADD COLUMN IF NOT EXISTS estimated_citation_potential TEXT;
ALTER TABLE ai_seo_audits ADD COLUMN IF NOT EXISTS primary_language TEXT;
ALTER TABLE ai_seo_audits ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE ai_seo_audits ADD COLUMN IF NOT EXISTS citations JSONB DEFAULT '[]';
ALTER TABLE ai_seo_audits ADD COLUMN IF NOT EXISTS short_circuited BOOLEAN DEFAULT FALSE;
ALTER TABLE ai_seo_audits ADD COLUMN IF NOT EXISTS short_circuit_reason TEXT;
ALTER TABLE ai_seo_audits ADD COLUMN IF NOT EXISTS plan_used TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_seo_audits_business    ON ai_seo_audits(business_id);
CREATE INDEX IF NOT EXISTS idx_ai_seo_audits_audited_at  ON ai_seo_audits(audited_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_seo_audits_score       ON ai_seo_audits(audit_score);

ALTER TABLE ai_seo_audits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_full_ai_seo_audits" ON ai_seo_audits;
CREATE POLICY "service_full_ai_seo_audits" ON ai_seo_audits FOR ALL USING (true) WITH CHECK (true);

-- ─── Artifacts ───
CREATE TABLE IF NOT EXISTS ai_seo_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  llms_txt TEXT,
  llms_full_txt TEXT,
  schema_blocks JSONB DEFAULT '[]',
  page_rewrites JSONB DEFAULT '[]',
  internal_link_suggestions JSONB DEFAULT '[]',
  llm_used BOOLEAN DEFAULT FALSE,
  plan_used TEXT
);
ALTER TABLE ai_seo_artifacts ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE ai_seo_artifacts ADD COLUMN IF NOT EXISTS llms_txt TEXT;
ALTER TABLE ai_seo_artifacts ADD COLUMN IF NOT EXISTS llms_full_txt TEXT;
ALTER TABLE ai_seo_artifacts ADD COLUMN IF NOT EXISTS schema_blocks JSONB DEFAULT '[]';
ALTER TABLE ai_seo_artifacts ADD COLUMN IF NOT EXISTS page_rewrites JSONB DEFAULT '[]';
ALTER TABLE ai_seo_artifacts ADD COLUMN IF NOT EXISTS internal_link_suggestions JSONB DEFAULT '[]';
ALTER TABLE ai_seo_artifacts ADD COLUMN IF NOT EXISTS llm_used BOOLEAN DEFAULT FALSE;
ALTER TABLE ai_seo_artifacts ADD COLUMN IF NOT EXISTS plan_used TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_seo_artifacts_business     ON ai_seo_artifacts(business_id);
CREATE INDEX IF NOT EXISTS idx_ai_seo_artifacts_generated_at ON ai_seo_artifacts(generated_at DESC);

ALTER TABLE ai_seo_artifacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_full_ai_seo_artifacts" ON ai_seo_artifacts;
CREATE POLICY "service_full_ai_seo_artifacts" ON ai_seo_artifacts FOR ALL USING (true) WITH CHECK (true);
