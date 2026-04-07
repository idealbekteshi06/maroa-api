-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 002: LinkedIn, Twitter, TikTok columns
-- Run AFTER migration 001.
-- Safe to re-run: all statements use IF NOT EXISTS guards.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── LinkedIn (linkedin_access_token + linkedin_page_id already exist) ─────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS linkedin_refresh_token    TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS linkedin_person_id        TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS linkedin_organization_id  TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS linkedin_connected        BOOLEAN DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS next_linkedin_post_date   TIMESTAMPTZ;

-- ── Twitter (no columns exist yet) ────────────────────────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS twitter_access_token      TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS twitter_refresh_token     TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS twitter_user_id           TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS twitter_connected         BOOLEAN DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS next_twitter_post_date    TIMESTAMPTZ;

-- ── TikTok (tiktok_access_token already exists) ───────────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tiktok_refresh_token      TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tiktok_user_id            TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tiktok_connected          BOOLEAN DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS next_tiktok_post_date     TIMESTAMPTZ;

-- ── generated_content: add platform-specific columns ─────────────────────────
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS linkedin_post   TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS twitter_post    TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS tiktok_script   TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS tiktok_caption  TEXT;

-- ── oauth_states: PKCE code_verifier storage for Twitter + TikTok OAuth ───────
CREATE TABLE IF NOT EXISTS oauth_states (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL,
  state         TEXT NOT NULL UNIQUE,
  code_verifier TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '10 minutes')
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_state    ON oauth_states(state);
CREATE INDEX IF NOT EXISTS idx_oauth_states_platform ON oauth_states(platform, business_id);

-- ── Verify all new columns ─────────────────────────────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'businesses'
  AND column_name IN (
    'linkedin_refresh_token','linkedin_person_id','linkedin_organization_id',
    'linkedin_connected','next_linkedin_post_date',
    'twitter_access_token','twitter_refresh_token','twitter_user_id',
    'twitter_connected','next_twitter_post_date',
    'tiktok_refresh_token','tiktok_user_id','tiktok_connected','next_tiktok_post_date'
  )
ORDER BY column_name;
