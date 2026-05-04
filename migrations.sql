-- ═══════════════════════════════════════════════════════════════════════════
-- Maroa.ai — Combined Migration Bundle (000 → 036)
-- ═══════════════════════════════════════════════════════════════════════════
-- HOW TO APPLY:
-- 1. Open the Supabase SQL editor
-- 2. Paste this ENTIRE file, click "Run"
-- 3. Wait ~30-90 seconds
-- 4. "already exists" notices → ignore (re-runs are safe)
--
-- IDEMPOTENT — safe to re-run as many times as needed.
-- Bootstrap (000) does:
--   1) Defensive schema repair: adds business_id + created_at to every
--      legacy table that may exist in partial form from a prior failed run
--   2) CREATE TABLE IF NOT EXISTS for the 12 foundational tables
--   3) ALTER TABLE ADD COLUMN IF NOT EXISTS for every column on each
--   4) RLS policies via DROP IF EXISTS + CREATE pattern
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 000_schema_bootstrap.sql
-- ═══════════════════════════════════════════════════════════════════════════
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


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 001_agency_multiworkspace.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 001: Agency Multi-Workspace tables
-- Run in: Supabase Dashboard → SQL Editor → New Query → paste → Run
-- Safe to re-run: all statements use IF NOT EXISTS guards
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. organizations
CREATE TABLE IF NOT EXISTS organizations (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      TEXT NOT NULL,
  owner_user_id             UUID,
  plan                      TEXT DEFAULT 'agency',
  stripe_customer_id        TEXT,
  white_label_logo_url      TEXT,
  white_label_primary_color TEXT DEFAULT '#667eea',
  white_label_company_name  TEXT,
  white_label_domain        TEXT,
  created_at                TIMESTAMPTZ DEFAULT NOW()
);

-- 2. organization_members
CREATE TABLE IF NOT EXISTS organization_members (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL,
  role             TEXT DEFAULT 'member' CHECK (role IN ('owner','admin','member','client')),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(organization_id, user_id)
);

-- 3. workspaces
CREATE TABLE IF NOT EXISTS workspaces (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id      UUID REFERENCES businesses(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  client_name      TEXT,
  is_active        BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Scope businesses to orgs
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS workspace_id    UUID REFERENCES workspaces(id);

-- 5. Indexes
CREATE INDEX IF NOT EXISTS idx_org_members_org  ON organization_members(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_org   ON workspaces(organization_id);
CREATE INDEX IF NOT EXISTS idx_businesses_org   ON businesses(organization_id);

-- 6. Row Level Security
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_owners_all"       ON organizations;
DROP POLICY IF EXISTS "org_members_read"     ON organizations;
DROP POLICY IF EXISTS "members_see_own_org"  ON organization_members;
DROP POLICY IF EXISTS "workspace_org_scope"  ON workspaces;

CREATE POLICY "org_owners_all" ON organizations
  FOR ALL USING (owner_user_id = auth.uid());

CREATE POLICY "org_members_read" ON organizations
  FOR SELECT USING (
    id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid())
  );

CREATE POLICY "members_see_own_org" ON organization_members
  FOR SELECT USING (
    organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid())
  );

CREATE POLICY "workspace_org_scope" ON workspaces
  FOR SELECT USING (
    organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid())
  );

-- 7. Verify
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('organizations','organization_members','workspaces')
ORDER BY tablename;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 002_social_platforms.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 002: LinkedIn, Twitter, TikTok columns
-- Run AFTER migration 001.
-- Safe to re-run: all statements use IF NOT EXISTS guards.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── LinkedIn (linkedin_access_token + linkedin_page_id already exist) ─────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS linkedin_refresh_token    TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS linkedin_person_id        TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS linkedin_organization_id  TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS linkedin_connected        BOOLEAN DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS next_linkedin_post_date   TIMESTAMPTZ;

-- ── Twitter (no columns exist yet) ────────────────────────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS twitter_access_token      TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS twitter_refresh_token     TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS twitter_user_id           TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS twitter_connected         BOOLEAN DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS next_twitter_post_date    TIMESTAMPTZ;

-- ── TikTok (tiktok_access_token already exists) ───────────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tiktok_refresh_token      TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tiktok_user_id            TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tiktok_connected          BOOLEAN DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS next_tiktok_post_date     TIMESTAMPTZ;

-- ── generated_content: add platform-specific columns ─────────────────────────
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS linkedin_post   TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS twitter_post    TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS tiktok_script   TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS tiktok_caption  TEXT;

-- ── oauth_states: PKCE code_verifier storage for Twitter + TikTok OAuth ───────
CREATE TABLE IF NOT EXISTS oauth_states (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL,
  state         TEXT NOT NULL UNIQUE,
  code_verifier TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '10 minutes')
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_state    ON oauth_states(state);
CREATE INDEX IF NOT EXISTS idx_oauth_states_platform ON oauth_states(platform, business_id);

-- ── Verify all new columns ─────────────────────────────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'businesses'
  AND column_name IN (
    'linkedin_refresh_token','linkedin_person_id','linkedin_organization_id',
    'linkedin_connected','next_linkedin_post_date',
    'twitter_access_token','twitter_refresh_token','twitter_user_id',
    'twitter_connected','next_twitter_post_date',
    'tiktok_refresh_token','tiktok_user_id','tiktok_connected','next_tiktok_post_date'
  )
ORDER BY column_name;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 003_analytics.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 003: Unified Analytics tables
-- Run AFTER migrations 001 + 002.
-- Safe to re-run: all statements use IF NOT EXISTS guards.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  snapshot_date    DATE NOT NULL,
  platform         TEXT NOT NULL,
  impressions      INT DEFAULT 0,
  reach            INT DEFAULT 0,
  engagement       INT DEFAULT 0,
  clicks           INT DEFAULT 0,
  followers_gained INT DEFAULT 0,
  posts_published  INT DEFAULT 0,
  email_sent       INT DEFAULT 0,
  email_opens      INT DEFAULT 0,
  email_clicks     INT DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(business_id, snapshot_date, platform)
);

CREATE TABLE IF NOT EXISTS analytics_reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  week_start       DATE NOT NULL,
  headline         TEXT,
  wins             JSONB DEFAULT '[]',
  concerns         JSONB DEFAULT '[]',
  recommendations  JSONB DEFAULT '[]',
  overall_score    INT CHECK (overall_score BETWEEN 1 AND 10),
  raw_data         JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_business ON analytics_snapshots(business_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_analytics_reports_business   ON analytics_reports(business_id);

-- Verify
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('analytics_snapshots','analytics_reports')
ORDER BY tablename;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 004_email_sequences.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 004: Behavior-Triggered Email Sequences
-- Run AFTER migration 003.
-- Safe to re-run: all statements use IF NOT EXISTS guards.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_sequences (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  trigger_type  TEXT NOT NULL,
  trigger_value TEXT,
  delay_hours   INT DEFAULT 0,
  is_active     BOOLEAN DEFAULT TRUE,
  emails        JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contact_enrollments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_email  TEXT NOT NULL,
  contact_name   TEXT,
  sequence_id    UUID NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
  current_step   INT DEFAULT 0,
  status         TEXT DEFAULT 'active'
                   CHECK (status IN ('active','completed','unsubscribed','bounced')),
  enrolled_at    TIMESTAMPTZ DEFAULT NOW(),
  next_send_at   TIMESTAMPTZ DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_enrollments_next_send ON contact_enrollments(next_send_at, status);
CREATE INDEX IF NOT EXISTS idx_enrollments_business  ON contact_enrollments(business_id, status);
CREATE INDEX IF NOT EXISTS idx_sequences_business    ON email_sequences(business_id, is_active);

-- Verify
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('email_sequences','contact_enrollments')
ORDER BY tablename;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 005_ads_module.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 005: Paid Ads Module — extend ad_campaigns + add ad_creatives
-- Run AFTER migrations 001–004.
-- Safe to re-run: all statements use IF NOT EXISTS guards.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Extend ad_campaigns ───────────────────────────────────────────────────────
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS platform         TEXT DEFAULT 'meta';
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS google_campaign_id TEXT;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS google_ad_group_id TEXT;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS objective         TEXT;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS impressions       INT DEFAULT 0;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS clicks            INT DEFAULT 0;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS conversions       INT DEFAULT 0;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS total_spend       NUMERIC DEFAULT 0;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS roas              NUMERIC DEFAULT 0;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS ai_strategy       JSONB;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS creatives         JSONB DEFAULT '[]';
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS paused_reason     TEXT;

-- ── ad_creatives table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_creatives (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  campaign_id      UUID REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  platform         TEXT NOT NULL,
  headline         TEXT,
  primary_text     TEXT,
  description      TEXT,
  cta              TEXT,
  image_url        TEXT,
  image_prompt     TEXT,
  meta_creative_id TEXT,
  status           TEXT DEFAULT 'active',
  impressions      INT DEFAULT 0,
  clicks           INT DEFAULT 0,
  ctr              NUMERIC DEFAULT 0,
  is_winner        BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_creatives_campaign ON ad_creatives(campaign_id);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_platform ON ad_campaigns(business_id, platform, status);

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'ad_campaigns'
  AND column_name IN (
    'platform','google_campaign_id','google_ad_group_id','objective',
    'impressions','clicks','conversions','total_spend','roas','ai_strategy','creatives','paused_reason'
  )
ORDER BY column_name;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 006_crm_competitor_content.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 006: CRM + Competitor Intelligence + Content Engine
-- Run AFTER migrations 001–005.
-- Safe to re-run: all statements use IF NOT EXISTS guards.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── CRM: contacts ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email            TEXT NOT NULL,
  first_name       TEXT,
  last_name        TEXT,
  phone            TEXT,
  company          TEXT,
  source           TEXT DEFAULT 'manual',
  lead_score       INT DEFAULT 0,
  stage            TEXT DEFAULT 'lead'
                     CHECK (stage IN ('lead','qualified','opportunity','customer','churned')),
  tags             TEXT[] DEFAULT '{}',
  custom_fields    JSONB DEFAULT '{}',
  sms_opted_in     BOOLEAN DEFAULT FALSE,
  last_activity_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(business_id, email)
);

-- ── CRM: contact_activities ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contact_activities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_id    UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── CRM: deals ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_id         UUID REFERENCES contacts(id) ON DELETE SET NULL,
  title              TEXT NOT NULL,
  value              NUMERIC DEFAULT 0,
  stage              TEXT DEFAULT 'new'
                       CHECK (stage IN ('new','contacted','proposal','negotiation','won','lost')),
  probability        INT DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  expected_close_date DATE,
  notes              TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ── Competitor Intelligence: competitor_snapshots ─────────────────────────────
CREATE TABLE IF NOT EXISTS competitor_snapshots (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  competitor_name  TEXT NOT NULL,
  competitor_url   TEXT,
  snapshot_date    DATE NOT NULL,
  social_posts     JSONB DEFAULT '[]',
  active_ads       JSONB DEFAULT '[]',
  keyword_rankings JSONB DEFAULT '[]',
  content_themes   TEXT[],
  pricing_data     JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Competitor Intelligence: competitor_reports ───────────────────────────────
CREATE TABLE IF NOT EXISTS competitor_reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  report_date      DATE NOT NULL,
  new_offers       JSONB DEFAULT '[]',
  content_themes   JSONB DEFAULT '[]',
  ad_angles        JSONB DEFAULT '[]',
  pricing_changes  JSONB DEFAULT '[]',
  recommendation   TEXT,
  raw_analysis     JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Content Engine: content_pieces ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content_pieces (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type                TEXT NOT NULL
                        CHECK (type IN ('blog','landing_page','video_script','email_template')),
  title               TEXT,
  target_keyword      TEXT,
  body                TEXT,
  meta_description    TEXT,
  featured_image_url  TEXT,
  status              TEXT DEFAULT 'draft'
                        CHECK (status IN ('draft','ready_for_review','approved','published')),
  published_url       TEXT,
  word_count          INT DEFAULT 0,
  seo_score           INT DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_contacts_business          ON contacts(business_id, stage);
CREATE INDEX IF NOT EXISTS idx_contacts_score             ON contacts(business_id, lead_score DESC);
CREATE INDEX IF NOT EXISTS idx_contact_activities_contact ON contact_activities(contact_id);
CREATE INDEX IF NOT EXISTS idx_deals_business             ON deals(business_id, stage);
CREATE INDEX IF NOT EXISTS idx_competitor_snapshots_biz   ON competitor_snapshots(business_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_content_pieces_business    ON content_pieces(business_id, type, status);

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'contacts','contact_activities','deals',
    'competitor_snapshots','competitor_reports','content_pieces'
  )
ORDER BY tablename;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 007_brand_memory_reviews.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 007: Brand Memory + Reviews
-- Run AFTER migrations 001–006.
-- Safe to re-run: all IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Reviews: review_requests ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS review_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_email TEXT NOT NULL,
  contact_name  TEXT,
  platform      TEXT DEFAULT 'google',
  sent_at       TIMESTAMPTZ DEFAULT NOW(),
  opened        BOOLEAN DEFAULT FALSE,
  clicked       BOOLEAN DEFAULT FALSE,
  review_link   TEXT
);

-- ── Reviews: reviews ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reviews (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  platform           TEXT NOT NULL,
  reviewer_name      TEXT,
  rating             INT CHECK (rating BETWEEN 1 AND 5),
  review_text        TEXT,
  review_date        TIMESTAMPTZ,
  platform_review_id TEXT UNIQUE,
  response_draft     TEXT,
  response_published TEXT,
  response_status    TEXT DEFAULT 'pending'
                       CHECK (response_status IN ('pending','draft_ready','published')),
  sentiment          TEXT CHECK (sentiment IN ('positive','neutral','negative')),
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_review_requests_business ON review_requests(business_id);
CREATE INDEX IF NOT EXISTS idx_reviews_business ON reviews(business_id, platform, response_status);

-- ── businesses: google_review_link ───────────────────────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS google_review_link TEXT;

-- ── organizations: support email for white label ──────────────────────────────
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS white_label_support_email TEXT;

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('review_requests','reviews')
ORDER BY tablename;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 008_seo_video.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 008: SEO Autopilot + Video Generation
-- Run AFTER migrations 001–007.
-- Safe to re-run: all IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- Note: CRO tests reuse existing ab_tests table (no new table needed).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── SEO Recommendations ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS seo_recommendations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  url                TEXT,
  type               TEXT NOT NULL,
  current_value      TEXT,
  recommended_value  TEXT,
  target_keyword     TEXT,
  priority           TEXT DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
  estimated_impact   TEXT,
  status             TEXT DEFAULT 'pending' CHECK (status IN ('pending','applied','dismissed')),
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  applied_at         TIMESTAMPTZ
);

-- ── Video Generations ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS video_generations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  platform       TEXT NOT NULL,
  script         JSONB,
  caption        TEXT,
  hashtags       TEXT[],
  thumbnail_url  TEXT,
  status         TEXT DEFAULT 'script_ready'
                   CHECK (status IN ('script_ready','generating','ready','published','failed')),
  runway_task_id TEXT,
  video_url      TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── businesses: website_url ───────────────────────────────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS website_url TEXT;

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_seo_recs_business  ON seo_recommendations(business_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_video_gen_business  ON video_generations(business_id, platform, status);

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('seo_recommendations','video_generations')
ORDER BY tablename;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 009_autonomous_agent.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 009: Autonomous Agent + Feedback Loops + Predictive Intelligence
-- Run in Supabase SQL Editor

-- ── New columns on generated_content ────────────────────────────────────────
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS performance_score NUMERIC DEFAULT 0;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS total_reach INT DEFAULT 0;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS facebook_post_id TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;

-- ── New columns on contacts ─────────────────────────────────────────────────
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS intent_level TEXT DEFAULT 'cold';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS recommended_action TEXT;

-- ── New columns on businesses ───────────────────────────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS optimal_posting_times JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS weekly_forecast JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS strategy_updated_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS estimated_revenue NUMERIC DEFAULT 0;

-- ── Revenue Attribution table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS revenue_attribution (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  source TEXT NOT NULL,
  campaign_id UUID,
  content_id UUID,
  attributed_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Learning Logs table (if not exists from earlier migration) ──────────────
CREATE TABLE IF NOT EXISTS learning_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  decision_date TIMESTAMPTZ,
  decision_data JSONB,
  actions_taken JSONB,
  performance_before JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add missing columns to learning_logs if they were created with the old schema
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='learning_logs' AND column_name='decision_date') THEN
    ALTER TABLE learning_logs ADD COLUMN decision_date TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='learning_logs' AND column_name='decision_data') THEN
    ALTER TABLE learning_logs ADD COLUMN decision_data JSONB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='learning_logs' AND column_name='actions_taken') THEN
    ALTER TABLE learning_logs ADD COLUMN actions_taken JSONB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='learning_logs' AND column_name='performance_before') THEN
    ALTER TABLE learning_logs ADD COLUMN performance_before JSONB;
  END IF;
END $$;

-- ── RLS Policies ────────────────────────────────────────────────────────────
ALTER TABLE revenue_attribution ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on revenue_attribution"
  ON revenue_attribution FOR ALL
  USING (true) WITH CHECK (true);

-- ── Indexes for performance ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_revenue_attribution_business ON revenue_attribution(business_id);
CREATE INDEX IF NOT EXISTS idx_revenue_attribution_source ON revenue_attribution(source);
CREATE INDEX IF NOT EXISTS idx_learning_logs_business ON learning_logs(business_id);
CREATE INDEX IF NOT EXISTS idx_generated_content_perf ON generated_content(performance_score);
CREATE INDEX IF NOT EXISTS idx_contacts_intent ON contacts(intent_level);


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 010_maximum_intelligence.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 010: Maximum Intelligence Layer — Levels 1-10
-- Run in Supabase SQL Editor AFTER 009_autonomous_agent.sql

-- ── New columns on businesses ───────────────────────────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS content_opportunities JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS audience_insights_full JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS competitive_moat JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS growth_engine_recommendation JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS crisis_status TEXT DEFAULT 'healthy';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS audience_insights JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS last_decision TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS last_decision_reason TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS performance_baseline JSONB;

-- ── New columns on generated_content (A/B testing + predictive scoring) ─────
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS ab_test_id UUID;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS variant TEXT DEFAULT 'A';
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS pre_post_score NUMERIC DEFAULT 0;

-- ── Campaign Orchestrations table ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaign_orchestrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  campaign_name TEXT,
  campaign_theme TEXT,
  campaign_plan JSONB,
  status TEXT DEFAULT 'active',
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── RLS + Indexes ───────────────────────────────────────────────────────────
ALTER TABLE campaign_orchestrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on campaign_orchestrations"
  ON campaign_orchestrations FOR ALL
  USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_campaign_orch_business ON campaign_orchestrations(business_id);
CREATE INDEX IF NOT EXISTS idx_campaign_orch_status ON campaign_orchestrations(status);
CREATE INDEX IF NOT EXISTS idx_generated_content_variant ON generated_content(variant);
CREATE INDEX IF NOT EXISTS idx_generated_content_ab_test ON generated_content(ab_test_id);
CREATE INDEX IF NOT EXISTS idx_businesses_crisis ON businesses(crisis_status);


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 011_final_platform.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 011: Final Complete Platform
-- WhatsApp + Email Approvals + Referrals + Competitor Ads + Webhooks

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS whatsapp_number TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS whatsapp_enabled BOOLEAN DEFAULT false;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gmb_access_token TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gmb_location_id TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS revenue_forecast JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS image_model TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS image_score NUMERIC DEFAULT 0;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS gmb_post_id TEXT;

CREATE TABLE IF NOT EXISTS content_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id UUID,
  business_id UUID,
  token TEXT UNIQUE NOT NULL,
  action TEXT,
  used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '48 hours',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_business_id UUID,
  referee_email TEXT,
  referee_business_id UUID,
  status TEXT DEFAULT 'pending',
  reward_given BOOLEAN DEFAULT false,
  referral_code TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS competitor_ads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID,
  competitor_name TEXT,
  ad_id TEXT,
  ad_body TEXT,
  ad_headline TEXT,
  impressions_range TEXT,
  first_seen TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID,
  event_type TEXT,
  webhook_url TEXT,
  secret TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS
ALTER TABLE content_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_full_content_approvals" ON content_approvals FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_full_referrals" ON referrals FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_full_competitor_ads" ON competitor_ads FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_full_webhook_subs" ON webhook_subscriptions FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_content_approvals_token ON content_approvals(token);
CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(referral_code);
CREATE INDEX IF NOT EXISTS idx_competitor_ads_biz ON competitor_ads(business_id);
CREATE INDEX IF NOT EXISTS idx_webhook_subs_biz ON webhook_subscriptions(business_id, event_type);


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 012_business_profiles.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 012: Business Profiles — rich structured profile for AI prompt accuracy
-- This table stores detailed business context used by the master prompt builder.
-- It does NOT replace the existing businesses table — it EXTENDS the data model.

CREATE TABLE IF NOT EXISTS business_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  business_name TEXT NOT NULL,
  business_type TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Add all profile columns (idempotent — safe to re-run)
ALTER TABLE business_profiles
ADD COLUMN IF NOT EXISTS business_age TEXT CHECK (business_age IN ('new', 'growing', 'established')),
ADD COLUMN IF NOT EXISTS usp TEXT,
ADD COLUMN IF NOT EXISTS tagline TEXT,
ADD COLUMN IF NOT EXISTS physical_locations JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS operation_model TEXT CHECK (operation_model IN ('location_based', 'mobile', 'hybrid', 'online')),
ADD COLUMN IF NOT EXISTS service_area JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS ad_targeting_area JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS primary_language TEXT DEFAULT 'Albanian',
ADD COLUMN IF NOT EXISTS secondary_languages JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS audience_age_min INTEGER DEFAULT 18,
ADD COLUMN IF NOT EXISTS audience_age_max INTEGER DEFAULT 65,
ADD COLUMN IF NOT EXISTS audience_gender TEXT CHECK (audience_gender IN ('male', 'female', 'mixed')) DEFAULT 'mixed',
ADD COLUMN IF NOT EXISTS audience_description TEXT,
ADD COLUMN IF NOT EXISTS pain_point TEXT,
ADD COLUMN IF NOT EXISTS avg_spend TEXT,
ADD COLUMN IF NOT EXISTS products JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS current_offer TEXT,
ADD COLUMN IF NOT EXISTS primary_goal TEXT,
ADD COLUMN IF NOT EXISTS monthly_budget TEXT,
ADD COLUMN IF NOT EXISTS ads_experience TEXT CHECK (ads_experience IN ('never', 'failed', 'success', 'active')),
ADD COLUMN IF NOT EXISTS tone_keywords JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS never_do TEXT,
ADD COLUMN IF NOT EXISTS business_hours JSONB DEFAULT '{}',
ADD COLUMN IF NOT EXISTS seasonal TEXT CHECK (seasonal IN ('year_round', 'busy_season', 'slow_season')) DEFAULT 'year_round',
ADD COLUMN IF NOT EXISTS busy_months JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS best_posting_times TEXT DEFAULT 'auto',
ADD COLUMN IF NOT EXISTS competitors JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS they_do_better TEXT,
ADD COLUMN IF NOT EXISTS we_do_better TEXT,
ADD COLUMN IF NOT EXISTS profile_score INTEGER DEFAULT 0;

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_business_profiles_user_id ON business_profiles(user_id);

-- Enable RLS
ALTER TABLE business_profiles ENABLE ROW LEVEL SECURITY;

-- Policies
DO $$ BEGIN
  CREATE POLICY "Users can read own profile" ON business_profiles FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can insert own profile" ON business_profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can update own profile" ON business_profiles FOR UPDATE USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Service role bypass for API server
DO $$ BEGIN
  CREATE POLICY "Service role full access" ON business_profiles FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 013_onboarding_profiles.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 013: Onboarding Profile System — Full business profile for AI prompts
-- Run in Supabase SQL Editor

-- Create business_profiles table if not exists
CREATE TABLE IF NOT EXISTS business_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE,
  business_name TEXT,
  business_type TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add all onboarding columns
ALTER TABLE business_profiles
ADD COLUMN IF NOT EXISTS business_age TEXT CHECK (business_age IN ('new', 'growing', 'established')),
ADD COLUMN IF NOT EXISTS usp TEXT,
ADD COLUMN IF NOT EXISTS tagline TEXT,
ADD COLUMN IF NOT EXISTS physical_locations JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS operation_model TEXT CHECK (operation_model IN ('location_based', 'mobile', 'hybrid', 'online')),
ADD COLUMN IF NOT EXISTS service_area JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS ad_targeting_area JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS primary_language TEXT DEFAULT 'Albanian',
ADD COLUMN IF NOT EXISTS secondary_languages JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS audience_age_min INTEGER DEFAULT 18,
ADD COLUMN IF NOT EXISTS audience_age_max INTEGER DEFAULT 65,
ADD COLUMN IF NOT EXISTS audience_gender TEXT CHECK (audience_gender IN ('male', 'female', 'mixed')) DEFAULT 'mixed',
ADD COLUMN IF NOT EXISTS audience_description TEXT,
ADD COLUMN IF NOT EXISTS pain_point TEXT,
ADD COLUMN IF NOT EXISTS avg_spend TEXT,
ADD COLUMN IF NOT EXISTS products JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS current_offer TEXT,
ADD COLUMN IF NOT EXISTS primary_goal TEXT,
ADD COLUMN IF NOT EXISTS monthly_budget TEXT,
ADD COLUMN IF NOT EXISTS ads_experience TEXT CHECK (ads_experience IN ('never', 'failed', 'success', 'active')),
ADD COLUMN IF NOT EXISTS tone_keywords JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS never_do TEXT,
ADD COLUMN IF NOT EXISTS business_hours JSONB DEFAULT '{}',
ADD COLUMN IF NOT EXISTS seasonal TEXT CHECK (seasonal IN ('year_round', 'busy_season', 'slow_season')) DEFAULT 'year_round',
ADD COLUMN IF NOT EXISTS busy_months JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS best_posting_times TEXT DEFAULT 'auto',
ADD COLUMN IF NOT EXISTS competitors JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS they_do_better TEXT,
ADD COLUMN IF NOT EXISTS we_do_better TEXT,
ADD COLUMN IF NOT EXISTS profile_score INTEGER DEFAULT 0;

-- RLS
ALTER TABLE business_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_full_business_profiles" ON business_profiles;
CREATE POLICY "service_full_business_profiles" ON business_profiles FOR ALL USING (true) WITH CHECK (true);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_business_profiles_user ON business_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_business_profiles_score ON business_profiles(profile_score);


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 014_skill_modules.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 014: 19 Skill Module Tables
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS referral_programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  referral_code TEXT UNIQUE,
  reward_type TEXT DEFAULT 'discount',
  reward_value TEXT DEFAULT '20%',
  total_referrals INTEGER DEFAULT 0,
  total_conversions INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_magnets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  title TEXT NOT NULL,
  type TEXT,
  content TEXT,
  download_url TEXT,
  capture_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS launch_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  product_name TEXT,
  launch_date TIMESTAMPTZ,
  phase TEXT DEFAULT 'pre_launch',
  status TEXT DEFAULT 'active',
  content_plan JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  source TEXT,
  insight_type TEXT,
  content TEXT,
  sentiment TEXT,
  actionable_suggestion TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketing_ideas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  idea TEXT NOT NULL,
  category TEXT,
  priority TEXT DEFAULT 'medium',
  estimated_impact TEXT,
  status TEXT DEFAULT 'new',
  how_to_execute TEXT,
  budget_required TEXT,
  time_to_results TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_seo_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  content_type TEXT,
  target_query TEXT,
  optimized_content JSONB,
  platforms JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schema_markups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  schema_type TEXT,
  schema_json TEXT,
  page_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seo_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  page_type TEXT,
  keyword TEXT,
  location TEXT,
  content TEXT,
  meta_title TEXT,
  meta_description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pricing_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  current_price TEXT,
  recommended_price TEXT,
  reasoning TEXT,
  tier_structure JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS community_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  platform TEXT,
  content TEXT,
  post_type TEXT,
  scheduled_at TIMESTAMPTZ,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  asset_type TEXT,
  title TEXT,
  content TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  lead_id UUID,
  lead_email TEXT,
  fit_score INTEGER DEFAULT 0,
  engagement_score INTEGER DEFAULT 0,
  total_score INTEGER DEFAULT 0,
  stage TEXT DEFAULT 'lead',
  recommended_action TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS free_tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  tool_name TEXT,
  tool_type TEXT,
  tool_description TEXT,
  tool_content TEXT,
  lead_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orchestration_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  run_date TIMESTAMPTZ DEFAULT now(),
  tasks_planned JSONB,
  tasks_executed JSONB,
  report TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS on all tables
DO $$ DECLARE t TEXT;
BEGIN FOR t IN SELECT unnest(ARRAY[
  'referral_programs','lead_magnets','launch_campaigns',
  'customer_insights','marketing_ideas','ai_seo_content','schema_markups',
  'seo_pages','pricing_recommendations','community_posts','sales_assets',
  'lead_scores','free_tools','orchestration_logs'
]) LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  BEGIN
    EXECUTE format('CREATE POLICY "service_role_%s" ON %I FOR ALL USING (true) WITH CHECK (true)', t, t);
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END LOOP; END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 015_business_intelligence.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 015: Shared Business Intelligence Layer
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS business_intelligence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  source_module TEXT NOT NULL,
  insight_type TEXT NOT NULL,
  insight_key TEXT NOT NULL,
  insight_value TEXT NOT NULL,
  confidence TEXT DEFAULT 'medium',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bi_user ON business_intelligence(user_id);
CREATE INDEX IF NOT EXISTS idx_bi_module ON business_intelligence(source_module);
ALTER TABLE business_intelligence ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_bi" ON business_intelligence FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 016_ai_memory.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 016: AI Memory System — learns from every interaction
CREATE TABLE IF NOT EXISTS ai_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  memory_type TEXT NOT NULL,
  content_snippet TEXT,
  platform TEXT,
  action TEXT,
  metrics JSONB DEFAULT '{}',
  learned_pattern TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_user ON ai_memory(user_id);
CREATE INDEX IF NOT EXISTS idx_memory_type ON ai_memory(memory_type);
ALTER TABLE ai_memory ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_memory" ON ai_memory FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 017_international_health.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 017: International + Health Score + Memory improvements
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'XK';
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'Europe/Belgrade';

CREATE TABLE IF NOT EXISTS business_health_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  total_score INTEGER DEFAULT 0,
  profile_score INTEGER DEFAULT 0,
  posting_score INTEGER DEFAULT 0,
  variety_score INTEGER DEFAULT 0,
  engagement_score INTEGER DEFAULT 0,
  competitive_score INTEGER DEFAULT 0,
  recommendations JSONB DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE business_health_scores ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "srole_health" ON business_health_scores FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 018_finalize_sequence.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 018: Sequence finalizer (no-op)
-- This migration intentionally performs no schema change.
-- It exists to keep migration numbering strictly sequential 001..018.
SELECT 1;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 019_waitlist.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 019: Waitlist
CREATE TABLE IF NOT EXISTS waitlist (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  plan TEXT,
  business_type TEXT,
  country TEXT,
  registered_at TIMESTAMPTZ DEFAULT NOW(),
  notified BOOLEAN DEFAULT FALSE
);
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_waitlist" ON waitlist FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 020_missing_tables.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 020: Missing tables for frontend + generated_content columns

CREATE TABLE IF NOT EXISTS ai_weekly_reports (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID,
  report_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS win_notifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID,
  win_type TEXT,
  message TEXT,
  notified_at TIMESTAMPTZ DEFAULT NOW()
);

-- analytics_snapshots likely exists already but ensure it does
CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID,
  snapshot_date DATE,
  platform TEXT,
  impressions INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  engagement INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  followers_gained INTEGER DEFAULT 0,
  posts_published INTEGER DEFAULT 0,
  email_sent INTEGER DEFAULT 0,
  email_opens INTEGER DEFAULT 0,
  email_clicks INTEGER DEFAULT 0,
  total_reach INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure generated_content has all frontend-expected columns
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS platform TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS caption TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS quality_score NUMERIC DEFAULT 0;

-- RLS
DO $$ DECLARE t TEXT;
BEGIN FOR t IN SELECT unnest(ARRAY['ai_weekly_reports','win_notifications']) LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  BEGIN EXECUTE format('CREATE POLICY "srole_%s" ON %I FOR ALL USING (true) WITH CHECK (true)', t, t);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END LOOP; END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 021_quality_and_idempotency.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Strategy one-liner for dashboard; idempotency task name on orchestration logs
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS strategy_reason TEXT;
ALTER TABLE orchestration_logs ADD COLUMN IF NOT EXISTS task TEXT;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 022_content_library.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- content_library: Higgsfield / product catalog generated assets
CREATE TABLE IF NOT EXISTS content_library (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  business_id UUID,
  product_id UUID,
  content_type TEXT NOT NULL,
  file_url TEXT NOT NULL,
  caption TEXT,
  hashtags TEXT,
  platform TEXT,
  content_score NUMERIC(3,1),
  score_breakdown JSONB,
  status TEXT DEFAULT 'scheduled',
  scheduled_at TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_library_user_id ON content_library(user_id);
CREATE INDEX IF NOT EXISTS idx_content_library_status ON content_library(status);
CREATE INDEX IF NOT EXISTS idx_content_library_scheduled_at ON content_library(scheduled_at);

ALTER TABLE content_library ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users can manage own content" ON content_library;
CREATE POLICY "users can manage own content"
  ON content_library FOR ALL
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "service role full access" ON content_library;
CREATE POLICY "service role full access"
  ON content_library FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 023_content_images_bucket.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Public bucket for Higgsfield-generated images mirrored to permanent Supabase URLs.
-- Alternatively create in Dashboard: Storage → New bucket → name content-images → Public: true.
INSERT INTO storage.buckets (id, name, public)
VALUES ('content-images', 'content-images', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 024_wf1_content_engine.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 024: Workflow #1 — Daily Content Engine
-- Adds the strategic concept→asset→post pipeline, unified events/approvals
-- infrastructure, and the learning loop tables.
--
-- Frontend contract: ../maroa-ai-marketing-automator/src/lib/api.ts lines 259–340
-- Spec: services/prompts/workflow_1_daily_content.js (auto-generated from
-- frontend ../maroa-ai-marketing-automator/src/lib/prompts/workflow_1_daily_content.ts)
--
-- Apply in Supabase SQL editor. Idempotent — safe to re-run.
-- ============================================================================

-- ─── Unified activity events (reused across all 15 workflows) ───────────────
CREATE TABLE IF NOT EXISTS events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  kind        TEXT NOT NULL,              -- e.g. 'wf1.plan.created', 'wf1.concept.approved'
  workflow    TEXT,                        -- '1_daily_content', '13_weekly_brief', etc.
  payload     JSONB NOT NULL DEFAULT '{}', -- workflow-specific metadata
  severity    TEXT DEFAULT 'info',         -- info | warn | error | success
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_biz_time ON events (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events (kind);
CREATE INDEX IF NOT EXISTS idx_events_workflow ON events (workflow);
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "events_service_full" ON events;
CREATE POLICY "events_service_full" ON events FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "events_owner_read" ON events;
CREATE POLICY "events_owner_read" ON events FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = events.business_id AND b.user_id = auth.uid())
);

-- ─── Unified approval queue (all workflows write here) ─────────────────────
CREATE TABLE IF NOT EXISTS approvals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  workflow     TEXT NOT NULL,              -- '1_daily_content' etc.
  entity_type  TEXT NOT NULL,              -- 'concept' | 'asset' | 'ad' | 'review_reply'
  entity_id    UUID NOT NULL,
  preview      JSONB NOT NULL,             -- { title, body, media_url, rationale }
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | edited | expired
  priority     INT DEFAULT 50,             -- 1 (lowest) — 100 (highest)
  sla_at       TIMESTAMPTZ,                -- auto-escalate/fallback deadline
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at   TIMESTAMPTZ,
  decided_by   UUID,
  decision_reason TEXT,
  edited_payload JSONB
);
CREATE INDEX IF NOT EXISTS idx_approvals_biz_status ON approvals (business_id, status, sla_at);
CREATE INDEX IF NOT EXISTS idx_approvals_entity ON approvals (entity_type, entity_id);
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "approvals_service_full" ON approvals;
CREATE POLICY "approvals_service_full" ON approvals FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "approvals_owner_rw" ON approvals;
CREATE POLICY "approvals_owner_rw" ON approvals FOR ALL USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = approvals.business_id AND b.user_id = auth.uid())
);

-- ─── AI Brain decision log (reserved for WF15) ─────────────────────────────
CREATE TABLE IF NOT EXISTS brain_decisions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  trigger     TEXT NOT NULL,                -- 'cron' | 'user' | 'event'
  input       JSONB NOT NULL,
  reasoning   TEXT NOT NULL,                -- chain-of-thought narrative (shown in UI)
  actions     JSONB NOT NULL DEFAULT '[]',  -- [{ workflow, action, params }]
  outcome     JSONB,
  cost_usd    NUMERIC(10,4),
  model_used  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brain_decisions_biz_time ON brain_decisions (business_id, created_at DESC);
ALTER TABLE brain_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brain_decisions_service_full" ON brain_decisions;
CREATE POLICY "brain_decisions_service_full" ON brain_decisions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── WF1 — content_plans (one per business per date) ──────────────────────
CREATE TABLE IF NOT EXISTS content_plans (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL,
  plan_date         DATE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft', -- draft | queued | awaiting_approval | published | skipped
  analysis          JSONB NOT NULL,           -- brandMaturity, narrativeArc, culturalOpportunity, funnelStages, underservedPillars, targetEmotions, reasoning
  context_snapshot  JSONB,                    -- the full DailyContextBundle used for reproducibility
  autonomy_mode     TEXT,                     -- snapshot of the mode at creation time
  model_used        TEXT,                     -- 'claude-opus-4-5'
  cost_usd          NUMERIC(10,4),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, plan_date)
);
CREATE INDEX IF NOT EXISTS idx_content_plans_biz_date ON content_plans (business_id, plan_date DESC);
ALTER TABLE content_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "content_plans_service_full" ON content_plans;
CREATE POLICY "content_plans_service_full" ON content_plans FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "content_plans_owner_rw" ON content_plans;
CREATE POLICY "content_plans_owner_rw" ON content_plans FOR ALL USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = content_plans.business_id AND b.user_id = auth.uid())
);

-- ─── WF1 — content_concepts (1–3 per plan, strategic decisions) ───────────
CREATE TABLE IF NOT EXISTS content_concepts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              UUID NOT NULL,
  plan_id                  UUID NOT NULL REFERENCES content_plans(id) ON DELETE CASCADE,
  platform                 TEXT NOT NULL,   -- instagram_reel | tiktok | linkedin | …
  format                   TEXT NOT NULL,   -- e.g. '9:16 Reel 7-15s'
  pillar                   TEXT,
  funnel_stage             TEXT,            -- tofu | mofu | bofu | retention
  emotion                  TEXT,
  core_idea                TEXT NOT NULL,
  hook                     TEXT NOT NULL,
  hook_pattern             TEXT,            -- pattern_interrupt | curiosity_gap | value_promise | contrarian | storytelling
  story_arc                TEXT,
  cta                      TEXT,
  framework                TEXT,            -- psychology lever naming
  why_this_why_now         TEXT,
  predicted_engagement_low NUMERIC(5,4),
  predicted_engagement_high NUMERIC(5,4),
  risk_level               TEXT DEFAULT 'low', -- low | medium | high
  cost_estimate_usd        NUMERIC(6,4),
  status                   TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | published | skipped
  rejection_reason         TEXT,
  quality_score            NUMERIC(5,2),    -- populated after asset generation
  quality_breakdown        JSONB,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at               TIMESTAMPTZ,
  decided_by               UUID
);
CREATE INDEX IF NOT EXISTS idx_concepts_plan ON content_concepts (plan_id);
CREATE INDEX IF NOT EXISTS idx_concepts_biz_status ON content_concepts (business_id, status, created_at DESC);
ALTER TABLE content_concepts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "concepts_service_full" ON content_concepts;
CREATE POLICY "concepts_service_full" ON content_concepts FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "concepts_owner_rw" ON content_concepts;
CREATE POLICY "concepts_owner_rw" ON content_concepts FOR ALL USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = content_concepts.business_id AND b.user_id = auth.uid())
);

-- ─── WF1 — content_assets (generated platform-native output per concept) ──
CREATE TABLE IF NOT EXISTS content_assets (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              UUID NOT NULL,
  concept_id               UUID NOT NULL REFERENCES content_concepts(id) ON DELETE CASCADE,
  platform                 TEXT NOT NULL,
  caption                  TEXT NOT NULL,
  hook                     TEXT,
  hook_pattern             TEXT,
  hashtags                 TEXT[] DEFAULT ARRAY[]::TEXT[],
  cta                      TEXT,
  visual_brief             JSONB,
  accessibility_alt_text   TEXT,
  burned_in_captions       TEXT,
  posting_time_local       TEXT,            -- HH:MM
  posting_time_rationale   TEXT,
  framework_justification  TEXT,
  predicted_quality_score  NUMERIC(5,2),
  confidence               NUMERIC(5,4),
  quality_score            NUMERIC(5,2),    -- scored by gate (Haiku)
  quality_breakdown        JSONB,
  media_url                TEXT,            -- populated after image/video gen
  thumbnail_url            TEXT,
  model_used               TEXT,
  cost_usd                 NUMERIC(10,4),
  status                   TEXT NOT NULL DEFAULT 'generated', -- generated | awaiting_approval | approved | rejected | published | failed
  generated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at             TIMESTAMPTZ,
  platform_post_id         TEXT,            -- the external ID after publish
  platform_post_url        TEXT
);
CREATE INDEX IF NOT EXISTS idx_assets_concept ON content_assets (concept_id);
CREATE INDEX IF NOT EXISTS idx_assets_biz_status ON content_assets (business_id, status, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_published ON content_assets (business_id, published_at) WHERE published_at IS NOT NULL;
ALTER TABLE content_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "assets_service_full" ON content_assets;
CREATE POLICY "assets_service_full" ON content_assets FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "assets_owner_rw" ON content_assets;
CREATE POLICY "assets_owner_rw" ON content_assets FOR ALL USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = content_assets.business_id AND b.user_id = auth.uid())
);

-- ─── WF1 — content_posts (joins asset to platform post + state) ───────────
CREATE TABLE IF NOT EXISTS content_posts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        UUID NOT NULL,
  asset_id           UUID NOT NULL REFERENCES content_assets(id) ON DELETE CASCADE,
  platform           TEXT NOT NULL,
  platform_post_id   TEXT,
  platform_post_url  TEXT,
  posted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  performance_check_at TIMESTAMPTZ,         -- when to next measure engagement
  performance_measured_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_posts_biz_time ON content_posts (business_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_measure_due ON content_posts (performance_check_at) WHERE performance_measured_at IS NULL;
ALTER TABLE content_posts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "posts_service_full" ON content_posts;
CREATE POLICY "posts_service_full" ON content_posts FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "posts_owner_r" ON content_posts;
CREATE POLICY "posts_owner_r" ON content_posts FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = content_posts.business_id AND b.user_id = auth.uid())
);

-- ─── WF1 — content_performance (48h engagement snapshot per post) ─────────
CREATE TABLE IF NOT EXISTS content_performance (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        UUID NOT NULL,
  post_id            UUID NOT NULL REFERENCES content_posts(id) ON DELETE CASCADE,
  asset_id           UUID NOT NULL,
  platform           TEXT NOT NULL,
  measured_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  hours_since_post   NUMERIC(6,2) NOT NULL,
  impressions        BIGINT DEFAULT 0,
  reach              BIGINT DEFAULT 0,
  engagement_count   BIGINT DEFAULT 0,      -- likes + comments + saves + shares
  engagement_rate    NUMERIC(8,6),          -- engagement_count / reach
  vs_account_baseline NUMERIC(6,3),         -- multiplier (1.0 = baseline, 1.5 = 50% over)
  vs_industry_benchmark NUMERIC(6,3),
  classification     TEXT,                   -- 'winner' | 'on_target' | 'under' | 'failed'
  raw                JSONB                   -- full platform payload
);
CREATE INDEX IF NOT EXISTS idx_perf_biz_time ON content_performance (business_id, measured_at DESC);
ALTER TABLE content_performance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "perf_service_full" ON content_performance;
CREATE POLICY "perf_service_full" ON content_performance FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── WF1 — learning_patterns (winners, anti-patterns, hashtag bank) ───────
CREATE TABLE IF NOT EXISTS learning_patterns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL,
  pattern_type    TEXT NOT NULL,     -- 'winning' | 'anti' | 'hashtag_bank' | 'prediction_accuracy'
  platform        TEXT,              -- null = cross-platform
  trait           TEXT NOT NULL,     -- hook_pattern, format, emotion, time_of_day, hashtag, pillar, etc.
  lift            NUMERIC(6,3),      -- for winning/anti: engagement multiplier vs baseline
  drag            NUMERIC(6,3),      -- for anti: negative multiplier
  sample_size     INT DEFAULT 1,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, pattern_type, platform, trait)
);
CREATE INDEX IF NOT EXISTS idx_patterns_biz_type ON learning_patterns (business_id, pattern_type);
ALTER TABLE learning_patterns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "patterns_service_full" ON learning_patterns;
CREATE POLICY "patterns_service_full" ON learning_patterns FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── Autonomy mode + hybrid window on businesses ──────────────────────────
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS wf1_autonomy_mode TEXT DEFAULT 'hybrid',
  ADD COLUMN IF NOT EXISTS wf1_hybrid_window_hours INT DEFAULT 4;

COMMENT ON COLUMN businesses.wf1_autonomy_mode IS 'WF1 autonomy: full_autopilot | hybrid | approve_everything';
COMMENT ON COLUMN businesses.wf1_hybrid_window_hours IS 'Hybrid mode: hours to wait for human approval before fallback auto-publish';

-- ─── Helper: schedule next performance measurement 48h after publish ──────
CREATE OR REPLACE FUNCTION schedule_performance_check() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.posted_at IS NOT NULL AND OLD.posted_at IS DISTINCT FROM NEW.posted_at THEN
    NEW.performance_check_at = NEW.posted_at + INTERVAL '48 hours';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_content_posts_schedule_perf ON content_posts;
CREATE TRIGGER trg_content_posts_schedule_perf
  BEFORE INSERT OR UPDATE ON content_posts
  FOR EACH ROW EXECUTE FUNCTION schedule_performance_check();


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 025_wf13_weekly_brief.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 025: Workflow #13 — Weekly Strategy Brief
-- Schema for the agency-grade weekly briefing pipeline: aggregation,
-- synthesis, polish, delivery, decision log.
--
-- Frontend contract: src/lib/api.ts lines 342–488
-- Spec module: services/prompts/workflow_13_weekly_brief.js
-- ============================================================================

-- weekly_briefs: one row per (business, week)
CREATE TABLE IF NOT EXISTS weekly_briefs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL,
  week_start    DATE NOT NULL,   -- Monday of the week
  week_end      DATE NOT NULL,   -- Sunday of the week
  status        TEXT NOT NULL DEFAULT 'queued',
    -- queued | aggregating | synthesizing | polishing | awaiting_review
    -- | approved | delivered | rejected | failed
  context_bundle JSONB,           -- Phase 1 WeeklyContextBundle snapshot
  synthesis     JSONB,             -- Phase 2 StrategySynthesis (Opus output)
  deliverable   JSONB,             -- Phase 3 BriefDeliverable (Sonnet output)
  subject_line  TEXT,
  headline      TEXT,
  word_count    INT,
  model_used_synthesis TEXT,
  model_used_polish    TEXT,
  cost_usd      NUMERIC(10,4),
  generated_at  TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  reviewed_by   UUID,
  review_notes  TEXT,
  error_message TEXT,
  autonomy_mode_snapshot TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, week_start)
);
CREATE INDEX IF NOT EXISTS idx_weekly_briefs_biz_week ON weekly_briefs (business_id, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_weekly_briefs_status ON weekly_briefs (status);
ALTER TABLE weekly_briefs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "weekly_briefs_service_full" ON weekly_briefs;
CREATE POLICY "weekly_briefs_service_full" ON weekly_briefs FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "weekly_briefs_owner_rw" ON weekly_briefs;
CREATE POLICY "weekly_briefs_owner_rw" ON weekly_briefs FOR ALL USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = weekly_briefs.business_id AND b.user_id = auth.uid())
);

-- brief_plan_actions: the recommended next-week plan items, individually actionable
CREATE TABLE IF NOT EXISTS brief_plan_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_id        UUID NOT NULL REFERENCES weekly_briefs(id) ON DELETE CASCADE,
  business_id     UUID NOT NULL,
  action          TEXT NOT NULL,
  why_now         TEXT,
  expected_impact_low  NUMERIC(14,4),
  expected_impact_high NUMERIC(14,4),
  impact_metric   TEXT,
  effort_hours    NUMERIC(6,2),
  owner           TEXT DEFAULT 'ai',
  deadline        DATE,
  one_click_approve BOOLEAN DEFAULT true,
  status          TEXT DEFAULT 'pending',
  decided_at      TIMESTAMPTZ,
  decided_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brief_plan_actions_brief ON brief_plan_actions (brief_id);
CREATE INDEX IF NOT EXISTS idx_brief_plan_actions_biz_status ON brief_plan_actions (business_id, status);
ALTER TABLE brief_plan_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brief_actions_service_full" ON brief_plan_actions;
CREATE POLICY "brief_actions_service_full" ON brief_plan_actions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- brief_delivery_log: each channel delivery attempt
CREATE TABLE IF NOT EXISTS brief_delivery_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_id     UUID NOT NULL REFERENCES weekly_briefs(id) ON DELETE CASCADE,
  business_id  UUID NOT NULL,
  channel      TEXT NOT NULL,   -- email | slack | whatsapp | dashboard_only | pdf
  recipient    TEXT,             -- email address, slack user id, etc.
  status       TEXT NOT NULL,   -- sent | failed | opened | clicked | bounced
  external_id  TEXT,
  error        TEXT,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brief_delivery_brief ON brief_delivery_log (brief_id);
ALTER TABLE brief_delivery_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brief_delivery_service_full" ON brief_delivery_log;
CREATE POLICY "brief_delivery_service_full" ON brief_delivery_log FOR ALL TO service_role USING (true) WITH CHECK (true);

-- brief_delivery_settings: one row per business — how they want briefs delivered
CREATE TABLE IF NOT EXISTS brief_delivery_settings (
  business_id        UUID PRIMARY KEY,
  autonomy_mode      TEXT NOT NULL DEFAULT 'review_first', -- auto_send | review_first | manual
  channels           JSONB NOT NULL DEFAULT '["email","dashboard_only"]',
  recipients         JSONB NOT NULL DEFAULT '[]',
  delivery_day       TEXT NOT NULL DEFAULT 'monday',
  delivery_local_time TEXT NOT NULL DEFAULT '07:00',
  preferred_length   TEXT DEFAULT 'standard',
  tone_preference    TEXT DEFAULT 'direct',
  technical_depth    TEXT DEFAULT 'intermediate',
  language           TEXT DEFAULT 'English',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE brief_delivery_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brief_settings_service_full" ON brief_delivery_settings;
CREATE POLICY "brief_settings_service_full" ON brief_delivery_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "brief_settings_owner_rw" ON brief_delivery_settings;
CREATE POLICY "brief_settings_owner_rw" ON brief_delivery_settings FOR ALL USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = brief_delivery_settings.business_id AND b.user_id = auth.uid())
);

-- reader_preferences_learned: aggregated over time from feedback
CREATE TABLE IF NOT EXISTS reader_preferences_learned (
  business_id              UUID PRIMARY KEY,
  sections_skipped         JSONB DEFAULT '[]',
  sections_drilled_into    JSONB DEFAULT '[]',
  recommendations_rejected JSONB DEFAULT '[]',
  recommendations_approved JSONB DEFAULT '[]',
  metric_priorities        JSONB DEFAULT '[]',
  sample_size              INT DEFAULT 0,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE reader_preferences_learned ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "reader_prefs_service_full" ON reader_preferences_learned;
CREATE POLICY "reader_prefs_service_full" ON reader_preferences_learned FOR ALL TO service_role USING (true) WITH CHECK (true);


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 026_wf15_ai_brain.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 026: Workflow #15 — AI Brain (Conversational Command Center)
-- ============================================================================

-- brain_conversations: one per conversation thread
CREATE TABLE IF NOT EXISTS brain_conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL,
  title         TEXT,
  message_count INT DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brain_conv_biz ON brain_conversations (business_id, last_message_at DESC);
ALTER TABLE brain_conversations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brain_conv_service_full" ON brain_conversations;
CREATE POLICY "brain_conv_service_full" ON brain_conversations FOR ALL TO service_role USING (true) WITH CHECK (true);

-- brain_messages: every turn
CREATE TABLE IF NOT EXISTS brain_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES brain_conversations(id) ON DELETE CASCADE,
  business_id     UUID NOT NULL,
  role            TEXT NOT NULL,          -- user | assistant | system | tool
  content         TEXT NOT NULL,
  attachments     JSONB DEFAULT '[]',
  tool_calls      JSONB DEFAULT '[]',
  reasoning       TEXT,
  model_used      TEXT,                    -- haiku | sonnet | opus
  cost_usd        NUMERIC(10,4),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brain_msg_conv ON brain_messages (conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_brain_msg_biz ON brain_messages (business_id, created_at DESC);
ALTER TABLE brain_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brain_msg_service_full" ON brain_messages;
CREATE POLICY "brain_msg_service_full" ON brain_messages FOR ALL TO service_role USING (true) WITH CHECK (true);

-- brain_tool_calls: individual tool invocations (detailed state tracking)
CREATE TABLE IF NOT EXISTS brain_tool_calls (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      UUID REFERENCES brain_messages(id) ON DELETE CASCADE,
  business_id     UUID NOT NULL,
  tool            TEXT NOT NULL,
  input_summary   TEXT,
  input           JSONB,
  status          TEXT NOT NULL DEFAULT 'pending',
  progress        JSONB,
  result          JSONB,
  error           TEXT,
  rationale       TEXT,
  alternatives_considered JSONB,
  requires_approval BOOLEAN DEFAULT false,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_brain_tool_biz_status ON brain_tool_calls (business_id, status);
CREATE INDEX IF NOT EXISTS idx_brain_tool_message ON brain_tool_calls (message_id);
ALTER TABLE brain_tool_calls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brain_tool_service_full" ON brain_tool_calls;
CREATE POLICY "brain_tool_service_full" ON brain_tool_calls FOR ALL TO service_role USING (true) WITH CHECK (true);

-- brain_attachments: multimodal upload tracking
CREATE TABLE IF NOT EXISTS brain_attachments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  modality     TEXT NOT NULL,   -- voice | image | url | file
  url          TEXT NOT NULL,
  mime_type    TEXT,
  name         TEXT,
  transcription TEXT,
  ocr_text     TEXT,
  scraped_summary TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE brain_attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brain_attach_service_full" ON brain_attachments;
CREATE POLICY "brain_attach_service_full" ON brain_attachments FOR ALL TO service_role USING (true) WITH CHECK (true);

-- brain_memory: medium-term learned preferences per business
CREATE TABLE IF NOT EXISTS brain_memory (
  business_id   UUID PRIMARY KEY,
  owner_preferences JSONB DEFAULT '{}',
  recent_learnings JSONB DEFAULT '[]',
  long_term_summary TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE brain_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brain_memory_service_full" ON brain_memory;
CREATE POLICY "brain_memory_service_full" ON brain_memory FOR ALL TO service_role USING (true) WITH CHECK (true);


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 027_wf2_lead_scoring.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 027: Workflow #2 — Lead Scoring & Routing
-- ============================================================================

-- lead_scores: cached scoring output per contact
CREATE TABLE IF NOT EXISTS lead_scores (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL,
  lead_id           UUID NOT NULL,    -- contacts.id
  total             INT NOT NULL,
  tier              TEXT NOT NULL,
  components        JSONB NOT NULL,
  top_predictive_signals JSONB DEFAULT '[]',
  top_risk_signals  JSONB DEFAULT '[]',
  recommended_action TEXT,
  model_used        TEXT DEFAULT 'deterministic',
  scored_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, lead_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_scores_biz_tier ON lead_scores (business_id, tier, scored_at DESC);
ALTER TABLE lead_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lead_scores_service_full" ON lead_scores;
CREATE POLICY "lead_scores_service_full" ON lead_scores FOR ALL TO service_role USING (true) WITH CHECK (true);

-- lead_responses: generated response drafts
CREATE TABLE IF NOT EXISTS lead_responses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL,
  lead_id           UUID NOT NULL,
  subject           TEXT,
  body              TEXT,
  personalization_score NUMERIC(5,2),
  quality_checks    JSONB,
  predicted_response_rate_low NUMERIC(5,4),
  predicted_response_rate_high NUMERIC(5,4),
  psychology_levers JSONB,
  status            TEXT DEFAULT 'draft', -- draft | awaiting_approval | sent | rejected
  sent_at           TIMESTAMPTZ,
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_responses_biz ON lead_responses (business_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_responses_lead ON lead_responses (lead_id);
ALTER TABLE lead_responses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lead_resp_service_full" ON lead_responses;
CREATE POLICY "lead_resp_service_full" ON lead_responses FOR ALL TO service_role USING (true) WITH CHECK (true);

-- routing_rules: configured routing rules per business
CREATE TABLE IF NOT EXISTS routing_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL,
  kind            TEXT NOT NULL,      -- round_robin | territory | industry | deal_size | workload_balanced | account_based
  priority        INT NOT NULL DEFAULT 50,
  config          JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_routing_biz_priority ON routing_rules (business_id, priority DESC);
ALTER TABLE routing_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "routing_service_full" ON routing_rules;
CREATE POLICY "routing_service_full" ON routing_rules FOR ALL TO service_role USING (true) WITH CHECK (true);

-- icp_definitions: ICP per business
CREATE TABLE IF NOT EXISTS icp_definitions (
  business_id             UUID PRIMARY KEY,
  ideal_titles            JSONB DEFAULT '[]',
  ideal_company_size_min  INT,
  ideal_company_size_max  INT,
  ideal_industries        JSONB DEFAULT '[]',
  served_geographies      JSONB DEFAULT '[]',
  deadbeat_list           JSONB DEFAULT '[]',
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE icp_definitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "icp_service_full" ON icp_definitions;
CREATE POLICY "icp_service_full" ON icp_definitions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Extend contacts with scoring-relevant columns if not present
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lead_score INT,
  ADD COLUMN IF NOT EXISTS lead_tier TEXT,
  ADD COLUMN IF NOT EXISTS sla_deadline TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS owner_id UUID,
  ADD COLUMN IF NOT EXISTS enrichment JSONB,
  ADD COLUMN IF NOT EXISTS behavior JSONB,
  ADD COLUMN IF NOT EXISTS intake JSONB;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 028_wf4_reviews.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 028: Workflow #4 — Reviews & Reputation
-- ============================================================================

-- Unified reviews table (supersedes legacy reviews table with richer schema)
-- We reuse the existing `reviews` table if present and just add columns.
ALTER TABLE IF EXISTS reviews
  ADD COLUMN IF NOT EXISTS reviewer_profile_url TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS category TEXT,           -- positive | neutral | negative | critical
  ADD COLUMN IF NOT EXISTS urgency TEXT,            -- immediate | high | medium | low
  ADD COLUMN IF NOT EXISTS topics JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS authenticity_score NUMERIC(5,2) DEFAULT 100,
  ADD COLUMN IF NOT EXISTS is_suspicious BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS legal_flags JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS response_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS sla_deadline TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewer_account_age_days INT,
  ADD COLUMN IF NOT EXISTS reviewer_review_count INT,
  ADD COLUMN IF NOT EXISTS reviewer_location TEXT,
  ADD COLUMN IF NOT EXISTS transaction_verified BOOLEAN;

-- Create reviews table if it doesn't already exist (legacy repos may not have it)
CREATE TABLE IF NOT EXISTS reviews (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  platform     TEXT NOT NULL,
  reviewer_name TEXT,
  rating       NUMERIC(3,1),
  body         TEXT,
  sentiment    NUMERIC(4,3),
  posted_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reviews_biz_category ON reviews (business_id, category);
CREATE INDEX IF NOT EXISTS idx_reviews_biz_status ON reviews (business_id, response_status);
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "reviews_service_full" ON reviews;
CREATE POLICY "reviews_service_full" ON reviews FOR ALL TO service_role USING (true) WITH CHECK (true);

-- review_responses: AI-generated draft responses
CREATE TABLE IF NOT EXISTS review_responses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  review_id    UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  signature_name TEXT,
  signature_title TEXT,
  personalization_score NUMERIC(5,2),
  brand_voice_match_score NUMERIC(5,2),
  word_count   INT,
  psychology_levers JSONB DEFAULT '[]',
  predicted_impact TEXT,
  is_active    BOOLEAN DEFAULT true,
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_review_responses_review ON review_responses (review_id);
ALTER TABLE review_responses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "review_resp_service_full" ON review_responses;
CREATE POLICY "review_resp_service_full" ON review_responses FOR ALL TO service_role USING (true) WITH CHECK (true);

-- review_requests: outbound "please leave a review" asks
CREATE TABLE IF NOT EXISTS review_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  customer_id  UUID,
  customer_name TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  channel      TEXT,       -- email | sms | whatsapp
  platform     TEXT,       -- which review platform they should leave it on
  trigger_kind TEXT,
  product_or_service TEXT,
  staff_member TEXT,
  sent_at      TIMESTAMPTZ,
  status       TEXT DEFAULT 'queued',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE review_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "review_req_service_full" ON review_requests;
CREATE POLICY "review_req_service_full" ON review_requests FOR ALL TO service_role USING (true) WITH CHECK (true);

-- review_disputes: when a review is submitted for platform removal
CREATE TABLE IF NOT EXISTS review_disputes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  review_id    UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  reason       TEXT,
  justification TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  platform_response TEXT,
  outcome      TEXT         -- pending | accepted | rejected
);
ALTER TABLE review_disputes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "review_disp_service_full" ON review_disputes;
CREATE POLICY "review_disp_service_full" ON review_disputes FOR ALL TO service_role USING (true) WITH CHECK (true);

-- testimonial_library: high-signal quotes we can reuse in marketing
CREATE TABLE IF NOT EXISTS testimonial_library (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  review_id    UUID REFERENCES reviews(id) ON DELETE SET NULL,
  platform     TEXT,
  reviewer_name TEXT,
  rating       NUMERIC(3,1),
  quote        TEXT,
  permission_status TEXT DEFAULT 'not_requested', -- not_requested | requested | granted | declined
  used_in      JSONB DEFAULT '[]',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE testimonial_library ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "testimonials_service_full" ON testimonial_library;
CREATE POLICY "testimonials_service_full" ON testimonial_library FOR ALL TO service_role USING (true) WITH CHECK (true);


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 029_wf3_ad_optimization.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 029: Workflow #3 — Ad Optimization Loop
-- Extends existing ad_campaigns / ad_performance_logs with the weekly
-- optimization decision records.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ad_optimization_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL,
  week_start        DATE NOT NULL,
  week_end          DATE NOT NULL,
  snapshot          JSONB,             -- input snapshot (spend/roas/cpa per campaign)
  decision          JSONB,             -- Opus output (actions, budget_rebalance, etc.)
  blended_roas      NUMERIC(8,3),
  blended_cac       NUMERIC(10,2),
  total_spend_usd   NUMERIC(14,2),
  model_used        TEXT,
  cost_usd          NUMERIC(10,4),
  status            TEXT DEFAULT 'draft', -- draft | awaiting_approval | approved | applied | rejected
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at        TIMESTAMPTZ,
  UNIQUE (business_id, week_start)
);
CREATE INDEX IF NOT EXISTS idx_ad_opt_runs_biz ON ad_optimization_runs (business_id, week_start DESC);
ALTER TABLE ad_optimization_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ad_opt_runs_service_full" ON ad_optimization_runs;
CREATE POLICY "ad_opt_runs_service_full" ON ad_optimization_runs FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS ad_optimization_actions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            UUID NOT NULL REFERENCES ad_optimization_runs(id) ON DELETE CASCADE,
  business_id       UUID NOT NULL,
  action_kind       TEXT NOT NULL,        -- scale | pause | refresh | rebudget | partition | launch
  entity_platform   TEXT NOT NULL,        -- meta | google | linkedin | tiktok
  entity_id         TEXT,
  entity_name       TEXT,
  current_state     TEXT,
  recommendation    TEXT,
  why_now           TEXT,
  expected_impact_low  NUMERIC(14,2),
  expected_impact_high NUMERIC(14,2),
  impact_metric     TEXT,
  risk_level        TEXT DEFAULT 'low',
  requires_approval BOOLEAN DEFAULT true,
  status            TEXT DEFAULT 'pending', -- pending | approved | rejected | applied | failed
  applied_at        TIMESTAMPTZ,
  result            JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ad_opt_actions_run ON ad_optimization_actions (run_id);
CREATE INDEX IF NOT EXISTS idx_ad_opt_actions_biz_status ON ad_optimization_actions (business_id, status);
ALTER TABLE ad_optimization_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ad_opt_actions_service_full" ON ad_optimization_actions;
CREATE POLICY "ad_opt_actions_service_full" ON ad_optimization_actions FOR ALL TO service_role USING (true) WITH CHECK (true);


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 030_wf5_through_wf14.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 030: Workflows #5, #6, #7, #8, #9/11, #10, #12, #14 — core schemas
-- ============================================================================

-- ─── WF5 — Competitor Intelligence ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS competitor_briefs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  week_start   DATE NOT NULL,
  week_end     DATE NOT NULL,
  summary      TEXT,
  competitors  JSONB,           -- array of per-competitor analyses
  market_shifts JSONB,
  white_space  JSONB,
  actions      JSONB,
  frameworks_cited JSONB,
  model_used   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, week_start)
);
ALTER TABLE competitor_briefs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cb_service_full" ON competitor_briefs;
CREATE POLICY "cb_service_full" ON competitor_briefs FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── WF6 — Local + Digital Presence ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS presence_audits (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  overall_score INT,
  gbp          JSONB,
  schema_markup JSONB,
  citations    JSONB,
  local_rank   JSONB,
  remediation_plan JSONB,
  quick_wins   JSONB,
  audit_run_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_presence_audits_biz ON presence_audits (business_id, audit_run_at DESC);
ALTER TABLE presence_audits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pa_service_full" ON presence_audits;
CREATE POLICY "pa_service_full" ON presence_audits FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS schema_markup_generated (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  page_url     TEXT,
  schema_type  TEXT,
  json_ld      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE schema_markup_generated ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sm_service_full" ON schema_markup_generated;
CREATE POLICY "sm_service_full" ON schema_markup_generated FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── WF7 — Email Lifecycle ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_segments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  name         TEXT NOT NULL,
  definition   JSONB,           -- criteria for membership
  size_cached  INT,
  lifecycle_stage TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_sequences (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  segment_id   UUID REFERENCES email_segments(id) ON DELETE CASCADE,
  name         TEXT,
  status       TEXT DEFAULT 'draft',
  plan         JSONB,           -- array of emails from the prompt output
  emails_sent  INT DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_enrollments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  sequence_id  UUID REFERENCES email_sequences(id) ON DELETE CASCADE,
  contact_id   UUID,
  current_stage INT DEFAULT 1,
  enrolled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sent_at TIMESTAMPTZ,
  status       TEXT DEFAULT 'active'
);
ALTER TABLE email_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_enrollments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "es_service_full" ON email_segments;
CREATE POLICY "es_service_full" ON email_segments FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "eseq_service_full" ON email_sequences;
CREATE POLICY "eseq_service_full" ON email_sequences FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "eenroll_service_full" ON email_enrollments;
CREATE POLICY "eenroll_service_full" ON email_enrollments FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── WF8 — Customer Insights ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insight_reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  top_themes   JSONB,
  pain_points  JSONB,
  delight_moments JSONB,
  unmet_needs  JSONB,
  personas     JSONB,
  language_patterns JSONB,
  action_items JSONB,
  window_start DATE,
  window_end   DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE insight_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ir_service_full" ON insight_reports;
CREATE POLICY "ir_service_full" ON insight_reports FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── WF9/11 — Unified Inbox + Smart Routing ───────────────────────────────
CREATE TABLE IF NOT EXISTS inbox_threads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  channel      TEXT NOT NULL,     -- email | instagram_dm | whatsapp | facebook | tiktok | form
  external_id  TEXT,
  from_handle  TEXT,
  subject      TEXT,
  body         TEXT,
  attachments  JSONB,
  classification TEXT,             -- lead|support|complaint|spam|partnership|press|internal|review_mention
  sentiment    TEXT,
  urgency      TEXT,
  sla_deadline TIMESTAMPTZ,
  route_to     TEXT,
  status       TEXT DEFAULT 'new', -- new | routed | responded | resolved | escalated
  assigned_to  UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_inbox_biz_status ON inbox_threads (business_id, status, sla_deadline);
ALTER TABLE inbox_threads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "it_service_full" ON inbox_threads;
CREATE POLICY "it_service_full" ON inbox_threads FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS inbox_replies (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id    UUID NOT NULL REFERENCES inbox_threads(id) ON DELETE CASCADE,
  business_id  UUID NOT NULL,
  body         TEXT,
  subject      TEXT,
  tone         TEXT,
  requires_human_review BOOLEAN DEFAULT true,
  confidence   NUMERIC(4,3),
  status       TEXT DEFAULT 'draft', -- draft | approved | sent | rejected
  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE inbox_replies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ir2_service_full" ON inbox_replies;
CREATE POLICY "ir2_service_full" ON inbox_replies FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── WF10 — Higgsfield Studio ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS studio_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  request_kind TEXT NOT NULL,    -- image | video | carousel | reel
  brief        JSONB,             -- output of Opus brief builder
  provider     TEXT,              -- segmind | higgsfield | runway | fallback
  status       TEXT DEFAULT 'queued', -- queued | processing | completed | failed
  result_url   TEXT,
  thumbnail_url TEXT,
  cost_usd     NUMERIC(10,4),
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
ALTER TABLE studio_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sj_service_full" ON studio_jobs;
CREATE POLICY "sj_service_full" ON studio_jobs FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── WF12 — Launch Orchestrator ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS launches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  name         TEXT NOT NULL,
  launch_type  TEXT,              -- product | event | campaign | pivot
  launch_date  DATE,
  plan         JSONB,              -- full phase plan from Opus
  budget_allocation JSONB,
  status       TEXT DEFAULT 'planning', -- planning | pre_launch | launch_week | post_launch | momentum | completed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE launches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "launches_service_full" ON launches;
CREATE POLICY "launches_service_full" ON launches FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS launch_activities (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  launch_id    UUID NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
  business_id  UUID NOT NULL,
  phase        TEXT,
  activity     TEXT,
  channel      TEXT,
  owner        TEXT,
  effort_days  NUMERIC(5,2),
  status       TEXT DEFAULT 'pending',
  due_at       TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE launch_activities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "la_service_full" ON launch_activities;
CREATE POLICY "la_service_full" ON launch_activities FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── WF14 — Budget & ROI Optimizer ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS budget_optimizer_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  month_start  DATE NOT NULL,
  blended_roas NUMERIC(8,3),
  blended_cac  NUMERIC(10,2),
  ltv_cac_ratio NUMERIC(8,3),
  per_channel  JSONB,
  reallocation_moves JSONB,
  total_spend_change_usd NUMERIC(14,2),
  projected_blended_roas NUMERIC(8,3),
  confidence   TEXT,
  model_used   TEXT,
  status       TEXT DEFAULT 'draft',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, month_start)
);
ALTER TABLE budget_optimizer_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bor_service_full" ON budget_optimizer_runs;
CREATE POLICY "bor_service_full" ON budget_optimizer_runs FOR ALL TO service_role USING (true) WITH CHECK (true);


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 031_data_deletion_requests.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 031: Data Deletion Requests — Meta Platform Terms & GDPR compliance
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS data_deletion_requests (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  meta_account TEXT,
  reason TEXT,
  requested_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'rejected')),
  processed_at TIMESTAMPTZ,
  processed_by TEXT,
  notes TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_deletion_requests_status ON data_deletion_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_data_deletion_requests_email ON data_deletion_requests(email);

ALTER TABLE data_deletion_requests ENABLE ROW LEVEL SECURITY;

-- Service role full access (API server uses service role key)
DO $$ BEGIN
  CREATE POLICY "Service role full access" ON data_deletion_requests FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 032_creative_concepts.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 032: Creative Director — strategic concept layer
--
-- Stores Cannes-grade strategic concepts produced by the creative-director
-- engine (services/prompts/creative-director). One concept feeds 1+ downstream
-- content_concepts (per migration 024) by joining via creative_concept_id.
--
-- Apply in Supabase SQL editor. Idempotent — safe to re-run.
-- ============================================================================

-- ─── creative_concepts ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS creative_concepts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              UUID NOT NULL,
  business_goal            TEXT,
  content_goal             TEXT,
  idea_level               TEXT NOT NULL DEFAULT 'campaign',          -- business|brand|tagline|advertising|campaign|non_advertising|execution
  insight                  TEXT,                                       -- one-sentence "audience wants X but Y because Z"
  tension_type             TEXT,                                       -- cultural|category|human
  top_concept              JSONB NOT NULL DEFAULT '{}',                -- name, one_sentence, visualization, pattern, scores, kill_argument, comparable_canon
  runner_up                JSONB,                                      -- backup concept
  ideas_considered         JSONB DEFAULT '[]',                         -- audit trail of what was generated and why it was rejected
  weighted_score           NUMERIC(4,2),                               -- 0-10 (six-criteria weighted)
  humankind_score          NUMERIC(4,2),                               -- 0-10
  grey_score               NUMERIC(4,2),                               -- 0-10
  pattern                  TEXT,                                       -- P01..P18
  originality_capped_to    NUMERIC(4,2),                               -- empirical cap from pattern saturation
  comparable_canon         TEXT,                                       -- real campaign this stands alongside
  raw_response             TEXT,                                       -- full Opus response, for audit
  status                   TEXT NOT NULL DEFAULT 'pending_review',     -- pending_review|approved|rejected|used|superseded
  decided_at               TIMESTAMPTZ,
  decision_reason          TEXT,
  parent_plan_id           UUID,                                       -- optional FK to content_plans (no enforced FK in case of test data)
  model_used               TEXT DEFAULT 'claude-opus-4-5',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_creative_concepts_biz_time ON creative_concepts (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_creative_concepts_status ON creative_concepts (status);
CREATE INDEX IF NOT EXISTS idx_creative_concepts_pattern ON creative_concepts (pattern);
ALTER TABLE creative_concepts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "creative_concepts_service_full" ON creative_concepts;
CREATE POLICY "creative_concepts_service_full" ON creative_concepts FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "creative_concepts_owner_read" ON creative_concepts;
CREATE POLICY "creative_concepts_owner_read" ON creative_concepts FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = creative_concepts.business_id AND b.user_id = auth.uid())
);

-- ─── A/B testing column for creative-director measurement ──────────────────
ALTER TABLE creative_concepts ADD COLUMN IF NOT EXISTS ab_variant TEXT;
CREATE INDEX IF NOT EXISTS idx_creative_concepts_variant ON creative_concepts (ab_variant);

-- ─── Optional join: tie a downstream content_concepts row to the creative concept that produced it ─
ALTER TABLE content_concepts ADD COLUMN IF NOT EXISTS creative_concept_id UUID;
CREATE INDEX IF NOT EXISTS idx_content_concepts_creative ON content_concepts (creative_concept_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 033_business_characters.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 033: Soul ID — business_characters
--
-- Stores trained Higgsfield Soul ID characters per business. Each business can
-- train multiple characters (founder, mascot, model_persona, customer_proxy).
-- Once trained, character_id is reused across every image/video generation
-- to lock identity consistency.
--
-- Apply in Supabase SQL editor. Idempotent — safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS business_characters (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              UUID NOT NULL,
  name                     TEXT NOT NULL,                             -- 'founder', 'mascot', 'sarah_persona', etc.
  character_type           TEXT NOT NULL DEFAULT 'founder',           -- founder|mascot|model_persona|customer_proxy|other
  higgsfield_character_id  TEXT,                                      -- soul_character_id returned by Higgsfield create-character API
  training_status          TEXT NOT NULL DEFAULT 'pending',           -- pending|uploading|training|ready|failed
  source_image_urls        JSONB NOT NULL DEFAULT '[]',               -- 1-5 reference photos (Higgsfield requires 1-5; 20+ for best Soul ID)
  source_image_count       INTEGER NOT NULL DEFAULT 0,
  training_started_at      TIMESTAMPTZ,
  trained_at               TIMESTAMPTZ,
  training_error           TEXT,
  credit_cost              INTEGER DEFAULT 40,                        -- Higgsfield charges ~40 credits ≈ $2.50/character
  is_default               BOOLEAN NOT NULL DEFAULT FALSE,            -- one default per business — used when no character_id specified
  last_used_at             TIMESTAMPTZ,
  use_count                INTEGER NOT NULL DEFAULT 0,
  metadata                 JSONB DEFAULT '{}',                        -- description, demographics, brand notes
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_business_characters_biz ON business_characters (business_id);
CREATE INDEX IF NOT EXISTS idx_business_characters_status ON business_characters (training_status);
CREATE INDEX IF NOT EXISTS idx_business_characters_default ON business_characters (business_id, is_default) WHERE is_default = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_business_characters_default
  ON business_characters (business_id) WHERE is_default = TRUE;
ALTER TABLE business_characters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "business_characters_service_full" ON business_characters;
CREATE POLICY "business_characters_service_full" ON business_characters FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "business_characters_owner_read" ON business_characters;
CREATE POLICY "business_characters_owner_read" ON business_characters FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = business_characters.business_id AND b.user_id = auth.uid())
);

-- ─── Optional: assets can reference which character was used ─────────────────
ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS character_id UUID REFERENCES business_characters(id);
CREATE INDEX IF NOT EXISTS idx_content_assets_character ON content_assets (character_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 034_asset_vetting_results.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 034: Asset Vetter results
--
-- Stores the verdict object returned by the maroa-image-vetter system for each
-- customer-uploaded image evaluated. Lets the dashboard display the audit trail
-- and lets the system avoid re-vetting the same image twice.
--
-- Apply in Supabase SQL editor. Idempotent — safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS asset_vetting_results (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                 UUID NOT NULL,
  image_url                   TEXT NOT NULL,
  content_theme               TEXT,
  genre                       TEXT,                                    -- food_beverage|service_business|b2b_saas|...
  verdict                     TEXT NOT NULL,                           -- use_as_is|enhance_via_higgsfield|regenerate_fresh|reject
  total_100                   NUMERIC(5,2),                            -- 0-100 weighted total
  borderline                  BOOLEAN NOT NULL DEFAULT FALSE,
  scores                      JSONB NOT NULL DEFAULT '{}',             -- 8 dimension scores
  hard_gates_fired            JSONB DEFAULT '[]',                      -- e.g. [{name:'safety',forces:'reject',reason:'...'}]
  manual_review_recommended   BOOLEAN NOT NULL DEFAULT FALSE,
  next_action                 JSONB,                                   -- enhance/regenerate/publish/reject details + I2I prompts if applicable
  notes                       JSONB,                                   -- per-dimension single-sentence notes
  subject_phrase              TEXT,                                    -- subject lock used for I2I if enhance
  applied                     BOOLEAN NOT NULL DEFAULT FALSE,          -- did downstream pipeline actually act on this verdict
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_avr_biz_time ON asset_vetting_results (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_avr_verdict ON asset_vetting_results (verdict);
CREATE INDEX IF NOT EXISTS idx_avr_image ON asset_vetting_results (image_url);
ALTER TABLE asset_vetting_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "avr_service_full" ON asset_vetting_results;
CREATE POLICY "avr_service_full" ON asset_vetting_results FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "avr_owner_read" ON asset_vetting_results;
CREATE POLICY "avr_owner_read" ON asset_vetting_results FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = asset_vetting_results.business_id AND b.user_id = auth.uid())
);


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 035_anthropic_files.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 035: Anthropic Files API integration
--
-- Tracks files uploaded to Anthropic per business: brand guidelines, past
-- performance reports, content libraries, competitor analysis. Each business
-- can attach files to Claude calls by reference instead of re-injecting
-- 5-10k chars of brand context per call. Pairs with prompt caching.
--
-- Anthropic Files API spec: 500MB per file, 500GB per organization, files
-- persist until explicitly deleted, free for upload/list/delete (only
-- inference-time use is billed).
-- ============================================================================

CREATE TABLE IF NOT EXISTS anthropic_files (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              UUID NOT NULL,
  anthropic_file_id        TEXT NOT NULL,                              -- file_011CN... from Anthropic
  filename                 TEXT NOT NULL,
  mime_type                TEXT,
  size_bytes               BIGINT,
  kind                     TEXT NOT NULL DEFAULT 'brand_guidelines',  -- brand_guidelines|past_performance|content_library|competitor_analysis|custom
  description              TEXT,
  is_default               BOOLEAN NOT NULL DEFAULT FALSE,            -- attach to every Claude call for this business
  uploaded_by_user_id      UUID,
  use_count                INTEGER NOT NULL DEFAULT 0,
  last_used_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_anthropic_files_biz ON anthropic_files (business_id);
CREATE INDEX IF NOT EXISTS idx_anthropic_files_kind ON anthropic_files (business_id, kind);
CREATE INDEX IF NOT EXISTS idx_anthropic_files_default ON anthropic_files (business_id, is_default) WHERE is_default = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_anthropic_files_anthropic_id ON anthropic_files (anthropic_file_id);
ALTER TABLE anthropic_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anthropic_files_service_full" ON anthropic_files;
CREATE POLICY "anthropic_files_service_full" ON anthropic_files FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anthropic_files_owner_read" ON anthropic_files;
CREATE POLICY "anthropic_files_owner_read" ON anthropic_files FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = anthropic_files.business_id AND b.user_id = auth.uid())
);


-- ═══════════════════════════════════════════════════════════════════════════
-- ▸ 036_anthropic_batches.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 036: Anthropic Message Batches API integration
--
-- Tracks bulk Claude calls submitted via the Message Batches API. 50% cost
-- savings on async work, perfect for overnight content generation across
-- all active businesses.
--
-- Batch lifecycle: in_progress -> canceling -> ended.
-- Per-request results retrieved from Anthropic when batch ends.
-- ============================================================================

CREATE TABLE IF NOT EXISTS anthropic_batches (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anthropic_batch_id       TEXT NOT NULL,                              -- msgbatch_01... from Anthropic
  purpose                  TEXT NOT NULL,                              -- 'wf1_overnight' | 'wf13_weekly_brief' | 'custom'
  request_count            INTEGER NOT NULL DEFAULT 0,
  status                   TEXT NOT NULL DEFAULT 'in_progress',        -- in_progress|canceling|ended
  processing_status        TEXT,                                       -- succeeded|errored|canceled|expired (per-request roll-up)
  succeeded_count          INTEGER DEFAULT 0,
  errored_count            INTEGER DEFAULT 0,
  canceled_count           INTEGER DEFAULT 0,
  expired_count            INTEGER DEFAULT 0,
  results_url              TEXT,
  submitted_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at                 TIMESTAMPTZ,
  expires_at               TIMESTAMPTZ,
  request_index            JSONB DEFAULT '[]',                         -- array of { custom_id, business_id, target_table, target_id }
  cost_estimate_usd        NUMERIC(10,4),
  metadata                 JSONB DEFAULT '{}',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_anthropic_batches_status ON anthropic_batches (status);
CREATE INDEX IF NOT EXISTS idx_anthropic_batches_purpose_time ON anthropic_batches (purpose, submitted_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_anthropic_batches_id ON anthropic_batches (anthropic_batch_id);
ALTER TABLE anthropic_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anthropic_batches_service_full" ON anthropic_batches;
CREATE POLICY "anthropic_batches_service_full" ON anthropic_batches FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Per-request results table (one row per individual request inside a batch)
CREATE TABLE IF NOT EXISTS anthropic_batch_results (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id                 UUID NOT NULL REFERENCES anthropic_batches(id) ON DELETE CASCADE,
  custom_id                TEXT NOT NULL,
  business_id              UUID,
  result_status            TEXT,                                       -- succeeded|errored|canceled|expired
  response_body            JSONB,                                      -- the message response
  error                    JSONB,
  applied                  BOOLEAN NOT NULL DEFAULT FALSE,             -- did downstream pipeline pick up the result
  applied_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_anthropic_batch_results_batch ON anthropic_batch_results (batch_id);
CREATE INDEX IF NOT EXISTS idx_anthropic_batch_results_biz ON anthropic_batch_results (business_id);
CREATE INDEX IF NOT EXISTS idx_anthropic_batch_results_unapplied ON anthropic_batch_results (batch_id) WHERE applied = FALSE;
ALTER TABLE anthropic_batch_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anthropic_batch_results_service_full" ON anthropic_batch_results;
CREATE POLICY "anthropic_batch_results_service_full" ON anthropic_batch_results FOR ALL TO service_role USING (true) WITH CHECK (true);


-- ═══════════════════════════════════════════════════════════════════════════
-- END OF BUNDLE — verify by running these checks:
-- ═══════════════════════════════════════════════════════════════════════════

SELECT COUNT(*) AS table_count FROM information_schema.tables
WHERE table_schema = 'public';

SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'businesses','generated_content','ad_campaigns','ad_performance_logs',
    'daily_stats','competitor_insights','business_photos','retention_logs',
    'ab_tests','onboarding_events','post_drafts','usage_logs',
    'creative_concepts','business_characters','asset_vetting_results',
    'anthropic_files','anthropic_batches','anthropic_batch_results',
    'content_plans','content_concepts','content_assets'
  )
ORDER BY table_name;
