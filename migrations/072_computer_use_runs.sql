-- migrations/072_computer_use_runs.sql
-- ----------------------------------------------------------------------------
-- Audit log for Claude Computer Use sessions.
--
-- Every run of services/computer-use writes a row here on start, then
-- patches it on completion. Operators can replay runs from this table to
-- diagnose Pixel-debug / audience-tweak / safety-appeal flows that drove
-- the Meta Ads UI on behalf of a business.
--
-- Companion to services/computer-use/index.js (ship 2026-05-19).
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS computer_use_runs (
  id                bigserial PRIMARY KEY,
  business_id       uuid NOT NULL,
  flow              text NOT NULL,
  args              jsonb DEFAULT '{}'::jsonb,
  dry_run           boolean NOT NULL DEFAULT true,
  status            text NOT NULL CHECK (status IN ('running','dry_run','succeeded','failed','aborted')),
  actions_taken     integer DEFAULT 0,
  summary           text,
  error             text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_computer_use_runs_business
  ON computer_use_runs (business_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_computer_use_runs_open
  ON computer_use_runs (status, started_at)
  WHERE status = 'running';

-- Audit-only table. Service-role writes; no customer-facing reads. Disable
-- RLS to skip policy evaluation overhead.
ALTER TABLE computer_use_runs DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE computer_use_runs IS
  'Audit log for Claude Computer Use browser-driving sessions (services/computer-use). Required by the safety model — every run is recorded, no exceptions.';
