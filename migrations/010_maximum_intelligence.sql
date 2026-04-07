-- Migration 010: Maximum Intelligence Layer — Levels 1-10
-- Run in Supabase SQL Editor AFTER 009_autonomous_agent.sql

-- ── New columns on businesses ───────────────────────────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS content_opportunities JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS audience_insights_full JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS competitive_moat JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS growth_engine_recommendation JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS crisis_status TEXT DEFAULT 'healthy';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS audience_insights JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS last_decision TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS last_decision_reason TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS performance_baseline JSONB;

-- ── New columns on generated_content (A/B testing + predictive scoring) ─────
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS ab_test_id UUID;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS variant TEXT DEFAULT 'A';
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS pre_post_score NUMERIC DEFAULT 0;

-- ── Campaign Orchestrations table ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaign_orchestrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  campaign_name TEXT,
  campaign_theme TEXT,
  campaign_plan JSONB,
  status TEXT DEFAULT 'active',
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── RLS + Indexes ───────────────────────────────────────────────────────────
ALTER TABLE campaign_orchestrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on campaign_orchestrations"
  ON campaign_orchestrations FOR ALL
  USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_campaign_orch_business ON campaign_orchestrations(business_id);
CREATE INDEX IF NOT EXISTS idx_campaign_orch_status ON campaign_orchestrations(status);
CREATE INDEX IF NOT EXISTS idx_generated_content_variant ON generated_content(variant);
CREATE INDEX IF NOT EXISTS idx_generated_content_ab_test ON generated_content(ab_test_id);
CREATE INDEX IF NOT EXISTS idx_businesses_crisis ON businesses(crisis_status);
