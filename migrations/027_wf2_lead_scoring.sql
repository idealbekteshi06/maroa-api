-- Migration 027: Workflow #2 — Lead Scoring & Routing
-- ============================================================================

-- lead_scores: cached scoring output per contact
CREATE TABLE IF NOT EXISTS lead_scores (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL,
  lead_id           UUID NOT NULL,    -- contacts.id
  total             INT NOT NULL,
  tier              TEXT NOT NULL,
  components        JSONB NOT NULL,
  top_predictive_signals JSONB DEFAULT '[]',
  top_risk_signals  JSONB DEFAULT '[]',
  recommended_action TEXT,
  model_used        TEXT DEFAULT 'deterministic',
  scored_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, lead_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_scores_biz_tier ON lead_scores (business_id, tier, scored_at DESC);
ALTER TABLE lead_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lead_scores_service_full" ON lead_scores;
CREATE POLICY "lead_scores_service_full" ON lead_scores FOR ALL TO service_role USING (true) WITH CHECK (true);

-- lead_responses: generated response drafts
CREATE TABLE IF NOT EXISTS lead_responses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL,
  lead_id           UUID NOT NULL,
  subject           TEXT,
  body              TEXT,
  personalization_score NUMERIC(5,2),
  quality_checks    JSONB,
  predicted_response_rate_low NUMERIC(5,4),
  predicted_response_rate_high NUMERIC(5,4),
  psychology_levers JSONB,
  status            TEXT DEFAULT 'draft', -- draft | awaiting_approval | sent | rejected
  sent_at           TIMESTAMPTZ,
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_responses_biz ON lead_responses (business_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_responses_lead ON lead_responses (lead_id);
ALTER TABLE lead_responses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lead_resp_service_full" ON lead_responses;
CREATE POLICY "lead_resp_service_full" ON lead_responses FOR ALL TO service_role USING (true) WITH CHECK (true);

-- routing_rules: configured routing rules per business
CREATE TABLE IF NOT EXISTS routing_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL,
  kind            TEXT NOT NULL,      -- round_robin | territory | industry | deal_size | workload_balanced | account_based
  priority        INT NOT NULL DEFAULT 50,
  config          JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_routing_biz_priority ON routing_rules (business_id, priority DESC);
ALTER TABLE routing_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "routing_service_full" ON routing_rules;
CREATE POLICY "routing_service_full" ON routing_rules FOR ALL TO service_role USING (true) WITH CHECK (true);

-- icp_definitions: ICP per business
CREATE TABLE IF NOT EXISTS icp_definitions (
  business_id             UUID PRIMARY KEY,
  ideal_titles            JSONB DEFAULT '[]',
  ideal_company_size_min  INT,
  ideal_company_size_max  INT,
  ideal_industries        JSONB DEFAULT '[]',
  served_geographies      JSONB DEFAULT '[]',
  deadbeat_list           JSONB DEFAULT '[]',
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE icp_definitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "icp_service_full" ON icp_definitions;
CREATE POLICY "icp_service_full" ON icp_definitions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Extend contacts with scoring-relevant columns if not present
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lead_score INT,
  ADD COLUMN IF NOT EXISTS lead_tier TEXT,
  ADD COLUMN IF NOT EXISTS sla_deadline TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS owner_id UUID,
  ADD COLUMN IF NOT EXISTS enrichment JSONB,
  ADD COLUMN IF NOT EXISTS behavior JSONB,
  ADD COLUMN IF NOT EXISTS intake JSONB;
