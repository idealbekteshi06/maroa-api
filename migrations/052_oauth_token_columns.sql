-- migrations/052_oauth_token_columns.sql
-- Adds the per-business OAuth + token columns captured by the new
-- Meta + Google OAuth flows in services/oauth/{meta,google}.js.
-- ---------------------------------------------------------------------------

-- ── Meta OAuth (in addition to existing meta_access_token + ad_account_id) ──
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS meta_token_expires_at     timestamptz,
  ADD COLUMN IF NOT EXISTS facebook_page_access_token text,
  ADD COLUMN IF NOT EXISTS meta_connected_at         timestamptz,
  ADD COLUMN IF NOT EXISTS meta_pixel_id             text;

-- ── Google OAuth ────────────────────────────────────────────────────────
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS google_refresh_token   text,
  ADD COLUMN IF NOT EXISTS google_customer_id     text,
  ADD COLUMN IF NOT EXISTS google_oauth_email     text,
  ADD COLUMN IF NOT EXISTS google_connected_at    timestamptz;

-- ── TikTok OAuth (already mentioned in tiktok-marketing client) ─────────
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS tiktok_access_token    text,
  ADD COLUMN IF NOT EXISTS tiktok_advertiser_id   text,
  ADD COLUMN IF NOT EXISTS tiktok_connected_at    timestamptz,
  ADD COLUMN IF NOT EXISTS tiktok_business_verified boolean;

-- ── Indexes ─────────────────────────────────────────────────────────────
-- Speed up "find businesses with broken Meta tokens" queries used by the
-- daily measurement-health probe.
CREATE INDEX IF NOT EXISTS idx_businesses_meta_token_expires
  ON businesses (meta_token_expires_at)
  WHERE meta_token_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_businesses_google_connected
  ON businesses (google_connected_at)
  WHERE google_refresh_token IS NOT NULL;

COMMENT ON COLUMN businesses.meta_token_expires_at IS
  'Long-lived Meta access token expiry (60 days from grant). meta_oauth.js refreshes on access naturally.';
COMMENT ON COLUMN businesses.google_refresh_token IS
  'Google OAuth refresh_token. Used by services/google-ads-api/ to mint short-lived access tokens on each API call.';
COMMENT ON COLUMN businesses.google_customer_id IS
  'Primary Google Ads customer ID (10-digit, no dashes). First customer returned by customers:listAccessibleCustomers at OAuth time.';
