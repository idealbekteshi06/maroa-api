-- Migration 024: Workflow #1 — Daily Content Engine
-- Adds the strategic concept→asset→post pipeline, unified events/approvals
-- infrastructure, and the learning loop tables.
--
-- Frontend contract: ../maroa-ai-marketing-automator/src/lib/api.ts lines 259–340
-- Spec: services/prompts/workflow_1_daily_content.js (auto-generated from
-- frontend ../maroa-ai-marketing-automator/src/lib/prompts/workflow_1_daily_content.ts)
--
-- Apply in Supabase SQL editor. Idempotent — safe to re-run.
-- ============================================================================

-- ─── Unified activity events (reused across all 15 workflows) ───────────────
CREATE TABLE IF NOT EXISTS events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  kind        TEXT NOT NULL,              -- e.g. 'wf1.plan.created', 'wf1.concept.approved'
  workflow    TEXT,                        -- '1_daily_content', '13_weekly_brief', etc.
  payload     JSONB NOT NULL DEFAULT '{}', -- workflow-specific metadata
  severity    TEXT DEFAULT 'info',         -- info | warn | error | success
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_biz_time ON events (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events (kind);
CREATE INDEX IF NOT EXISTS idx_events_workflow ON events (workflow);
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "events_service_full" ON events;
CREATE POLICY "events_service_full" ON events FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "events_owner_read" ON events;
CREATE POLICY "events_owner_read" ON events FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = events.business_id AND b.user_id = auth.uid())
);

-- ─── Unified approval queue (all workflows write here) ─────────────────────
CREATE TABLE IF NOT EXISTS approvals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  workflow     TEXT NOT NULL,              -- '1_daily_content' etc.
  entity_type  TEXT NOT NULL,              -- 'concept' | 'asset' | 'ad' | 'review_reply'
  entity_id    UUID NOT NULL,
  preview      JSONB NOT NULL,             -- { title, body, media_url, rationale }
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | edited | expired
  priority     INT DEFAULT 50,             -- 1 (lowest) — 100 (highest)
  sla_at       TIMESTAMPTZ,                -- auto-escalate/fallback deadline
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at   TIMESTAMPTZ,
  decided_by   UUID,
  decision_reason TEXT,
  edited_payload JSONB
);
CREATE INDEX IF NOT EXISTS idx_approvals_biz_status ON approvals (business_id, status, sla_at);
CREATE INDEX IF NOT EXISTS idx_approvals_entity ON approvals (entity_type, entity_id);
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "approvals_service_full" ON approvals;
CREATE POLICY "approvals_service_full" ON approvals FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "approvals_owner_rw" ON approvals;
CREATE POLICY "approvals_owner_rw" ON approvals FOR ALL USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = approvals.business_id AND b.user_id = auth.uid())
);

-- ─── AI Brain decision log (reserved for WF15) ─────────────────────────────
CREATE TABLE IF NOT EXISTS brain_decisions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  trigger     TEXT NOT NULL,                -- 'cron' | 'user' | 'event'
  input       JSONB NOT NULL,
  reasoning   TEXT NOT NULL,                -- chain-of-thought narrative (shown in UI)
  actions     JSONB NOT NULL DEFAULT '[]',  -- [{ workflow, action, params }]
  outcome     JSONB,
  cost_usd    NUMERIC(10,4),
  model_used  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brain_decisions_biz_time ON brain_decisions (business_id, created_at DESC);
ALTER TABLE brain_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brain_decisions_service_full" ON brain_decisions;
CREATE POLICY "brain_decisions_service_full" ON brain_decisions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── WF1 — content_plans (one per business per date) ──────────────────────
CREATE TABLE IF NOT EXISTS content_plans (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL,
  plan_date         DATE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft', -- draft | queued | awaiting_approval | published | skipped
  analysis          JSONB NOT NULL,           -- brandMaturity, narrativeArc, culturalOpportunity, funnelStages, underservedPillars, targetEmotions, reasoning
  context_snapshot  JSONB,                    -- the full DailyContextBundle used for reproducibility
  autonomy_mode     TEXT,                     -- snapshot of the mode at creation time
  model_used        TEXT,                     -- 'claude-opus-4-5'
  cost_usd          NUMERIC(10,4),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, plan_date)
);
CREATE INDEX IF NOT EXISTS idx_content_plans_biz_date ON content_plans (business_id, plan_date DESC);
ALTER TABLE content_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "content_plans_service_full" ON content_plans;
CREATE POLICY "content_plans_service_full" ON content_plans FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "content_plans_owner_rw" ON content_plans;
CREATE POLICY "content_plans_owner_rw" ON content_plans FOR ALL USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = content_plans.business_id AND b.user_id = auth.uid())
);

-- ─── WF1 — content_concepts (1–3 per plan, strategic decisions) ───────────
CREATE TABLE IF NOT EXISTS content_concepts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              UUID NOT NULL,
  plan_id                  UUID NOT NULL REFERENCES content_plans(id) ON DELETE CASCADE,
  platform                 TEXT NOT NULL,   -- instagram_reel | tiktok | linkedin | …
  format                   TEXT NOT NULL,   -- e.g. '9:16 Reel 7-15s'
  pillar                   TEXT,
  funnel_stage             TEXT,            -- tofu | mofu | bofu | retention
  emotion                  TEXT,
  core_idea                TEXT NOT NULL,
  hook                     TEXT NOT NULL,
  hook_pattern             TEXT,            -- pattern_interrupt | curiosity_gap | value_promise | contrarian | storytelling
  story_arc                TEXT,
  cta                      TEXT,
  framework                TEXT,            -- psychology lever naming
  why_this_why_now         TEXT,
  predicted_engagement_low NUMERIC(5,4),
  predicted_engagement_high NUMERIC(5,4),
  risk_level               TEXT DEFAULT 'low', -- low | medium | high
  cost_estimate_usd        NUMERIC(6,4),
  status                   TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | published | skipped
  rejection_reason         TEXT,
  quality_score            NUMERIC(5,2),    -- populated after asset generation
  quality_breakdown        JSONB,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at               TIMESTAMPTZ,
  decided_by               UUID
);
CREATE INDEX IF NOT EXISTS idx_concepts_plan ON content_concepts (plan_id);
CREATE INDEX IF NOT EXISTS idx_concepts_biz_status ON content_concepts (business_id, status, created_at DESC);
ALTER TABLE content_concepts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "concepts_service_full" ON content_concepts;
CREATE POLICY "concepts_service_full" ON content_concepts FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "concepts_owner_rw" ON content_concepts;
CREATE POLICY "concepts_owner_rw" ON content_concepts FOR ALL USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = content_concepts.business_id AND b.user_id = auth.uid())
);

-- ─── WF1 — content_assets (generated platform-native output per concept) ──
CREATE TABLE IF NOT EXISTS content_assets (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              UUID NOT NULL,
  concept_id               UUID NOT NULL REFERENCES content_concepts(id) ON DELETE CASCADE,
  platform                 TEXT NOT NULL,
  caption                  TEXT NOT NULL,
  hook                     TEXT,
  hook_pattern             TEXT,
  hashtags                 TEXT[] DEFAULT ARRAY[]::TEXT[],
  cta                      TEXT,
  visual_brief             JSONB,
  accessibility_alt_text   TEXT,
  burned_in_captions       TEXT,
  posting_time_local       TEXT,            -- HH:MM
  posting_time_rationale   TEXT,
  framework_justification  TEXT,
  predicted_quality_score  NUMERIC(5,2),
  confidence               NUMERIC(5,4),
  quality_score            NUMERIC(5,2),    -- scored by gate (Haiku)
  quality_breakdown        JSONB,
  media_url                TEXT,            -- populated after image/video gen
  thumbnail_url            TEXT,
  model_used               TEXT,
  cost_usd                 NUMERIC(10,4),
  status                   TEXT NOT NULL DEFAULT 'generated', -- generated | awaiting_approval | approved | rejected | published | failed
  generated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at             TIMESTAMPTZ,
  platform_post_id         TEXT,            -- the external ID after publish
  platform_post_url        TEXT
);
CREATE INDEX IF NOT EXISTS idx_assets_concept ON content_assets (concept_id);
CREATE INDEX IF NOT EXISTS idx_assets_biz_status ON content_assets (business_id, status, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_published ON content_assets (business_id, published_at) WHERE published_at IS NOT NULL;
ALTER TABLE content_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "assets_service_full" ON content_assets;
CREATE POLICY "assets_service_full" ON content_assets FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "assets_owner_rw" ON content_assets;
CREATE POLICY "assets_owner_rw" ON content_assets FOR ALL USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = content_assets.business_id AND b.user_id = auth.uid())
);

-- ─── WF1 — content_posts (joins asset to platform post + state) ───────────
CREATE TABLE IF NOT EXISTS content_posts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        UUID NOT NULL,
  asset_id           UUID NOT NULL REFERENCES content_assets(id) ON DELETE CASCADE,
  platform           TEXT NOT NULL,
  platform_post_id   TEXT,
  platform_post_url  TEXT,
  posted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  performance_check_at TIMESTAMPTZ,         -- when to next measure engagement
  performance_measured_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_posts_biz_time ON content_posts (business_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_measure_due ON content_posts (performance_check_at) WHERE performance_measured_at IS NULL;
ALTER TABLE content_posts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "posts_service_full" ON content_posts;
CREATE POLICY "posts_service_full" ON content_posts FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "posts_owner_r" ON content_posts;
CREATE POLICY "posts_owner_r" ON content_posts FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = content_posts.business_id AND b.user_id = auth.uid())
);

-- ─── WF1 — content_performance (48h engagement snapshot per post) ─────────
CREATE TABLE IF NOT EXISTS content_performance (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        UUID NOT NULL,
  post_id            UUID NOT NULL REFERENCES content_posts(id) ON DELETE CASCADE,
  asset_id           UUID NOT NULL,
  platform           TEXT NOT NULL,
  measured_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  hours_since_post   NUMERIC(6,2) NOT NULL,
  impressions        BIGINT DEFAULT 0,
  reach              BIGINT DEFAULT 0,
  engagement_count   BIGINT DEFAULT 0,      -- likes + comments + saves + shares
  engagement_rate    NUMERIC(8,6),          -- engagement_count / reach
  vs_account_baseline NUMERIC(6,3),         -- multiplier (1.0 = baseline, 1.5 = 50% over)
  vs_industry_benchmark NUMERIC(6,3),
  classification     TEXT,                   -- 'winner' | 'on_target' | 'under' | 'failed'
  raw                JSONB                   -- full platform payload
);
CREATE INDEX IF NOT EXISTS idx_perf_biz_time ON content_performance (business_id, measured_at DESC);
ALTER TABLE content_performance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "perf_service_full" ON content_performance;
CREATE POLICY "perf_service_full" ON content_performance FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── WF1 — learning_patterns (winners, anti-patterns, hashtag bank) ───────
CREATE TABLE IF NOT EXISTS learning_patterns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL,
  pattern_type    TEXT NOT NULL,     -- 'winning' | 'anti' | 'hashtag_bank' | 'prediction_accuracy'
  platform        TEXT,              -- null = cross-platform
  trait           TEXT NOT NULL,     -- hook_pattern, format, emotion, time_of_day, hashtag, pillar, etc.
  lift            NUMERIC(6,3),      -- for winning/anti: engagement multiplier vs baseline
  drag            NUMERIC(6,3),      -- for anti: negative multiplier
  sample_size     INT DEFAULT 1,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, pattern_type, platform, trait)
);
CREATE INDEX IF NOT EXISTS idx_patterns_biz_type ON learning_patterns (business_id, pattern_type);
ALTER TABLE learning_patterns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "patterns_service_full" ON learning_patterns;
CREATE POLICY "patterns_service_full" ON learning_patterns FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── Autonomy mode + hybrid window on businesses ──────────────────────────
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS wf1_autonomy_mode TEXT DEFAULT 'hybrid',
  ADD COLUMN IF NOT EXISTS wf1_hybrid_window_hours INT DEFAULT 4;

COMMENT ON COLUMN businesses.wf1_autonomy_mode IS 'WF1 autonomy: full_autopilot | hybrid | approve_everything';
COMMENT ON COLUMN businesses.wf1_hybrid_window_hours IS 'Hybrid mode: hours to wait for human approval before fallback auto-publish';

-- ─── Helper: schedule next performance measurement 48h after publish ──────
CREATE OR REPLACE FUNCTION schedule_performance_check() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.posted_at IS NOT NULL AND OLD.posted_at IS DISTINCT FROM NEW.posted_at THEN
    NEW.performance_check_at = NEW.posted_at + INTERVAL '48 hours';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_content_posts_schedule_perf ON content_posts;
CREATE TRIGGER trg_content_posts_schedule_perf
  BEFORE INSERT OR UPDATE ON content_posts
  FOR EACH ROW EXECUTE FUNCTION schedule_performance_check();
