-- migrations/093_backfill_business_user_id.sql
-- ───────────────────────────────────────────────────────────────────────
-- Backfill businesses.user_id for legacy rows where it is NULL.
--
-- WHY (the 403 + duplicate bug):
--   RLS owner-read policies (migrations 068 + 091) authorize a dashboard user
--   via `businesses.user_id = auth.uid()` — directly, or joined through
--   business_id on child tables. A legacy `businesses` row with user_id IS NULL
--   is therefore invisible to its rightful owner → every authenticated read
--   403s. It also breaks signup's `user_id = eq.<uid>` lookup, so signup never
--   finds the existing row and inserts a DUPLICATE business for the same user.
--
-- FIX:
--   Populate user_id from the row's own `email`, matched to auth.users.email —
--   which is exactly how signup sets it (server.js: insertData.user_id and
--   insertData.email both come from the same authenticated user).
--
-- SAFETY (the live DB has drifted — guard everything):
--   • Schema-tolerant: every table/column reference is checked with
--     to_regclass / information_schema first. If businesses, its user_id/email
--     columns, or auth.users are absent, the migration NO-OPs with a NOTICE
--     instead of erroring.
--   • Idempotent: only rows WHERE user_id IS NULL are touched, so it is safe to
--     re-run and converges. Re-running after a fix changes nothing.
--   • Non-destructive: never nulls or overwrites a populated user_id.
--   • Deliberately NO uniqueness constraint on user_id — agency-plan customers
--     legitimately own multiple businesses.
--
-- Rows whose email is NULL/empty (or matches no auth user) are left untouched
-- and counted in the NOTICE for manual review — they cannot be linked safely.
--
-- ROLLBACK: none required (additive data fix).
-- ───────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_has_user_id   boolean;
  v_has_email     boolean;
  v_before        bigint;
  v_fixed         bigint;
  v_remaining     bigint;
BEGIN
  -- ── Guards — tolerate a drifted / partial schema ───────────────────────
  IF to_regclass('public.businesses') IS NULL THEN
    RAISE NOTICE '093 skip: public.businesses not present';
    RETURN;
  END IF;
  IF to_regclass('auth.users') IS NULL THEN
    RAISE NOTICE '093 skip: auth.users not present (non-Supabase environment)';
    RETURN;
  END IF;

  v_has_user_id := EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'businesses' AND column_name = 'user_id');
  v_has_email := EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'businesses' AND column_name = 'email');

  IF NOT (v_has_user_id AND v_has_email) THEN
    RAISE NOTICE '093 skip: businesses.user_id present=% / businesses.email present=% — nothing to backfill',
      v_has_user_id, v_has_email;
    RETURN;
  END IF;

  SELECT count(*) INTO v_before FROM public.businesses WHERE user_id IS NULL;

  -- ── Backfill: link each orphaned row to its auth user by email ─────────
  -- auth.users.email is unique per user in Supabase; lower() guards casing.
  UPDATE public.businesses AS b
     SET user_id = u.id
    FROM auth.users AS u
   WHERE b.user_id IS NULL
     AND b.email IS NOT NULL
     AND b.email <> ''
     AND lower(b.email) = lower(u.email);

  GET DIAGNOSTICS v_fixed = ROW_COUNT;

  SELECT count(*) INTO v_remaining FROM public.businesses WHERE user_id IS NULL;

  RAISE NOTICE '093 backfill complete: % rows had NULL user_id; backfilled %; % still NULL (no email match — manual review)',
    v_before, v_fixed, v_remaining;
END $$;
