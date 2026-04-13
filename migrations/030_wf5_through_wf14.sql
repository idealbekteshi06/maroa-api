-- Migration 030: Workflows #5, #6, #7, #8, #9/11, #10, #12, #14 — core schemas
-- ============================================================================

-- ─── WF5 — Competitor Intelligence ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS competitor_briefs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  week_start   DATE NOT NULL,
  week_end     DATE NOT NULL,
  summary      TEXT,
  competitors  JSONB,           -- array of per-competitor analyses
  market_shifts JSONB,
  white_space  JSONB,
  actions      JSONB,
  frameworks_cited JSONB,
  model_used   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, week_start)
);
ALTER TABLE competitor_briefs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cb_service_full" ON competitor_briefs;
CREATE POLICY "cb_service_full" ON competitor_briefs FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── WF6 — Local + Digital Presence ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS presence_audits (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  overall_score INT,
  gbp          JSONB,
  schema_markup JSONB,
  citations    JSONB,
  local_rank   JSONB,
  remediation_plan JSONB,
  quick_wins   JSONB,
  audit_run_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_presence_audits_biz ON presence_audits (business_id, audit_run_at DESC);
ALTER TABLE presence_audits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pa_service_full" ON presence_audits;
CREATE POLICY "pa_service_full" ON presence_audits FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS schema_markup_generated (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  page_url     TEXT,
  schema_type  TEXT,
  json_ld      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE schema_markup_generated ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sm_service_full" ON schema_markup_generated;
CREATE POLICY "sm_service_full" ON schema_markup_generated FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── WF7 — Email Lifecycle ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_segments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  name         TEXT NOT NULL,
  definition   JSONB,           -- criteria for membership
  size_cached  INT,
  lifecycle_stage TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_sequences (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  segment_id   UUID REFERENCES email_segments(id) ON DELETE CASCADE,
  name         TEXT,
  status       TEXT DEFAULT 'draft',
  plan         JSONB,           -- array of emails from the prompt output
  emails_sent  INT DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_enrollments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  sequence_id  UUID REFERENCES email_sequences(id) ON DELETE CASCADE,
  contact_id   UUID,
  current_stage INT DEFAULT 1,
  enrolled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sent_at TIMESTAMPTZ,
  status       TEXT DEFAULT 'active'
);
ALTER TABLE email_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_enrollments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "es_service_full" ON email_segments;
CREATE POLICY "es_service_full" ON email_segments FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "eseq_service_full" ON email_sequences;
CREATE POLICY "eseq_service_full" ON email_sequences FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "eenroll_service_full" ON email_enrollments;
CREATE POLICY "eenroll_service_full" ON email_enrollments FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── WF8 — Customer Insights ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insight_reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  top_themes   JSONB,
  pain_points  JSONB,
  delight_moments JSONB,
  unmet_needs  JSONB,
  personas     JSONB,
  language_patterns JSONB,
  action_items JSONB,
  window_start DATE,
  window_end   DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE insight_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ir_service_full" ON insight_reports;
CREATE POLICY "ir_service_full" ON insight_reports FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── WF9/11 — Unified Inbox + Smart Routing ───────────────────────────────
CREATE TABLE IF NOT EXISTS inbox_threads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  channel      TEXT NOT NULL,     -- email | instagram_dm | whatsapp | facebook | tiktok | form
  external_id  TEXT,
  from_handle  TEXT,
  subject      TEXT,
  body         TEXT,
  attachments  JSONB,
  classification TEXT,             -- lead|support|complaint|spam|partnership|press|internal|review_mention
  sentiment    TEXT,
  urgency      TEXT,
  sla_deadline TIMESTAMPTZ,
  route_to     TEXT,
  status       TEXT DEFAULT 'new', -- new | routed | responded | resolved | escalated
  assigned_to  UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_inbox_biz_status ON inbox_threads (business_id, status, sla_deadline);
ALTER TABLE inbox_threads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "it_service_full" ON inbox_threads;
CREATE POLICY "it_service_full" ON inbox_threads FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS inbox_replies (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id    UUID NOT NULL REFERENCES inbox_threads(id) ON DELETE CASCADE,
  business_id  UUID NOT NULL,
  body         TEXT,
  subject      TEXT,
  tone         TEXT,
  requires_human_review BOOLEAN DEFAULT true,
  confidence   NUMERIC(4,3),
  status       TEXT DEFAULT 'draft', -- draft | approved | sent | rejected
  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE inbox_replies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ir2_service_full" ON inbox_replies;
CREATE POLICY "ir2_service_full" ON inbox_replies FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── WF10 — Higgsfield Studio ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS studio_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  request_kind TEXT NOT NULL,    -- image | video | carousel | reel
  brief        JSONB,             -- output of Opus brief builder
  provider     TEXT,              -- segmind | higgsfield | runway | fallback
  status       TEXT DEFAULT 'queued', -- queued | processing | completed | failed
  result_url   TEXT,
  thumbnail_url TEXT,
  cost_usd     NUMERIC(10,4),
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
ALTER TABLE studio_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sj_service_full" ON studio_jobs;
CREATE POLICY "sj_service_full" ON studio_jobs FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── WF12 — Launch Orchestrator ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS launches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  name         TEXT NOT NULL,
  launch_type  TEXT,              -- product | event | campaign | pivot
  launch_date  DATE,
  plan         JSONB,              -- full phase plan from Opus
  budget_allocation JSONB,
  status       TEXT DEFAULT 'planning', -- planning | pre_launch | launch_week | post_launch | momentum | completed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE launches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "launches_service_full" ON launches;
CREATE POLICY "launches_service_full" ON launches FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS launch_activities (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  launch_id    UUID NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
  business_id  UUID NOT NULL,
  phase        TEXT,
  activity     TEXT,
  channel      TEXT,
  owner        TEXT,
  effort_days  NUMERIC(5,2),
  status       TEXT DEFAULT 'pending',
  due_at       TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE launch_activities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "la_service_full" ON launch_activities;
CREATE POLICY "la_service_full" ON launch_activities FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── WF14 — Budget & ROI Optimizer ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS budget_optimizer_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  month_start  DATE NOT NULL,
  blended_roas NUMERIC(8,3),
  blended_cac  NUMERIC(10,2),
  ltv_cac_ratio NUMERIC(8,3),
  per_channel  JSONB,
  reallocation_moves JSONB,
  total_spend_change_usd NUMERIC(14,2),
  projected_blended_roas NUMERIC(8,3),
  confidence   TEXT,
  model_used   TEXT,
  status       TEXT DEFAULT 'draft',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, month_start)
);
ALTER TABLE budget_optimizer_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bor_service_full" ON budget_optimizer_runs;
CREATE POLICY "bor_service_full" ON budget_optimizer_runs FOR ALL TO service_role USING (true) WITH CHECK (true);
