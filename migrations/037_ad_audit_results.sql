-- Migration 037 — ad_audit_results
-- ----------------------------------------------------------------------------
-- Full audit log for WF02 daily ad-optimizer. Sits alongside ad_performance_logs:
--   ad_performance_logs   = raw daily metric snapshots (small rows, cheap)
--   ad_audit_results      = decisions + reasoning + score breakdown (rich rows)
--
-- Anti-thrashing logic queries this table for the last 7 decisions per
-- campaign. Plan-tier billing analytics joins this against businesses.plan.

CREATE TABLE IF NOT EXISTS ad_audit_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL,
  business_id UUID NOT NULL,
  audited_at TIMESTAMPTZ DEFAULT NOW(),

  -- Decision
  decision TEXT NOT NULL CHECK (decision IN ('scale', 'pause', 'keep', 'optimize', 'refresh_creative')),
  decision_reason TEXT,
  new_daily_budget NUMERIC,

  -- Score
  audit_score INTEGER CHECK (audit_score >= 0 AND audit_score <= 100),
  score_breakdown JSONB DEFAULT '{}',

  -- Findings
  critical_issues JSONB DEFAULT '[]',
  warnings JSONB DEFAULT '[]',
  opportunities JSONB DEFAULT '[]',
  trend JSONB DEFAULT '{}',
  citations JSONB DEFAULT '[]',

  -- Calibration context
  market_tier TEXT,
  budget_tier TEXT,
  plan_used TEXT,

  -- Quality / debugging
  short_circuited BOOLEAN DEFAULT FALSE,
  short_circuit_reason TEXT,
  slop_violations INTEGER DEFAULT 0,
  gates JSONB DEFAULT '{}'
);

-- Defensive ALTERs (idempotent — handles partial pre-existing tables)
ALTER TABLE ad_audit_results ADD COLUMN IF NOT EXISTS audited_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE ad_audit_results ADD COLUMN IF NOT EXISTS decision TEXT;
ALTER TABLE ad_audit_results ADD COLUMN IF NOT EXISTS decision_reason TEXT;
ALTER TABLE ad_audit_results ADD COLUMN IF NOT EXISTS new_daily_budget NUMERIC;
ALTER TABLE ad_audit_results ADD COLUMN IF NOT EXISTS audit_score INTEGER;
ALTER TABLE ad_audit_results ADD COLUMN IF NOT EXISTS score_breakdown JSONB DEFAULT '{}';
ALTER TABLE ad_audit_results ADD COLUMN IF NOT EXISTS critical_issues JSONB DEFAULT '[]';
ALTER TABLE ad_audit_results ADD COLUMN IF NOT EXISTS warnings JSONB DEFAULT '[]';
ALTER TABLE ad_audit_results ADD COLUMN IF NOT EXISTS opportunities JSONB DEFAULT '[]';
ALTER TABLE ad_audit_results ADD COLUMN IF NOT EXISTS trend JSONB DEFAULT '{}';
ALTER TABLE ad_audit_results ADD COLUMN IF NOT EXISTS citations JSONB DEFAULT '[]';
ALTER TABLE ad_audit_results ADD COLUMN IF NOT EXISTS market_tier TEXT;
ALTER TABLE ad_audit_results ADD COLUMN IF NOT EXISTS budget_tier TEXT;
ALTER TABLE ad_audit_results ADD COLUMN IF NOT EXISTS plan_used TEXT;
ALTER TABLE ad_audit_results ADD COLUMN IF NOT EXISTS short_circuited BOOLEAN DEFAULT FALSE;
ALTER TABLE ad_audit_results ADD COLUMN IF NOT EXISTS short_circuit_reason TEXT;
ALTER TABLE ad_audit_results ADD COLUMN IF NOT EXISTS slop_violations INTEGER DEFAULT 0;
ALTER TABLE ad_audit_results ADD COLUMN IF NOT EXISTS gates JSONB DEFAULT '{}';

-- Indexes for the most common queries
CREATE INDEX IF NOT EXISTS idx_ad_audit_results_campaign     ON ad_audit_results(campaign_id);
CREATE INDEX IF NOT EXISTS idx_ad_audit_results_business     ON ad_audit_results(business_id);
CREATE INDEX IF NOT EXISTS idx_ad_audit_results_audited_at   ON ad_audit_results(audited_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_audit_results_campaign_at  ON ad_audit_results(campaign_id, audited_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_audit_results_decision     ON ad_audit_results(decision);

-- RLS — service role only (matches existing tables)
ALTER TABLE ad_audit_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_full_ad_audit_results" ON ad_audit_results;
CREATE POLICY "service_full_ad_audit_results" ON ad_audit_results FOR ALL USING (true) WITH CHECK (true);
