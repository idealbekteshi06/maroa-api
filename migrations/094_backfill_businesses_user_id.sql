-- Migration 094 — backfill businesses.user_id for legacy rows
--
-- WHY: businesses.user_id was retrofitted (bootstrap adds the column, only
-- post-audit code writes it) with NO backfill. Legacy rows carry
-- user_id = NULL, which today means:
--   (a) assertBusinessOwner 403s the real owner (owner gate compares
--       req.user.id to businesses.user_id),
--   (b) every RLS-091 policy keyed on b.user_id = auth.uid() hides the row and
--       ALL its satellite tables → empty dashboards everywhere,
--   (c) AuthContext's user_id=eq.<uid> lookup misses → the frontend creates a
--       duplicate empty business row on next login.
--
-- The legacy convention was businesses.id == auth user id (the same id was
-- used for both — business_profiles.user_id still stores the business id
-- today). So the correct backfill is user_id = id, but ONLY where that id
-- actually exists in auth.users — anything else (operator-seeded demo rows,
-- imports) is left NULL rather than pointed at a nonexistent user.
--
-- Idempotent + re-runnable: the WHERE clause makes re-runs no-ops.

DO $$
DECLARE
  updated_count INTEGER;
BEGIN
  IF to_regclass('public.businesses') IS NULL THEN
    RAISE NOTICE 'businesses table absent — skipping 094 user_id backfill';
    RETURN;
  END IF;

  IF to_regclass('auth.users') IS NULL THEN
    -- No auth schema (bare shadow DB in CI) — nothing safe to verify against.
    RAISE NOTICE 'auth.users absent — skipping 094 user_id backfill';
    RETURN;
  END IF;

  UPDATE businesses b
  SET user_id = b.id
  WHERE b.user_id IS NULL
    AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = b.id);

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RAISE NOTICE '094: backfilled user_id on % legacy business row(s)', updated_count;

  -- Surface what could NOT be matched so the operator can triage manually
  -- (these rows remain invisible to RLS and 403'd by the owner gate).
  SELECT COUNT(*) INTO updated_count FROM businesses WHERE user_id IS NULL;
  IF updated_count > 0 THEN
    RAISE NOTICE '094: % business row(s) still have user_id = NULL (no matching auth.users id) — review manually', updated_count;
  END IF;
END $$;
