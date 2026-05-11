-- 060_subscriptions_rls.sql
-- ---------------------------------------------------------------------------
-- Enable Row-Level Security on public.subscriptions.
--
-- This table was created out-of-band (Stripe Supabase template / Lovable
-- integration / manual setup) and never received an RLS policy, so Supabase
-- Security Advisor flagged it as Critical: any anon-key request could read
-- every row.
--
-- Pattern matches every other table in 000_schema_bootstrap.sql:
--   1. ENABLE ROW LEVEL SECURITY
--   2. Grant FULL access to the service_role (used by our Railway backend)
--   3. Deny everything else by default
--
-- We use a DEFENSIVE DO block because the table may or may not exist
-- depending on which path the user took during account setup.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  has_user_id BOOLEAN;
  has_business_id BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
  ) THEN
    RAISE NOTICE '[060] public.subscriptions does not exist — skipping RLS setup.';
    RETURN;
  END IF;

  -- 1. Force-enable RLS (FORCE makes it apply even to the table owner)
  EXECUTE 'ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE public.subscriptions FORCE ROW LEVEL SECURITY';

  -- 2. Drop any pre-existing policies with the same names so this migration is idempotent
  EXECUTE 'DROP POLICY IF EXISTS "subscriptions_service_full" ON public.subscriptions';
  EXECUTE 'DROP POLICY IF EXISTS "subscriptions_owner_read" ON public.subscriptions';

  -- 3. Service-role: full read/write (this is what the Railway backend uses)
  EXECUTE $POL$
    CREATE POLICY "subscriptions_service_full" ON public.subscriptions
      FOR ALL TO service_role
      USING (true)
      WITH CHECK (true)
  $POL$;

  -- 4. Authenticated users: read their own subscription only (if user_id column exists)
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions' AND column_name = 'user_id'
  ) INTO has_user_id;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions' AND column_name = 'business_id'
  ) INTO has_business_id;

  IF has_user_id THEN
    EXECUTE $POL$
      CREATE POLICY "subscriptions_owner_read" ON public.subscriptions
        FOR SELECT TO authenticated
        USING (auth.uid() = user_id)
    $POL$;
    RAISE NOTICE '[060] Added owner-read policy via user_id column.';
  ELSIF has_business_id THEN
    -- Fallback: scope by business ownership (businesses.user_id = auth.uid())
    EXECUTE $POL$
      CREATE POLICY "subscriptions_owner_read" ON public.subscriptions
        FOR SELECT TO authenticated
        USING (
          business_id IN (
            SELECT id FROM public.businesses WHERE user_id = auth.uid()
          )
        )
    $POL$;
    RAISE NOTICE '[060] Added owner-read policy via business_id → businesses.user_id.';
  ELSE
    RAISE NOTICE '[060] No user_id or business_id column found — only service_role has access. anon/authenticated reads are now blocked.';
  END IF;

  RAISE NOTICE '[060] public.subscriptions: RLS enabled, service_role full, anon blocked.';
END $$;

-- Record this migration in the ledger (created by migration 055).
-- Schema: _migrations(id, filename, checksum, applied_at, applied_by, duration_ms, notes)
-- The checksum is a placeholder — scripts/check-migrations.js will recompute
-- the real sha256 against the repo file on next CI run.
INSERT INTO public._migrations (filename, checksum, applied_at, notes)
VALUES (
  '060_subscriptions_rls.sql',
  'manual-apply-2026-05-11',
  NOW(),
  'Applied via Supabase SQL editor — checksum will be backfilled by check-migrations.js'
)
ON CONFLICT (filename) DO UPDATE SET applied_at = EXCLUDED.applied_at;
