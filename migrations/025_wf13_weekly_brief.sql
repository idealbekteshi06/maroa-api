-- Migration 025: Workflow #13 — Weekly Strategy Brief
-- Schema for the agency-grade weekly briefing pipeline: aggregation,
-- synthesis, polish, delivery, decision log.
--
-- Frontend contract: src/lib/api.ts lines 342–488
-- Spec module: services/prompts/workflow_13_weekly_brief.js
-- ============================================================================

-- weekly_briefs: one row per (business, week)
CREATE TABLE IF NOT EXISTS weekly_briefs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL,
  week_start    DATE NOT NULL,   -- Monday of the week
  week_end      DATE NOT NULL,   -- Sunday of the week
  status        TEXT NOT NULL DEFAULT 'queued',
    -- queued | aggregating | synthesizing | polishing | awaiting_review
    -- | approved | delivered | rejected | failed
  context_bundle JSONB,           -- Phase 1 WeeklyContextBundle snapshot
  synthesis     JSONB,             -- Phase 2 StrategySynthesis (Opus output)
  deliverable   JSONB,             -- Phase 3 BriefDeliverable (Sonnet output)
  subject_line  TEXT,
  headline      TEXT,
  word_count    INT,
  model_used_synthesis TEXT,
  model_used_polish    TEXT,
  cost_usd      NUMERIC(10,4),
  generated_at  TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  reviewed_by   UUID,
  review_notes  TEXT,
  error_message TEXT,
  autonomy_mode_snapshot TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, week_start)
);
CREATE INDEX IF NOT EXISTS idx_weekly_briefs_biz_week ON weekly_briefs (business_id, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_weekly_briefs_status ON weekly_briefs (status);
ALTER TABLE weekly_briefs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "weekly_briefs_service_full" ON weekly_briefs;
CREATE POLICY "weekly_briefs_service_full" ON weekly_briefs FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "weekly_briefs_owner_rw" ON weekly_briefs;
CREATE POLICY "weekly_briefs_owner_rw" ON weekly_briefs FOR ALL USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = weekly_briefs.business_id AND b.user_id = auth.uid())
);

-- brief_plan_actions: the recommended next-week plan items, individually actionable
CREATE TABLE IF NOT EXISTS brief_plan_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_id        UUID NOT NULL REFERENCES weekly_briefs(id) ON DELETE CASCADE,
  business_id     UUID NOT NULL,
  action          TEXT NOT NULL,
  why_now         TEXT,
  expected_impact_low  NUMERIC(14,4),
  expected_impact_high NUMERIC(14,4),
  impact_metric   TEXT,
  effort_hours    NUMERIC(6,2),
  owner           TEXT DEFAULT 'ai',
  deadline        DATE,
  one_click_approve BOOLEAN DEFAULT true,
  status          TEXT DEFAULT 'pending',
  decided_at      TIMESTAMPTZ,
  decided_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brief_plan_actions_brief ON brief_plan_actions (brief_id);
CREATE INDEX IF NOT EXISTS idx_brief_plan_actions_biz_status ON brief_plan_actions (business_id, status);
ALTER TABLE brief_plan_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brief_actions_service_full" ON brief_plan_actions;
CREATE POLICY "brief_actions_service_full" ON brief_plan_actions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- brief_delivery_log: each channel delivery attempt
CREATE TABLE IF NOT EXISTS brief_delivery_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_id     UUID NOT NULL REFERENCES weekly_briefs(id) ON DELETE CASCADE,
  business_id  UUID NOT NULL,
  channel      TEXT NOT NULL,   -- email | slack | whatsapp | dashboard_only | pdf
  recipient    TEXT,             -- email address, slack user id, etc.
  status       TEXT NOT NULL,   -- sent | failed | opened | clicked | bounced
  external_id  TEXT,
  error        TEXT,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brief_delivery_brief ON brief_delivery_log (brief_id);
ALTER TABLE brief_delivery_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brief_delivery_service_full" ON brief_delivery_log;
CREATE POLICY "brief_delivery_service_full" ON brief_delivery_log FOR ALL TO service_role USING (true) WITH CHECK (true);

-- brief_delivery_settings: one row per business — how they want briefs delivered
CREATE TABLE IF NOT EXISTS brief_delivery_settings (
  business_id        UUID PRIMARY KEY,
  autonomy_mode      TEXT NOT NULL DEFAULT 'review_first', -- auto_send | review_first | manual
  channels           JSONB NOT NULL DEFAULT '["email","dashboard_only"]',
  recipients         JSONB NOT NULL DEFAULT '[]',
  delivery_day       TEXT NOT NULL DEFAULT 'monday',
  delivery_local_time TEXT NOT NULL DEFAULT '07:00',
  preferred_length   TEXT DEFAULT 'standard',
  tone_preference    TEXT DEFAULT 'direct',
  technical_depth    TEXT DEFAULT 'intermediate',
  language           TEXT DEFAULT 'English',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE brief_delivery_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brief_settings_service_full" ON brief_delivery_settings;
CREATE POLICY "brief_settings_service_full" ON brief_delivery_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "brief_settings_owner_rw" ON brief_delivery_settings;
CREATE POLICY "brief_settings_owner_rw" ON brief_delivery_settings FOR ALL USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = brief_delivery_settings.business_id AND b.user_id = auth.uid())
);

-- reader_preferences_learned: aggregated over time from feedback
CREATE TABLE IF NOT EXISTS reader_preferences_learned (
  business_id              UUID PRIMARY KEY,
  sections_skipped         JSONB DEFAULT '[]',
  sections_drilled_into    JSONB DEFAULT '[]',
  recommendations_rejected JSONB DEFAULT '[]',
  recommendations_approved JSONB DEFAULT '[]',
  metric_priorities        JSONB DEFAULT '[]',
  sample_size              INT DEFAULT 0,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE reader_preferences_learned ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "reader_prefs_service_full" ON reader_preferences_learned;
CREATE POLICY "reader_prefs_service_full" ON reader_preferences_learned FOR ALL TO service_role USING (true) WITH CHECK (true);
