-- migrations/073_oauth_plaintext_drop.sql
-- ----------------------------------------------------------------------------
-- Drop plaintext OAuth token columns now that the AES-256-GCM encrypted
-- counterparts (added in migration 056) are populated for every row.
--
-- CLAUDE.md §9 has tracked this migration as "never written" for months —
-- the original 060 slot was repurposed for subscriptions_rls and the drop
-- got dropped on the floor. This is the missing migration.
--
-- SAFETY:
--   - Wrapped in a guard that only fires if every row's _enc column is
--     non-null. If the backfill (scripts/encrypt-oauth-tokens.js) hasn't
--     completed, the migration RAISES and aborts before dropping anything.
--   - Each column drop uses IF EXISTS so re-running is safe.
--   - Plaintext columns are NULL'd before being dropped so the rollback
--     path (re-add the column from backup) doesn't surface stale tokens.
--
-- Pre-flight before applying:
--   1. Confirm OAUTH_TOKEN_ENC_KEY is set in production env.
--   2. Confirm `scripts/encrypt-oauth-tokens.js` was run AND succeeded.
--   3. Spot-check 3 random businesses: every _enc column populated.
--   4. Have a one-hour rollback window in case any caller still reads the
--      plaintext column (grep services + routes — should be zero today).
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_unencrypted_count int := 0;
BEGIN
  -- Bail if the backfill is incomplete. Counts businesses that have any
  -- plaintext token set but no matching encrypted token.
  SELECT count(*)
    INTO v_unencrypted_count
    FROM businesses
   WHERE (
     (google_refresh_token IS NOT NULL AND google_refresh_token_enc IS NULL)
     OR (meta_access_token IS NOT NULL AND meta_access_token_enc IS NULL)
     OR (linkedin_access_token IS NOT NULL AND linkedin_access_token_enc IS NULL)
     OR (twitter_access_token IS NOT NULL AND twitter_access_token_enc IS NULL)
     OR (tiktok_access_token IS NOT NULL AND tiktok_access_token_enc IS NULL)
     OR (ayrshare_user_token IS NOT NULL AND ayrshare_user_token_enc IS NULL)
   );

  IF v_unencrypted_count > 0 THEN
    RAISE EXCEPTION 'Refusing to drop plaintext OAuth columns: % businesses still have unencrypted tokens. Run scripts/encrypt-oauth-tokens.js first.', v_unencrypted_count;
  END IF;
END $$;

-- Null first so any rollback can't re-expose stale tokens.
UPDATE businesses SET google_refresh_token   = NULL WHERE google_refresh_token   IS NOT NULL;
UPDATE businesses SET meta_access_token      = NULL WHERE meta_access_token      IS NOT NULL;
UPDATE businesses SET linkedin_access_token  = NULL WHERE linkedin_access_token  IS NOT NULL;
UPDATE businesses SET twitter_access_token   = NULL WHERE twitter_access_token   IS NOT NULL;
UPDATE businesses SET tiktok_access_token    = NULL WHERE tiktok_access_token    IS NOT NULL;
UPDATE businesses SET ayrshare_user_token    = NULL WHERE ayrshare_user_token    IS NOT NULL;

ALTER TABLE businesses DROP COLUMN IF EXISTS google_refresh_token;
ALTER TABLE businesses DROP COLUMN IF EXISTS meta_access_token;
ALTER TABLE businesses DROP COLUMN IF EXISTS linkedin_access_token;
ALTER TABLE businesses DROP COLUMN IF EXISTS twitter_access_token;
ALTER TABLE businesses DROP COLUMN IF EXISTS tiktok_access_token;
ALTER TABLE businesses DROP COLUMN IF EXISTS ayrshare_user_token;

COMMENT ON TABLE businesses IS
  'OAuth tokens live in _enc columns only as of migration 073. Plaintext columns were dropped after the AES-256-GCM backfill (see scripts/encrypt-oauth-tokens.js + migration 056).';
