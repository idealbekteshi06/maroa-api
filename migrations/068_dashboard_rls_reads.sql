-- migrations/068_dashboard_rls_reads.sql
-- ───────────────────────────────────────────────────────────────────────
-- Authenticated-user SELECT policies for every table the frontend
-- dashboard reads directly via the Supabase anon client.
--
-- WHY THIS EXISTS
-- ════════════════
-- Before this migration, most operational tables had only a
--   FOR ALL TO service_role USING (true)
-- policy. The frontend uses the anon key + a user JWT, which is NOT
-- the service role — so authenticated reads from the dashboard fall
-- through to RLS deny and return empty arrays (or, for a few tables
-- with a wide-open USING (true) ALL policy, expose everyone's data).
--
-- The new policies are tightly scoped: a row is visible only to a
-- user who owns the business that owns the row. This mirrors the
-- pattern already in 024_wf1_content_engine, 025_wf13_weekly_brief,
-- 032_creative_concepts, etc.
--
-- TABLES COVERED (and why each)
--   ad_campaigns           — Ads tab + AdOptimization page (live list)
--   ad_performance_logs    — AdOptimization page (30-day chart, KPI deltas)
--   ad_audit_results       — AdOptimization page (decisions + opportunities)
--   generated_content      — Approvals page + Home (pending queue)
--   analytics_snapshots    — Home KPI grid (reach / leads / ad spend / revenue)
--   contacts               — CRM tab (lead list)
--   competitor_insights    — Competitors tab
--   retention_logs         — Insights / health surfaces
--   win_notifications      — Home + insights (wins ticker)
--
-- INTENTIONALLY OMITTED
--   business_profiles      — already has authenticated SELECT (012)
--   creative_concepts      — already has authenticated SELECT (032)
--   businesses             — owner read is enforced inline by app code;
--                            adding RLS here without an INSERT/UPDATE
--                            policy would break signup. Out of scope.
--
-- KNOWN FOLLOW-UP
--   Several existing policies are FOR ALL USING (true) without a
--   `TO service_role` clause (037_ad_audit_results line 74; 020 win
--   notifications via DO loop). That makes the table effectively
--   readable by anon. Tightening those is a separate migration —
--   doing it here risks breaking server-side jobs that depend on
--   them. Tracked separately.
--
-- ROLLBACK
--   DROP POLICY "<table>_owner_read" ON <table>;  for each table.
--   RLS-enable on analytics_snapshots / contacts also added here —
--   ROLLBACK them with: ALTER TABLE <table> DISABLE ROW LEVEL SECURITY;
-- ───────────────────────────────────────────────────────────────────────

BEGIN;

-- ad_campaigns ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "ad_campaigns_owner_read" ON ad_campaigns;
CREATE POLICY "ad_campaigns_owner_read" ON ad_campaigns FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = ad_campaigns.business_id AND b.user_id = auth.uid())
);

-- ad_performance_logs ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "ad_performance_logs_owner_read" ON ad_performance_logs;
CREATE POLICY "ad_performance_logs_owner_read" ON ad_performance_logs FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = ad_performance_logs.business_id AND b.user_id = auth.uid())
);

-- ad_audit_results ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "ad_audit_results_owner_read" ON ad_audit_results;
CREATE POLICY "ad_audit_results_owner_read" ON ad_audit_results FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = ad_audit_results.business_id AND b.user_id = auth.uid())
);

-- generated_content ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "generated_content_owner_read" ON generated_content;
CREATE POLICY "generated_content_owner_read" ON generated_content FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = generated_content.business_id AND b.user_id = auth.uid())
);

-- analytics_snapshots ──────────────────────────────────────────────────
ALTER TABLE analytics_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "analytics_snapshots_service_full" ON analytics_snapshots;
CREATE POLICY "analytics_snapshots_service_full" ON analytics_snapshots FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "analytics_snapshots_owner_read" ON analytics_snapshots;
CREATE POLICY "analytics_snapshots_owner_read" ON analytics_snapshots FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = analytics_snapshots.business_id AND b.user_id = auth.uid())
);

-- contacts ─────────────────────────────────────────────────────────────
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "contacts_service_full" ON contacts;
CREATE POLICY "contacts_service_full" ON contacts FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "contacts_owner_read" ON contacts;
CREATE POLICY "contacts_owner_read" ON contacts FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = contacts.business_id AND b.user_id = auth.uid())
);

-- competitor_insights ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "competitor_insights_owner_read" ON competitor_insights;
CREATE POLICY "competitor_insights_owner_read" ON competitor_insights FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = competitor_insights.business_id AND b.user_id = auth.uid())
);

-- retention_logs ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "retention_logs_owner_read" ON retention_logs;
CREATE POLICY "retention_logs_owner_read" ON retention_logs FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = retention_logs.business_id AND b.user_id = auth.uid())
);

-- win_notifications ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "win_notifications_owner_read" ON win_notifications;
CREATE POLICY "win_notifications_owner_read" ON win_notifications FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = win_notifications.business_id AND b.user_id = auth.uid())
);

-- ───────────────────────────────────────────────────────────────────────
-- Sanity check: every targeted table should now have at least one
-- owner_read policy. Migration fails loudly if any are missing.
-- ───────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(t, ', ') INTO missing
  FROM unnest(ARRAY[
    'ad_campaigns', 'ad_performance_logs', 'ad_audit_results',
    'generated_content', 'analytics_snapshots', 'contacts',
    'competitor_insights', 'retention_logs', 'win_notifications'
  ]) AS t
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = t
      AND policyname = t || '_owner_read'
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 068: missing owner_read policy on: %', missing;
  END IF;
END $$;

COMMIT;
