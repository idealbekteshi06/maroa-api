-- ===================================================================
-- Maroa.ai Database Migrations
-- Run against Supabase project: zqhyrbttuqkvmdewiytf
-- ===================================================================

-- 1. Add new columns to businesses table (use IF NOT EXISTS for safety)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS business_type text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS zip text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS service_area text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS target_locations jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS target_age_min integer DEFAULT 18;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS target_age_max integer DEFAULT 65;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS target_gender text DEFAULT 'all';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS customer_income jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS customer_interests jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS customer_pain_points text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS dream_customer text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS unique_differentiator text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS marketing_challenges jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS current_spend text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS brand_colors jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS content_avoid text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS primary_goal text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS monthly_budget integer DEFAULT 10;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS budget_cycle text DEFAULT 'monthly';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS selected_platforms jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS posting_frequency text DEFAULT '3 per week';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS posting_times jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS num_employees text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS website_url text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS unique_selling_proposition text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS business_description text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS onboarding_step integer DEFAULT 1;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS onboarding_data jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS autopilot_enabled boolean DEFAULT true;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS linkedin_access_token text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS linkedin_page_id text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tiktok_access_token text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS google_ads_customer_id text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ai_brain_decisions jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS brand_voice_locked text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS performance_baseline jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS learning_data jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS best_performing_themes jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS worst_performing_themes jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS optimal_posting_times jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS audience_insights jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS weekly_leads integer DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS total_spend numeric DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS followers_gained integer DEFAULT 0;

-- 2. Create errors table
CREATE TABLE IF NOT EXISTS errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  workflow_name text,
  error_message text,
  created_at timestamptz DEFAULT now(),
  resolved boolean DEFAULT false,
  retry_count integer DEFAULT 0,
  retry_payload jsonb
);

-- 3. Create inbox_messages table
CREATE TABLE IF NOT EXISTS inbox_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  platform text,
  customer_name text,
  customer_id text,
  message text,
  is_from_customer boolean,
  sent_at timestamptz DEFAULT now(),
  read_at timestamptz,
  thread_id text,
  ai_suggested_reply text
);

-- 4. Create content_performance table
CREATE TABLE IF NOT EXISTS content_performance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  content_id uuid REFERENCES generated_content(id) ON DELETE CASCADE,
  platform text,
  likes integer DEFAULT 0,
  comments integer DEFAULT 0,
  shares integer DEFAULT 0,
  reach integer DEFAULT 0,
  impressions integer DEFAULT 0,
  saves integer DEFAULT 0,
  clicks integer DEFAULT 0,
  recorded_at timestamptz DEFAULT now()
);

-- 5. Create learning_logs table
CREATE TABLE IF NOT EXISTS learning_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  lesson_type text,
  lesson_content text,
  confidence_score numeric,
  applied_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- 6. Create landing_pages table
CREATE TABLE IF NOT EXISTS landing_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  campaign_id uuid,
  hero_headline text,
  hero_subheadline text,
  hero_cta text,
  value_props jsonb,
  social_proof text,
  testimonials jsonb,
  faqs jsonb,
  closing_headline text,
  closing_cta text,
  meta_title text,
  meta_description text,
  html_content text,
  status text DEFAULT 'draft',
  created_at timestamptz DEFAULT now()
);

-- 7. Enable RLS on new tables (allow service role to bypass)
ALTER TABLE errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_performance ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE landing_pages ENABLE ROW LEVEL SECURITY;

-- 8. RLS policies — allow service role full access
CREATE POLICY IF NOT EXISTS "Service role full access" ON errors FOR ALL USING (true);
CREATE POLICY IF NOT EXISTS "Service role full access" ON inbox_messages FOR ALL USING (true);
CREATE POLICY IF NOT EXISTS "Service role full access" ON content_performance FOR ALL USING (true);
CREATE POLICY IF NOT EXISTS "Service role full access" ON learning_logs FOR ALL USING (true);
CREATE POLICY IF NOT EXISTS "Service role full access" ON landing_pages FOR ALL USING (true);
