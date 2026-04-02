-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 002: LinkedIn, Twitter, TikTok columns on businesses table
-- Run in: Supabase Dashboard → SQL Editor
-- Safe to re-run: all statements use ADD COLUMN IF NOT EXISTS
-- ─────────────────────────────────────────────────────────────────────────────

-- ── LinkedIn (linkedin_access_token + linkedin_page_id already exist) ─────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS linkedin_refresh_token    TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS linkedin_person_id        TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS linkedin_organization_id  TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS linkedin_connected        BOOLEAN DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS next_linkedin_post_date   TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS linkedin_token_expires_at TIMESTAMPTZ;

-- ── Twitter / X ───────────────────────────────────────────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS twitter_access_token      TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS twitter_refresh_token     TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS twitter_user_id           TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS twitter_username          TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS twitter_connected         BOOLEAN DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS next_twitter_post_date    TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS twitter_token_expires_at  TIMESTAMPTZ;

-- ── TikTok (tiktok_access_token already exists) ────────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tiktok_refresh_token      TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tiktok_user_id            TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tiktok_username           TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tiktok_connected          BOOLEAN DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS next_tiktok_post_date     TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tiktok_token_expires_at   TIMESTAMPTZ;

-- ── posts table (unified cross-platform post log) ─────────────────────────────
CREATE TABLE IF NOT EXISTS posts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  platform          TEXT NOT NULL CHECK (platform IN ('facebook','instagram','linkedin','twitter','tiktok','google_my_business')),
  platform_post_id  TEXT,
  content           TEXT,
  image_url         TEXT,
  status            TEXT DEFAULT 'published' CHECK (status IN ('draft','scheduled','published','failed')),
  scheduled_at      TIMESTAMPTZ,
  published_at      TIMESTAMPTZ DEFAULT NOW(),
  likes             INT DEFAULT 0,
  comments          INT DEFAULT 0,
  shares            INT DEFAULT 0,
  impressions       INT DEFAULT 0,
  reach             INT DEFAULT 0,
  engagement_rate   NUMERIC(5,2),
  content_theme     TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_posts_business   ON posts(business_id);
CREATE INDEX IF NOT EXISTS idx_posts_platform   ON posts(platform);
CREATE INDEX IF NOT EXISTS idx_posts_published  ON posts(published_at DESC);

-- ── oauth_states table (PKCE + state param storage for OAuth flows) ───────────
CREATE TABLE IF NOT EXISTS oauth_states (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL,
  state         TEXT NOT NULL UNIQUE,
  code_verifier TEXT,
  redirect_uri  TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '10 minutes')
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_state ON oauth_states(state);

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'businesses'
  AND column_name IN (
    'linkedin_connected','linkedin_person_id','linkedin_organization_id',
    'next_linkedin_post_date','twitter_access_token','twitter_connected',
    'next_twitter_post_date','tiktok_connected','next_tiktok_post_date'
  )
ORDER BY column_name;
