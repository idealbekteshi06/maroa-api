-- migrations/094_oauth_token_refresh_columns.sql
-- ───────────────────────────────────────────────────────────────────────
-- Columns the proactive OAuth token-refresh cron needs (feature #2 rebuild).
--
-- The encryption migration (056) added *_access_token_enc for Google/Meta/
-- TikTok but skipped LinkedIn + Twitter and every refresh token; migration 073
-- then dropped the plaintext access tokens. Net result: no encrypted home for
-- LinkedIn/Twitter access tokens or any rotated refresh token, and no expiry
-- tracking anywhere — so a scheduled refresh had nowhere to persist its output.
--
-- This adds, idempotently (ADD COLUMN IF NOT EXISTS) and schema-tolerantly
-- (guarded on businesses existing):
--   • <provider>_access_token_enc   — encrypted access token (AES-256-GCM blob)
--   • <provider>_refresh_token_enc  — encrypted, rotated refresh token
--   • <provider>_token_expires_at   — absolute expiry, so the cron knows when a
--                                     token is within its refresh lead window
--
-- TikTok already has tiktok_access_token_enc (migration 056); only its refresh
-- + expiry are added here. Re-runnable; never drops or rewrites data.
-- ───────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.businesses') IS NULL THEN
    RAISE NOTICE '094 skip: public.businesses not present';
    RETURN;
  END IF;

  -- LinkedIn
  ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS linkedin_access_token_enc  TEXT;
  ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS linkedin_refresh_token_enc TEXT;
  ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS linkedin_token_expires_at  TIMESTAMPTZ;

  -- Twitter / X
  ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS twitter_access_token_enc   TEXT;
  ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS twitter_refresh_token_enc  TEXT;
  ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS twitter_token_expires_at   TIMESTAMPTZ;

  -- TikTok (tiktok_access_token_enc already added in migration 056)
  ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS tiktok_refresh_token_enc   TEXT;
  ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS tiktok_token_expires_at    TIMESTAMPTZ;

  RAISE NOTICE '094: oauth token-refresh columns ensured (linkedin/twitter/tiktok: access_enc, refresh_enc, expires_at)';
END $$;
