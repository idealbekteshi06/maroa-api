-- Migration 012: Onboarding Profile System — Full business profile for AI prompts
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
CREATE POLICY IF NOT EXISTS "service_full_business_profiles" ON business_profiles FOR ALL USING (true) WITH CHECK (true);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_business_profiles_user ON business_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_business_profiles_score ON business_profiles(profile_score);
