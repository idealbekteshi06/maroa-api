-- migrations/059_business_oauth_credentials.sql
-- ----------------------------------------------------------------------------
-- Normalize OAuth credentials out of `businesses` into a dedicated child
-- table.
--
-- The `businesses` row currently carries 12+ OAuth columns across 6+
-- providers (Meta, Google, LinkedIn, Twitter, TikTok, Threads), each with
-- its own access_token + refresh_token + expires_at + connected flag.
-- That makes:
--   - Row width unwieldy (40+ columns, JSONB further bloats it)
--   - Encryption migration (056) had to add 6 *_enc columns to businesses
--   - Adding a 7th OAuth provider mutates a hot table
--   - Provider-specific audit queries scan businesses for one provider's
--     columns
--
-- This migration creates `business_oauth_credentials` with a clean
-- (business_id, provider) composite primary key. One row per
-- (business, provider). Schema-flexible via `extra` JSONB for
-- provider-specific fields (org_id for LinkedIn, page_id for Meta, etc).
--
-- TRANSITION PLAN:
--   056 + 059 coexist via dual-write. Existing reads/writes use legacy
--   columns; new writes ALSO populate this table. After production
--   verification, migration 070 drops the legacy OAuth columns from
--   `businesses`.
--
-- ROW-LEVEL SECURITY (Supabase RLS) is recommended on this table —
-- consider enabling once a per-user policy is defined.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS business_oauth_credentials (
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider        text NOT NULL CHECK (provider IN (
                    'meta', 'google', 'google_ads',
                    'linkedin', 'twitter', 'tiktok', 'threads'
                  )),

  -- App-side AES-GCM encrypted (see lib/oauthCrypto.js)
  access_token_enc  text,
  refresh_token_enc text,

  -- Provider-specific identifiers (clear-text — these are not secrets)
  account_id          text,       -- ad_account_id for meta, customer_id for google_ads, etc.
  user_id_external    text,       -- twitter_user_id, tiktok_open_id, linkedin person sub
  org_id_external     text,       -- linkedin org id, meta business id, etc.

  -- Lifecycle
  expires_at        timestamptz,
  connected_at      timestamptz NOT NULL DEFAULT now(),
  last_verified_at  timestamptz,
  status            text NOT NULL DEFAULT 'connected'
                    CHECK (status IN ('connected', 'token_expired', 'revoked_by_user', 'unknown')),

  -- Catch-all for provider-specific data we don't want as columns
  extra             jsonb NOT NULL DEFAULT '{}'::jsonb,

  PRIMARY KEY (business_id, provider)
);

-- Most queries scan by business
CREATE INDEX IF NOT EXISTS idx_oauth_cred_business
  ON business_oauth_credentials (business_id);

-- Token-refresh cron filters by status + expires_at
CREATE INDEX IF NOT EXISTS idx_oauth_cred_expiring
  ON business_oauth_credentials (expires_at)
  WHERE status = 'connected' AND expires_at IS NOT NULL;

-- Provider-wide audit ("show me every business with a stale Meta token")
CREATE INDEX IF NOT EXISTS idx_oauth_cred_provider_status
  ON business_oauth_credentials (provider, status);

-- JSONB filter on extra (e.g. extra->>'page_id'='123')
CREATE INDEX IF NOT EXISTS idx_oauth_cred_extra_gin
  ON business_oauth_credentials USING GIN (extra jsonb_path_ops);

COMMENT ON TABLE business_oauth_credentials IS
  'Normalized per-provider OAuth credentials. Replaces 12+ columns on businesses. See migration 059 + ADR-0002.';
COMMENT ON COLUMN business_oauth_credentials.access_token_enc IS
  'AES-256-GCM encrypted access token. Use lib/oauthCrypto.decrypt().';
COMMENT ON COLUMN business_oauth_credentials.refresh_token_enc IS
  'AES-256-GCM encrypted refresh token. Use lib/oauthCrypto.decrypt().';
