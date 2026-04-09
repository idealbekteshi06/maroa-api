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
