-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 000 — Schema Bootstrap + Defensive Schema Repair
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Defensive Schema Repair ─────────────────────────────────────────────────
-- For every legacy table that might exist in a partial form from a prior
-- failed migration run, ensure the columns referenced by later CREATE INDEX
-- and CREATE POLICY statements actually exist. Tables that don't exist yet
-- are skipped (they'll be created by the migration that owns them).
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    -- Foundational tables
    'businesses', 'generated_content', 'ad_campaigns', 'ad_performance_logs',
    'daily_stats', 'competitor_insights', 'business_photos', 'retention_logs',
    'ab_tests', 'onboarding_events', 'post_drafts', 'usage_logs',
    -- Migrations 001-031 referenced tables
    'organizations', 'organization_members', 'workspaces',
    'oauth_states', 'analytics_snapshots', 'analytics_reports',
    'email_sequences', 'contact_enrollments', 'ad_creatives',
    'contacts', 'contact_activities', 'deals',
    'competitor_snapshots', 'competitor_reports', 'content_pieces',
    'review_requests', 'reviews', 'seo_recommendations', 'video_generations',
    'revenue_attribution', 'learning_logs',
    'campaign_orchestrations', 'content_approvals', 'referrals',
    'competitor_ads', 'webhook_subscriptions',
    'business_profiles', 'referral_programs', 'lead_magnets',
    'launch_campaigns', 'customer_insights', 'marketing_ideas',
    'ai_seo_content', 'schema_markups', 'seo_pages',
    'pricing_recommendations', 'community_posts', 'sales_assets',
    'lead_scores', 'free_tools', 'orchestration_logs',
    'business_intelligence', 'ai_memory', 'business_health_scores',
    'waitlist', 'ai_weekly_reports', 'win_notifications',
    'content_library', 'data_deletion_requests',
    -- Migrations 024-036 (V2 layer, may have been partially created)
    'events', 'approvals', 'brain_decisions',
    'content_plans', 'content_concepts', 'content_assets',
    'content_posts', 'content_performance', 'learning_patterns',
    'weekly_briefs', 'brief_plan_actions', 'brief_delivery_log',
    'brief_delivery_settings', 'reader_preferences_learned',
    'brain_conversations', 'brain_messages', 'brain_tool_calls',
    'brain_attachments', 'brain_memory',
    'lead_responses', 'routing_rules', 'icp_definitions',
    'review_responses', 'review_disputes', 'testimonial_library',
    'ad_optimization_runs', 'ad_optimization_actions',
    'competitor_briefs', 'presence_audits', 'schema_markup_generated',
    'email_segments', 'email_enrollments', 'insight_reports',
    'inbox_threads', 'inbox_replies', 'studio_jobs',
    'launches', 'launch_activities', 'budget_optimizer_runs',
    'creative_concepts', 'business_characters', 'asset_vetting_results',
    'anthropic_files', 'anthropic_batches', 'anthropic_batch_results'
  ]) LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS business_id UUID', t);
    EXCEPTION
      WHEN undefined_table THEN NULL;
      WHEN OTHERS THEN NULL;
    END;
    BEGIN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()', t);
    EXCEPTION
      WHEN undefined_table THEN NULL;
      WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 000 — Schema Bootstrap
-- ─────────────────────────────────────────────────────────────────────────────
-- Creates the 12 foundational Maroa tables that every other migration
-- assumes already exist. Originally these were created by the early Lovable
-- scaffold / manual Supabase setup, but the SQL for them was never tracked
-- in this migrations folder — meaning anyone applying migrations on a fresh
-- Supabase project would hit "ALTER TABLE businesses … relation does not
-- exist" and "column business_id does not exist" cascades.
--
-- DEFENSIVE PATTERN: each table follows
--    CREATE TABLE IF NOT EXISTS …  (creates if missing)
--    ALTER TABLE … ADD COLUMN IF NOT EXISTS … (adds any missing columns)
--    CREATE INDEX IF NOT EXISTS …
-- This handles BOTH a fresh project AND a partially-applied state where the
-- table exists but with an older / shorter column list.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── businesses (the central tenant table) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS businesses (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     UUID,
  email                       TEXT,
  first_name                  TEXT,
  business_name               TEXT,
  industry                    TEXT,
  location                    TEXT,
  target_audience             TEXT,
  brand_tone                  TEXT,
  marketing_goal              TEXT,
  is_active                   BOOLEAN DEFAULT TRUE,
  social_accounts_connected   BOOLEAN DEFAULT FALSE,
  facebook_page_id            TEXT,
  instagram_account_id        TEXT,
  meta_access_token           TEXT,
  ad_account_id               TEXT,
  daily_budget                NUMERIC DEFAULT 0,
  plan                        TEXT DEFAULT 'free',
  plan_price                  NUMERIC DEFAULT 0,
  marketing_strategy          JSONB,
  onboarding_complete         BOOLEAN DEFAULT FALSE,
  total_reach                 INT DEFAULT 0,
  weekly_reach                INT DEFAULT 0,
  weekly_leads                INT DEFAULT 0,
  total_spend                 NUMERIC DEFAULT 0,
  avg_roas                    NUMERIC DEFAULT 0,
  followers_gained            INT DEFAULT 0,
  posts_published             INT DEFAULT 0,
  competitors                 JSONB DEFAULT '[]',
  testimonial_requested       BOOLEAN DEFAULT FALSE,
  google_business_id          TEXT,
  google_access_token         TEXT,
  last_login_at               TIMESTAMPTZ,
  notification_preferences    JSONB DEFAULT '{}',
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS business_name TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS industry TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS target_audience TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS brand_tone TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS marketing_goal TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS social_accounts_connected BOOLEAN DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS facebook_page_id TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS instagram_account_id TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS meta_access_token TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ad_account_id TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS daily_budget NUMERIC DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'free';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS plan_price NUMERIC DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS marketing_strategy JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS total_reach INT DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS weekly_reach INT DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS weekly_leads INT DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS total_spend NUMERIC DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS avg_roas NUMERIC DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS followers_gained INT DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS posts_published INT DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS competitors JSONB DEFAULT '[]';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS testimonial_requested BOOLEAN DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS google_business_id TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS google_access_token TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS notification_preferences JSONB DEFAULT '{}';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_businesses_user ON businesses (user_id);
CREATE INDEX IF NOT EXISTS idx_businesses_active ON businesses (is_active);

-- ── generated_content ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS generated_content (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                 UUID,
  instagram_caption           TEXT,
  instagram_caption_2         TEXT,
  facebook_post               TEXT,
  instagram_story_text        TEXT,
  email_subject               TEXT,
  email_body                  TEXT,
  blog_title                  TEXT,
  google_ad_headline          TEXT,
  google_ad_description       TEXT,
  content_theme               TEXT,
  image_url                   TEXT,
  status                      TEXT DEFAULT 'pending',
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  published_at                TIMESTAMPTZ,
  image_generated_at          TIMESTAMPTZ,
  approval_email_sent_at      TIMESTAMPTZ,
  approved_at                 TIMESTAMPTZ,
  approval_method             TEXT,
  image_source                TEXT,
  image_credit                TEXT
);
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS business_id UUID;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS instagram_caption TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS instagram_caption_2 TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS facebook_post TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS instagram_story_text TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS email_subject TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS email_body TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS blog_title TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS google_ad_headline TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS google_ad_description TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS content_theme TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS image_generated_at TIMESTAMPTZ;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS approval_email_sent_at TIMESTAMPTZ;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS approval_method TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS image_source TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS image_credit TEXT;
CREATE INDEX IF NOT EXISTS idx_generated_content_biz ON generated_content (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_content_status ON generated_content (status);

-- ── ad_campaigns ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_campaigns (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                 UUID,
  business_name               TEXT,
  meta_campaign_id            TEXT,
  status                      TEXT DEFAULT 'active',
  daily_budget                NUMERIC DEFAULT 0,
  last_decision               TEXT,
  last_decision_reason        TEXT,
  last_optimized_at           TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS business_id UUID;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS business_name TEXT;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS meta_campaign_id TEXT;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS daily_budget NUMERIC DEFAULT 0;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS last_decision TEXT;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS last_decision_reason TEXT;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS last_optimized_at TIMESTAMPTZ;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_biz ON ad_campaigns (business_id);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_status ON ad_campaigns (status);

-- ── ad_performance_logs ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_performance_logs (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id                 UUID,
  business_id                 UUID,
  spend                       NUMERIC DEFAULT 0,
  clicks                      INT DEFAULT 0,
  impressions                 INT DEFAULT 0,
  ctr                         NUMERIC DEFAULT 0,
  roas                        NUMERIC DEFAULT 0,
  cpc                         NUMERIC DEFAULT 0,
  frequency                   NUMERIC DEFAULT 0,
  reach                       INT DEFAULT 0,
  conversions                 INT DEFAULT 0,
  recommendation              TEXT,
  reason                      TEXT,
  logged_at                   TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE ad_performance_logs ADD COLUMN IF NOT EXISTS campaign_id UUID;
ALTER TABLE ad_performance_logs ADD COLUMN IF NOT EXISTS business_id UUID;
ALTER TABLE ad_performance_logs ADD COLUMN IF NOT EXISTS spend NUMERIC DEFAULT 0;
ALTER TABLE ad_performance_logs ADD COLUMN IF NOT EXISTS clicks INT DEFAULT 0;
ALTER TABLE ad_performance_logs ADD COLUMN IF NOT EXISTS impressions INT DEFAULT 0;
ALTER TABLE ad_performance_logs ADD COLUMN IF NOT EXISTS ctr NUMERIC DEFAULT 0;
ALTER TABLE ad_performance_logs ADD COLUMN IF NOT EXISTS roas NUMERIC DEFAULT 0;
ALTER TABLE ad_performance_logs ADD COLUMN IF NOT EXISTS cpc NUMERIC DEFAULT 0;
ALTER TABLE ad_performance_logs ADD COLUMN IF NOT EXISTS frequency NUMERIC DEFAULT 0;
ALTER TABLE ad_performance_logs ADD COLUMN IF NOT EXISTS reach INT DEFAULT 0;
ALTER TABLE ad_performance_logs ADD COLUMN IF NOT EXISTS conversions INT DEFAULT 0;
ALTER TABLE ad_performance_logs ADD COLUMN IF NOT EXISTS recommendation TEXT;
ALTER TABLE ad_performance_logs ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE ad_performance_logs ADD COLUMN IF NOT EXISTS logged_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_ad_perf_campaign ON ad_performance_logs (campaign_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_perf_business ON ad_performance_logs (business_id, logged_at DESC);

-- ── daily_stats ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_stats (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                 UUID,
  ig_reach                    INT DEFAULT 0,
  ig_impressions              INT DEFAULT 0,
  ig_followers                INT DEFAULT 0,
  fb_reach                    INT DEFAULT 0,
  fb_engaged                  INT DEFAULT 0,
  fb_fan_adds                 INT DEFAULT 0,
  total_reach                 INT DEFAULT 0,
  recorded_at                 TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS business_id UUID;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS ig_reach INT DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS ig_impressions INT DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS ig_followers INT DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS fb_reach INT DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS fb_engaged INT DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS fb_fan_adds INT DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS total_reach INT DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_daily_stats_biz_time ON daily_stats (business_id, recorded_at DESC);

-- ── competitor_insights ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS competitor_insights (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                 UUID,
  competitor_doing_well       TEXT,
  gap_opportunity             TEXT,
  content_to_steal            TEXT,
  positioning_tip             TEXT,
  recorded_at                 TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE competitor_insights ADD COLUMN IF NOT EXISTS business_id UUID;
ALTER TABLE competitor_insights ADD COLUMN IF NOT EXISTS competitor_doing_well TEXT;
ALTER TABLE competitor_insights ADD COLUMN IF NOT EXISTS gap_opportunity TEXT;
ALTER TABLE competitor_insights ADD COLUMN IF NOT EXISTS content_to_steal TEXT;
ALTER TABLE competitor_insights ADD COLUMN IF NOT EXISTS positioning_tip TEXT;
ALTER TABLE competitor_insights ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_competitor_insights_biz ON competitor_insights (business_id, recorded_at DESC);

-- ── business_photos ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_photos (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                 UUID,
  photo_url                   TEXT,
  photo_type                  TEXT,
  description                 TEXT,
  is_active                   BOOLEAN DEFAULT TRUE,
  use_count                   INT DEFAULT 0,
  last_used_at                TIMESTAMPTZ,
  uploaded_at                 TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE business_photos ADD COLUMN IF NOT EXISTS business_id UUID;
ALTER TABLE business_photos ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE business_photos ADD COLUMN IF NOT EXISTS photo_type TEXT;
ALTER TABLE business_photos ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE business_photos ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE business_photos ADD COLUMN IF NOT EXISTS use_count INT DEFAULT 0;
ALTER TABLE business_photos ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE business_photos ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_business_photos_biz ON business_photos (business_id);

-- ── retention_logs ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS retention_logs (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                 UUID,
  email_type                  TEXT,
  subject                     TEXT,
  sent_at                     TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE retention_logs ADD COLUMN IF NOT EXISTS business_id UUID;
ALTER TABLE retention_logs ADD COLUMN IF NOT EXISTS email_type TEXT;
ALTER TABLE retention_logs ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE retention_logs ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_retention_logs_biz_time ON retention_logs (business_id, sent_at DESC);

-- ── ab_tests ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ab_tests (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                 UUID,
  campaign_id                 UUID,
  variant_a                   JSONB,
  variant_b                   JSONB,
  variant_c                   JSONB,
  winner                      TEXT,
  tested_at                   TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE ab_tests ADD COLUMN IF NOT EXISTS business_id UUID;
ALTER TABLE ab_tests ADD COLUMN IF NOT EXISTS campaign_id UUID;
ALTER TABLE ab_tests ADD COLUMN IF NOT EXISTS variant_a JSONB;
ALTER TABLE ab_tests ADD COLUMN IF NOT EXISTS variant_b JSONB;
ALTER TABLE ab_tests ADD COLUMN IF NOT EXISTS variant_c JSONB;
ALTER TABLE ab_tests ADD COLUMN IF NOT EXISTS winner TEXT;
ALTER TABLE ab_tests ADD COLUMN IF NOT EXISTS tested_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_ab_tests_biz ON ab_tests (business_id, tested_at DESC);

-- ── onboarding_events ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS onboarding_events (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                 UUID,
  event_type                  TEXT,
  event_data                  JSONB,
  created_at                  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE onboarding_events ADD COLUMN IF NOT EXISTS business_id UUID;
ALTER TABLE onboarding_events ADD COLUMN IF NOT EXISTS event_type TEXT;
ALTER TABLE onboarding_events ADD COLUMN IF NOT EXISTS event_data JSONB;
ALTER TABLE onboarding_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_onboarding_events_biz ON onboarding_events (business_id, created_at DESC);

-- ── post_drafts ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS post_drafts (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                 UUID,
  post_text                   TEXT,
  image_url                   TEXT,
  platforms_selected          JSONB DEFAULT '[]',
  scheduled_at                TIMESTAMPTZ,
  status                      TEXT DEFAULT 'draft',
  created_at                  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE post_drafts ADD COLUMN IF NOT EXISTS business_id UUID;
ALTER TABLE post_drafts ADD COLUMN IF NOT EXISTS post_text TEXT;
ALTER TABLE post_drafts ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE post_drafts ADD COLUMN IF NOT EXISTS platforms_selected JSONB DEFAULT '[]';
ALTER TABLE post_drafts ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE post_drafts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft';
ALTER TABLE post_drafts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_post_drafts_biz_status ON post_drafts (business_id, status, scheduled_at);

-- ── usage_logs (per-action plan-limit tracking, used by middleware/planLimits.js)
CREATE TABLE IF NOT EXISTS usage_logs (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     UUID,
  business_id                 UUID,
  action                      TEXT,
  created_at                  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS business_id UUID;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS action TEXT;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_action_time ON usage_logs (user_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_logs_biz_time ON usage_logs (business_id, created_at DESC);

-- ── RLS — service-role full access; user owners can read their rows ─────────
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "businesses_service_full" ON businesses;
CREATE POLICY "businesses_service_full" ON businesses FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE generated_content ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "generated_content_service_full" ON generated_content;
CREATE POLICY "generated_content_service_full" ON generated_content FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE ad_campaigns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ad_campaigns_service_full" ON ad_campaigns;
CREATE POLICY "ad_campaigns_service_full" ON ad_campaigns FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE ad_performance_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ad_performance_logs_service_full" ON ad_performance_logs;
CREATE POLICY "ad_performance_logs_service_full" ON ad_performance_logs FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE daily_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "daily_stats_service_full" ON daily_stats;
CREATE POLICY "daily_stats_service_full" ON daily_stats FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE competitor_insights ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "competitor_insights_service_full" ON competitor_insights;
CREATE POLICY "competitor_insights_service_full" ON competitor_insights FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE business_photos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "business_photos_service_full" ON business_photos;
CREATE POLICY "business_photos_service_full" ON business_photos FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE retention_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "retention_logs_service_full" ON retention_logs;
CREATE POLICY "retention_logs_service_full" ON retention_logs FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE ab_tests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ab_tests_service_full" ON ab_tests;
CREATE POLICY "ab_tests_service_full" ON ab_tests FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE onboarding_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "onboarding_events_service_full" ON onboarding_events;
CREATE POLICY "onboarding_events_service_full" ON onboarding_events FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE post_drafts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "post_drafts_service_full" ON post_drafts;
CREATE POLICY "post_drafts_service_full" ON post_drafts FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "usage_logs_service_full" ON usage_logs;
CREATE POLICY "usage_logs_service_full" ON usage_logs FOR ALL TO service_role USING (true) WITH CHECK (true);
