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
