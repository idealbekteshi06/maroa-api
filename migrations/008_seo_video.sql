-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 008: SEO Autopilot + CRO Engine + Video Generation
-- Run AFTER migrations 001–007.
-- Safe to re-run: all IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── SEO Recommendations ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS seo_recommendations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('keyword','meta','schema','content','speed','backlink')),
  title           TEXT NOT NULL,
  description     TEXT,
  priority        TEXT DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','applied','dismissed')),
  keyword         TEXT,
  current_value   TEXT,
  suggested_value TEXT,
  impact_score    INT DEFAULT 5 CHECK (impact_score BETWEEN 1 AND 10),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  applied_at      TIMESTAMPTZ
);

-- ── CRO Tests ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cro_tests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  page_url       TEXT NOT NULL,
  element_type   TEXT NOT NULL CHECK (element_type IN ('headline','cta','hero_image','form','pricing','testimonial','faq')),
  hypothesis     TEXT,
  control        TEXT,
  variant_a      TEXT,
  variant_b      TEXT,
  variant_c      TEXT,
  winner         TEXT,
  status         TEXT DEFAULT 'draft' CHECK (status IN ('draft','running','completed','cancelled')),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);

-- ── Video Scripts ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS video_scripts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  platform         TEXT NOT NULL CHECK (platform IN ('tiktok','reels','youtube_shorts','linkedin')),
  title            TEXT,
  hook             TEXT,
  script           TEXT NOT NULL,
  thumbnail_prompt TEXT,
  duration_secs    INT DEFAULT 60,
  status           TEXT DEFAULT 'draft' CHECK (status IN ('draft','approved','filmed','published')),
  runway_job_id    TEXT,
  video_url        TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── businesses: website_url ───────────────────────────────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS website_url TEXT;

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_seo_recs_business  ON seo_recommendations(business_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_cro_tests_business ON cro_tests(business_id, status);
CREATE INDEX IF NOT EXISTS idx_video_scripts_biz  ON video_scripts(business_id, platform, status);

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('seo_recommendations','cro_tests','video_scripts')
ORDER BY tablename;
