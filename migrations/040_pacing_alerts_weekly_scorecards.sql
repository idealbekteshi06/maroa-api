-- Migration 040 — Pacing alerts + Weekly scorecards
-- ----------------------------------------------------------------------------

-- ─── Pacing alerts ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pacing_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  campaign_id UUID NOT NULL,
  fired_at TIMESTAMPTZ DEFAULT NOW(),
  rule_id TEXT NOT NULL,
  severity TEXT CHECK (severity IN ('critical','warning','info')),
  title TEXT,
  message TEXT,
  evidence JSONB DEFAULT '{}',
  primary_language TEXT,
  currency TEXT,
  country TEXT,
  acknowledged BOOLEAN DEFAULT FALSE,
  acknowledged_at TIMESTAMPTZ
);
ALTER TABLE pacing_alerts ADD COLUMN IF NOT EXISTS fired_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE pacing_alerts ADD COLUMN IF NOT EXISTS rule_id TEXT;
ALTER TABLE pacing_alerts ADD COLUMN IF NOT EXISTS severity TEXT;
ALTER TABLE pacing_alerts ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE pacing_alerts ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE pacing_alerts ADD COLUMN IF NOT EXISTS evidence JSONB DEFAULT '{}';
ALTER TABLE pacing_alerts ADD COLUMN IF NOT EXISTS primary_language TEXT;
ALTER TABLE pacing_alerts ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE pacing_alerts ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE pacing_alerts ADD COLUMN IF NOT EXISTS acknowledged BOOLEAN DEFAULT FALSE;
ALTER TABLE pacing_alerts ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pacing_alerts_business    ON pacing_alerts(business_id);
CREATE INDEX IF NOT EXISTS idx_pacing_alerts_campaign    ON pacing_alerts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_pacing_alerts_fired_at    ON pacing_alerts(fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_pacing_alerts_dedupe      ON pacing_alerts(campaign_id, rule_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_pacing_alerts_unacked     ON pacing_alerts(business_id, acknowledged) WHERE acknowledged = FALSE;

ALTER TABLE pacing_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_full_pacing_alerts" ON pacing_alerts;
CREATE POLICY "service_full_pacing_alerts" ON pacing_alerts FOR ALL USING (true) WITH CHECK (true);

-- ─── Weekly scorecards ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS weekly_scorecards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  week_data JSONB DEFAULT '{}',
  previous_week_data JSONB DEFAULT '{}',
  deltas JSONB DEFAULT '{}',
  best_campaign JSONB,
  worst_campaign JSONB,
  commentary JSONB,
  html TEXT,
  plan_used TEXT,
  email_sent BOOLEAN DEFAULT FALSE
);
ALTER TABLE weekly_scorecards ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE weekly_scorecards ADD COLUMN IF NOT EXISTS week_data JSONB DEFAULT '{}';
ALTER TABLE weekly_scorecards ADD COLUMN IF NOT EXISTS previous_week_data JSONB DEFAULT '{}';
ALTER TABLE weekly_scorecards ADD COLUMN IF NOT EXISTS deltas JSONB DEFAULT '{}';
ALTER TABLE weekly_scorecards ADD COLUMN IF NOT EXISTS best_campaign JSONB;
ALTER TABLE weekly_scorecards ADD COLUMN IF NOT EXISTS worst_campaign JSONB;
ALTER TABLE weekly_scorecards ADD COLUMN IF NOT EXISTS commentary JSONB;
ALTER TABLE weekly_scorecards ADD COLUMN IF NOT EXISTS html TEXT;
ALTER TABLE weekly_scorecards ADD COLUMN IF NOT EXISTS plan_used TEXT;
ALTER TABLE weekly_scorecards ADD COLUMN IF NOT EXISTS email_sent BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_weekly_scorecards_business     ON weekly_scorecards(business_id);
CREATE INDEX IF NOT EXISTS idx_weekly_scorecards_generated_at ON weekly_scorecards(generated_at DESC);

ALTER TABLE weekly_scorecards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_full_weekly_scorecards" ON weekly_scorecards;
CREATE POLICY "service_full_weekly_scorecards" ON weekly_scorecards FOR ALL USING (true) WITH CHECK (true);
