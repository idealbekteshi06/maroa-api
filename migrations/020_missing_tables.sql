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
