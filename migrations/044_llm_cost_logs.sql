-- Migration 044 — llm_cost_logs (observability layer)
-- ----------------------------------------------------------------------------
-- Tracks every Anthropic API call's token usage + cost. Used by:
--   - cost-report.js daily script
--   - /api/cost-report endpoint
--   - per-business cost dashboards

CREATE TABLE IF NOT EXISTS llm_cost_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  skill TEXT,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cost_usd NUMERIC(10, 6) DEFAULT 0
);
ALTER TABLE llm_cost_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE llm_cost_logs ADD COLUMN IF NOT EXISTS skill TEXT;
ALTER TABLE llm_cost_logs ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE llm_cost_logs ADD COLUMN IF NOT EXISTS input_tokens INTEGER DEFAULT 0;
ALTER TABLE llm_cost_logs ADD COLUMN IF NOT EXISTS output_tokens INTEGER DEFAULT 0;
ALTER TABLE llm_cost_logs ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER DEFAULT 0;
ALTER TABLE llm_cost_logs ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10, 6) DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_llm_cost_logs_business    ON llm_cost_logs(business_id);
CREATE INDEX IF NOT EXISTS idx_llm_cost_logs_created_at  ON llm_cost_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_cost_logs_skill_day   ON llm_cost_logs(skill, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_cost_logs_model       ON llm_cost_logs(model);

ALTER TABLE llm_cost_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_full_llm_cost_logs" ON llm_cost_logs;
CREATE POLICY "service_full_llm_cost_logs" ON llm_cost_logs FOR ALL USING (true) WITH CHECK (true);
