-- migrations/056_oauth_token_encryption.sql
-- ----------------------------------------------------------------------------
-- Encrypt OAuth tokens at rest.
--
-- Adds `*_enc` columns alongside the existing plaintext OAuth token columns
-- created by migration 052. Application code writes new tokens to BOTH the
-- encrypted column AND the legacy plaintext column (via lib/oauthCrypto.js)
-- so reads continue to work during the transition. A follow-up migration
-- (planned 060_drop_plaintext_oauth_tokens.sql) drops the plaintext columns
-- once a backfill script has run + been verified in production.
--
-- Encryption: AES-256-GCM applied app-side (Node `crypto.createCipheriv`),
-- key from OAUTH_TOKEN_ENC_KEY env var (32 random bytes, hex-encoded).
-- Encrypted blob format stored as text: "v1:<iv_hex>:<tag_hex>:<ciphertext_hex>"
--
-- Why app-side AES-GCM instead of pgcrypto pgp_sym_encrypt:
--   - No DB function changes, works with regular PostgREST PATCH
--   - Key never leaves the app container — DB only sees ciphertext
--   - GCM provides authenticated encryption (integrity + confidentiality)
--   - Same scheme works for Postgres-on-anything, not just Supabase
--
-- After this migration is applied:
--   1. Run scripts/encrypt-oauth-tokens.js to backfill `*_enc` columns
--      from existing plaintext values (one-time, idempotent).
--   2. Verify lib/oauthCrypto.decrypt() returns the original token for
--      every row.
--   3. Schedule migration 060 to drop plaintext columns.
--
-- Idempotent — ADD COLUMN IF NOT EXISTS means re-running is safe.
-- ----------------------------------------------------------------------------

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS google_refresh_token_enc       text,
  ADD COLUMN IF NOT EXISTS meta_access_token_enc          text,
  ADD COLUMN IF NOT EXISTS facebook_page_access_token_enc text,
  ADD COLUMN IF NOT EXISTS instagram_access_token_enc     text,
  ADD COLUMN IF NOT EXISTS tiktok_access_token_enc        text,
  ADD COLUMN IF NOT EXISTS google_access_token_enc        text;

COMMENT ON COLUMN businesses.google_refresh_token_enc IS
  'AES-256-GCM encrypted google_refresh_token. Format: v1:<iv>:<tag>:<ciphertext>. See lib/oauthCrypto.js.';
COMMENT ON COLUMN businesses.meta_access_token_enc IS
  'AES-256-GCM encrypted meta_access_token. Format: v1:<iv>:<tag>:<ciphertext>. See lib/oauthCrypto.js.';

-- Partial indexes — only index rows that have an encrypted token, keeps
-- index size proportional to actual data.
CREATE INDEX IF NOT EXISTS idx_businesses_google_enc
  ON businesses (id) WHERE google_refresh_token_enc IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_businesses_meta_enc
  ON businesses (id) WHERE meta_access_token_enc IS NOT NULL;
