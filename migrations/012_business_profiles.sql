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
