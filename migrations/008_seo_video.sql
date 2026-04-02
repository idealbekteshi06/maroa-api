-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 008: SEO Autopilot + Video Generation
-- Run AFTER migrations 001–007.
-- Safe to re-run: all IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- Note: CRO tests reuse existing ab_tests table (no new table needed).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── SEO Recommendations ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS seo_recommendations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  url                TEXT,
  type               TEXT NOT NULL,
  current_value      TEXT,
  recommended_value  TEXT,
  target_keyword     TEXT,
  priority           TEXT DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
  estimated_impact   TEXT,
  status             TEXT DEFAULT 'pending' CHECK (status IN ('pending','applied','dismissed')),
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  applied_at         TIMESTAMPTZ
);

-- ── Video Generations ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS video_generations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  platform       TEXT NOT NULL,
  script         JSONB,
  caption        TEXT,
  hashtags       TEXT[],
  thumbnail_url  TEXT,
  status         TEXT DEFAULT 'script_ready'
                   CHECK (status IN ('script_ready','generating','ready','published','failed')),
  runway_task_id TEXT,
  video_url      TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── businesses: website_url ───────────────────────────────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS website_url TEXT;

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_seo_recs_business  ON seo_recommendations(business_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_video_gen_business  ON video_generations(business_id, platform, status);

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('seo_recommendations','video_generations')
ORDER BY tablename;
