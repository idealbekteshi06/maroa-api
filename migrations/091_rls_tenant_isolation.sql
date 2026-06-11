-- migrations/091_rls_tenant_isolation.sql
-- ───────────────────────────────────────────────────────────────────────
-- CRITICAL: close the cross-tenant read leak.
--
-- Many tables shipped with `CREATE POLICY ... FOR ALL USING (true)` and NO
-- `TO service_role` clause. A policy with no role clause defaults to
-- `TO public`, which includes Supabase's `anon` and `authenticated` roles —
-- and the frontend ships the anon (publishable) key. Postgres OR's all
-- permissive policies, so that one wide-open policy overrode every
-- owner-scoped policy and made the entire table readable (and writable) by
-- anyone holding the publishable key, with a client-supplied business_id
-- filter. Four tables (landing_pages, seo_recommendations, inbox_messages,
-- contact_enrollments) never had RLS enabled at all.
--
-- This migration replaces those broad policies with:
--   1. <table>_service_all  — FOR ALL TO service_role (server jobs keep working;
--      the service-role key is server-only).
--   2. <table>_owner_read   — FOR SELECT TO authenticated, scoped to the tenant
--      key (business_id → businesses.user_id, or user_id directly), so a
--      dashboard user sees only their own rows.
--
-- It DROPS all pre-existing policies on each covered table first (we recreate
-- a clean, minimal set; the old owner-read policies from 068 are recreated
-- here with the same name).
--
-- INTENTIONALLY EXCLUDED (public-facing insert flows — locking them would
-- break signup/forms; tracked as follow-up): waitlist, data_deletion_requests.
-- These expose row reads but are lower-sensitivity (emails) and need an
-- anon INSERT path; harden separately with column-scoped policies.
--
-- ROLLBACK: DROP POLICY "<table>_service_all"/"<table>_owner_read" per table,
-- and ALTER TABLE <table> DISABLE ROW LEVEL SECURITY where this enabled it.
-- ───────────────────────────────────────────────────────────────────────

BEGIN;

CREATE OR REPLACE FUNCTION _maroa_harden_rls(p_table text, p_owner_col text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  pol record;
BEGIN
  IF to_regclass('public.' || p_table) IS NULL THEN
    RAISE NOTICE 'skip % (table not present)', p_table;
    RETURN;
  END IF;

  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_table);

  -- Drop every existing policy; we recreate a clean, minimal set below.
  FOR pol IN
    SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = p_table
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, p_table);
  END LOOP;

  -- Server jobs use the service-role key — keep full access.
  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
    p_table || '_service_all', p_table
  );

  -- Authenticated dashboard users: read only rows they own.
  IF p_owner_col = 'business_id' THEN
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ' ||
      '(EXISTS (SELECT 1 FROM businesses b WHERE b.id = %I.business_id AND b.user_id = auth.uid()))',
      p_table || '_owner_read', p_table, p_table
    );
  ELSIF p_owner_col = 'user_id' THEN
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%I.user_id = auth.uid())',
      p_table || '_owner_read', p_table, p_table
    );
  END IF;
END;
$fn$;

-- business_id-keyed (server-written; dashboard reads its own) ─────────────
SELECT _maroa_harden_rls('landing_pages', 'business_id');
SELECT _maroa_harden_rls('seo_recommendations', 'business_id');
SELECT _maroa_harden_rls('contact_enrollments', 'business_id');
SELECT _maroa_harden_rls('inbox_messages', 'business_id'); -- to_regclass-guarded (created out-of-band)
SELECT _maroa_harden_rls('ad_audit_results', 'business_id');
SELECT _maroa_harden_rls('cro_audits', 'business_id');
SELECT _maroa_harden_rls('cro_rewrites', 'business_id');
SELECT _maroa_harden_rls('forecasts', 'business_id');
SELECT _maroa_harden_rls('voc_analyses', 'business_id');
SELECT _maroa_harden_rls('ai_seo_audits', 'business_id');
SELECT _maroa_harden_rls('ai_seo_artifacts', 'business_id');
SELECT _maroa_harden_rls('pacing_alerts', 'business_id');
SELECT _maroa_harden_rls('weekly_scorecards', 'business_id');
SELECT _maroa_harden_rls('brand_voice_history', 'business_id');
SELECT _maroa_harden_rls('llm_cost_logs', 'business_id');
SELECT _maroa_harden_rls('ai_weekly_reports', 'business_id');
SELECT _maroa_harden_rls('win_notifications', 'business_id');
SELECT _maroa_harden_rls('content_approvals', 'business_id');

-- user_id-keyed ───────────────────────────────────────────────────────────
SELECT _maroa_harden_rls('business_intelligence', 'user_id');
SELECT _maroa_harden_rls('ai_memory', 'user_id');
SELECT _maroa_harden_rls('business_health_scores', 'user_id');

-- business_profiles: keep owner read AND owner write (onboarding may write it
-- directly with the user's JWT), plus service_role full.
SELECT _maroa_harden_rls('business_profiles', 'user_id');
DROP POLICY IF EXISTS "business_profiles_owner_write" ON business_profiles;
CREATE POLICY "business_profiles_owner_write" ON business_profiles
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "business_profiles_owner_update" ON business_profiles;
CREATE POLICY "business_profiles_owner_update" ON business_profiles
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- service_role-only (no per-tenant dashboard read; server/global tables) ────
SELECT _maroa_harden_rls('referrals'); -- keyed by referrer_business_id, not business_id
SELECT _maroa_harden_rls('competitor_ads');
SELECT _maroa_harden_rls('webhook_subscriptions');

DROP FUNCTION _maroa_harden_rls(text, text);

COMMIT;
