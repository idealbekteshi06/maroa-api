-- Migration 087 — Higgsfield expansion (Soul ID, credits, video, presets, history)
-- Provides the schema for:
--   • Soul ID + Reference Elements + Marketing Studio product attached to each business
--   • Daily-tracked Higgsfield credit balance (cron in services/inngest/functions.js)
--   • Virality predictions per piece of content
--   • Personal Clipper-derived clips queued for social posting
--   • Generation history mirror for analytics + cost attribution
--   • Cached preset catalog (refreshed weekly)
--
-- Tables for integrations whose REST endpoints are still being confirmed
-- (virality, marketing studio, personal clipper, presets, generations sync)
-- are created up-front so the schema is stable; their write paths land in
-- follow-up commits once the Higgsfield REST docs are in.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS higgsfield_soul_id TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS higgsfield_element_ids JSONB DEFAULT '[]'::jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS higgsfield_product_id TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS higgsfield_credits INTEGER;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS higgsfield_credits_checked_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS content_performance (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL,
  content_id       UUID NOT NULL,
  virality_score   INTEGER,
  predicted_engagement TEXT,
  hook_strength    TEXT,
  retention_risk   TEXT,
  raw              JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_perf_biz ON content_performance (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_perf_content ON content_performance (content_id);

CREATE TABLE IF NOT EXISTS video_clips (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  source_url   TEXT NOT NULL,
  clip_url     TEXT,
  platform     TEXT,
  duration     INTEGER,
  posted       BOOLEAN NOT NULL DEFAULT false,
  job_id       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_video_clips_biz ON video_clips (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_clips_unposted ON video_clips (business_id, posted) WHERE posted = false;

CREATE TABLE IF NOT EXISTS higgsfield_generations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL,
  job_id          TEXT,
  model           TEXT,
  prompt          TEXT,
  media_url       TEXT,
  generation_type TEXT, -- image | video | soul_train | clipper
  cost_credits    INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hf_gens_biz ON higgsfield_generations (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hf_gens_model ON higgsfield_generations (model);

CREATE TABLE IF NOT EXISTS higgsfield_presets (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  preset_id            TEXT UNIQUE NOT NULL,
  name                 TEXT,
  description          TEXT,
  preview_url          TEXT,
  supported_industries JSONB DEFAULT '[]'::jsonb,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hf_presets_pid ON higgsfield_presets (preset_id);
