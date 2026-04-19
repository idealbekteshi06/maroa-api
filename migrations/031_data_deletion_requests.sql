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
