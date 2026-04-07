-- Migration 009: Autonomous Agent + Feedback Loops + Predictive Intelligence
-- Run in Supabase SQL Editor

-- ── New columns on generated_content ────────────────────────────────────────
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS performance_score NUMERIC DEFAULT 0;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS total_reach INT DEFAULT 0;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS facebook_post_id TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;

-- ── New columns on contacts ─────────────────────────────────────────────────
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS intent_level TEXT DEFAULT 'cold';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS recommended_action TEXT;

-- ── New columns on businesses ───────────────────────────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS optimal_posting_times JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS weekly_forecast JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS strategy_updated_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS estimated_revenue NUMERIC DEFAULT 0;

-- ── Revenue Attribution table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS revenue_attribution (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  source TEXT NOT NULL,
  campaign_id UUID,
  content_id UUID,
  attributed_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Learning Logs table (if not exists from earlier migration) ──────────────
CREATE TABLE IF NOT EXISTS learning_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  decision_date TIMESTAMPTZ,
  decision_data JSONB,
  actions_taken JSONB,
  performance_before JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add missing columns to learning_logs if they were created with the old schema
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='learning_logs' AND column_name='decision_date') THEN
    ALTER TABLE learning_logs ADD COLUMN decision_date TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='learning_logs' AND column_name='decision_data') THEN
    ALTER TABLE learning_logs ADD COLUMN decision_data JSONB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='learning_logs' AND column_name='actions_taken') THEN
    ALTER TABLE learning_logs ADD COLUMN actions_taken JSONB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='learning_logs' AND column_name='performance_before') THEN
    ALTER TABLE learning_logs ADD COLUMN performance_before JSONB;
  END IF;
END $$;

-- ── RLS Policies ────────────────────────────────────────────────────────────
ALTER TABLE revenue_attribution ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on revenue_attribution"
  ON revenue_attribution FOR ALL
  USING (true) WITH CHECK (true);

-- ── Indexes for performance ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_revenue_attribution_business ON revenue_attribution(business_id);
CREATE INDEX IF NOT EXISTS idx_revenue_attribution_source ON revenue_attribution(source);
CREATE INDEX IF NOT EXISTS idx_learning_logs_business ON learning_logs(business_id);
CREATE INDEX IF NOT EXISTS idx_generated_content_perf ON generated_content(performance_score);
CREATE INDEX IF NOT EXISTS idx_contacts_intent ON contacts(intent_level);
