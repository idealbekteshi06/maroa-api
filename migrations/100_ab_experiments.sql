-- 100_ab_experiments.sql
-- Creative A/B experiments engine (2026-07): extends the dormant ab_tests
-- table into a real sequential experiment record. services/ab-testing runs a
-- two-proportion z-test over ad_performance_logs per variant and records the
-- verdict here; the ad-optimizer/UI read status+result.

ALTER TABLE ab_tests ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE ab_tests ADD COLUMN IF NOT EXISTS metric TEXT DEFAULT 'ctr';
ALTER TABLE ab_tests ADD COLUMN IF NOT EXISTS min_impressions_per_arm INT DEFAULT 1000;
ALTER TABLE ab_tests ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'collecting';
ALTER TABLE ab_tests ADD COLUMN IF NOT EXISTS confidence NUMERIC;
ALTER TABLE ab_tests ADD COLUMN IF NOT EXISTS result JSONB DEFAULT '{}';
ALTER TABLE ab_tests ADD COLUMN IF NOT EXISTS meta_study_id TEXT;
ALTER TABLE ab_tests ADD COLUMN IF NOT EXISTS concluded_at TIMESTAMPTZ;

-- status: collecting | winner_a | winner_b | no_difference | cancelled
ALTER TABLE ab_tests DROP CONSTRAINT IF EXISTS ab_tests_status_check;
ALTER TABLE ab_tests
  ADD CONSTRAINT ab_tests_status_check
  CHECK (status IN ('collecting', 'winner_a', 'winner_b', 'no_difference', 'cancelled'));

CREATE INDEX IF NOT EXISTS idx_ab_tests_biz_status ON ab_tests (business_id, status);

COMMENT ON TABLE ab_tests IS
  'Creative A/B experiments (services/ab-testing). Two-proportion z-test on ctr/conversion_rate per variant campaign; winner declared at p<0.05 with min sample per arm.';
