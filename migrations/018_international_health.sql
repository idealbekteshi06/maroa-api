-- Migration 018: International + Health Score + Memory improvements
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
