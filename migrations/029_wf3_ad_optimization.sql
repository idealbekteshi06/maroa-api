-- Migration 029: Workflow #3 — Ad Optimization Loop
-- Extends existing ad_campaigns / ad_performance_logs with the weekly
-- optimization decision records.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ad_optimization_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL,
  week_start        DATE NOT NULL,
  week_end          DATE NOT NULL,
  snapshot          JSONB,             -- input snapshot (spend/roas/cpa per campaign)
  decision          JSONB,             -- Opus output (actions, budget_rebalance, etc.)
  blended_roas      NUMERIC(8,3),
  blended_cac       NUMERIC(10,2),
  total_spend_usd   NUMERIC(14,2),
  model_used        TEXT,
  cost_usd          NUMERIC(10,4),
  status            TEXT DEFAULT 'draft', -- draft | awaiting_approval | approved | applied | rejected
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at        TIMESTAMPTZ,
  UNIQUE (business_id, week_start)
);
CREATE INDEX IF NOT EXISTS idx_ad_opt_runs_biz ON ad_optimization_runs (business_id, week_start DESC);
ALTER TABLE ad_optimization_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ad_opt_runs_service_full" ON ad_optimization_runs;
CREATE POLICY "ad_opt_runs_service_full" ON ad_optimization_runs FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS ad_optimization_actions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            UUID NOT NULL REFERENCES ad_optimization_runs(id) ON DELETE CASCADE,
  business_id       UUID NOT NULL,
  action_kind       TEXT NOT NULL,        -- scale | pause | refresh | rebudget | partition | launch
  entity_platform   TEXT NOT NULL,        -- meta | google | linkedin | tiktok
  entity_id         TEXT,
  entity_name       TEXT,
  current_state     TEXT,
  recommendation    TEXT,
  why_now           TEXT,
  expected_impact_low  NUMERIC(14,2),
  expected_impact_high NUMERIC(14,2),
  impact_metric     TEXT,
  risk_level        TEXT DEFAULT 'low',
  requires_approval BOOLEAN DEFAULT true,
  status            TEXT DEFAULT 'pending', -- pending | approved | rejected | applied | failed
  applied_at        TIMESTAMPTZ,
  result            JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ad_opt_actions_run ON ad_optimization_actions (run_id);
CREATE INDEX IF NOT EXISTS idx_ad_opt_actions_biz_status ON ad_optimization_actions (business_id, status);
ALTER TABLE ad_optimization_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ad_opt_actions_service_full" ON ad_optimization_actions;
CREATE POLICY "ad_opt_actions_service_full" ON ad_optimization_actions FOR ALL TO service_role USING (true) WITH CHECK (true);
