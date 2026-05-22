-- Migration 083 — Agency video A/B tests (WF10)
CREATE TABLE IF NOT EXISTS video_ab_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  post_id UUID,
  variant_a_job_id TEXT,
  variant_b_job_id TEXT,
  variant_c_job_id TEXT,
  variant_a_model TEXT,
  variant_b_model TEXT,
  variant_c_model TEXT,
  winner_variant TEXT,
  meta_experiment_id TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_video_ab_tests_business ON video_ab_tests(business_id);
CREATE INDEX IF NOT EXISTS idx_video_ab_tests_status ON video_ab_tests(status);

ALTER TABLE video_ab_tests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "video_ab_tests_service_full" ON video_ab_tests;
CREATE POLICY "video_ab_tests_service_full" ON video_ab_tests FOR ALL TO service_role USING (true) WITH CHECK (true);
