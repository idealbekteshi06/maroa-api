-- migrations/045_cold_start.sql
-- ---------------------------------------------------------------------------
-- Week 2-3 — Cold-start onboarding state machine.
--
-- A new customer signs up → triggers the cold-start orchestrator (Inngest
-- function) → orchestrator runs phases in sequence, persisting state to
-- cold_start_runs at each step. Idempotent: re-running a phase is safe.
--
-- Phases:
--   1. classify_industry       (Anthropic Opus)
--   2. detect_competitors      (SerpAPI)
--   3. build_brand_voice_anchor
--   4. train_soul_id           (Higgsfield) — gated on 3-angle photo upload
--   5. generate_concepts       (creative-director, 3 options)
--   6. await_concept_approval  (waits for customer tap-to-approve)
--   7. launch_initial_campaigns (ad-optimizer cold-start mode)
--   8. schedule_first_content
--   9. ship_ai_seo_baseline
--   10. complete
-- ---------------------------------------------------------------------------

-- Per-customer onboarding run. One per business.business_id (UNIQUE).
CREATE TABLE IF NOT EXISTS cold_start_runs (
  id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid           NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- Lifecycle
  started_at      timestamptz    NOT NULL DEFAULT now(),
  completed_at   timestamptz   NULL,
  failed_at       timestamptz    NULL,

  -- Current phase + status
  current_phase   text           NOT NULL DEFAULT 'classify_industry',
  status          text           NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','awaiting_input','completed','failed','cancelled')),

  -- Per-phase result snapshot (JSON keyed by phase name)
  phase_results   jsonb          NOT NULL DEFAULT '{}'::jsonb,

  -- Failure detail (last error before bail)
  last_error      text           NULL,
  retry_count     int            NOT NULL DEFAULT 0,

  -- Inngest run correlation
  inngest_run_id  text           NULL,

  -- Customer-facing state for the dashboard:
  -- { 'pct_complete': 60, 'eta_seconds': 240, 'next_user_action': 'approve_concepts' }
  display_state   jsonb          NOT NULL DEFAULT '{}'::jsonb,

  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now(),

  UNIQUE (business_id)
);

CREATE INDEX IF NOT EXISTS idx_cold_start_runs_status
  ON cold_start_runs (status);
CREATE INDEX IF NOT EXISTS idx_cold_start_runs_phase
  ON cold_start_runs (current_phase) WHERE status = 'running';

-- Auto-update updated_at on UPDATE
CREATE OR REPLACE FUNCTION cold_start_runs_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cold_start_runs_touch_updated_at ON cold_start_runs;
CREATE TRIGGER trg_cold_start_runs_touch_updated_at
  BEFORE UPDATE ON cold_start_runs
  FOR EACH ROW EXECUTE FUNCTION cold_start_runs_touch_updated_at();

-- Per-concept approval state (3 concepts per cold-start run).
-- The orchestrator generates 3 concepts and waits for the customer to pick 1.
CREATE TABLE IF NOT EXISTS cold_start_concepts (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid          NOT NULL REFERENCES cold_start_runs(id) ON DELETE CASCADE,
  business_id       uuid          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  variant_index     int           NOT NULL CHECK (variant_index BETWEEN 1 AND 5),
  concept           jsonb         NOT NULL,         -- creative-director output
  preview_image_url text          NULL,
  preview_video_url text          NULL,

  status            text          NOT NULL DEFAULT 'proposed'
                    CHECK (status IN ('proposed','approved','rejected','superseded')),
  approved_at       timestamptz   NULL,
  approved_by       uuid          NULL,             -- user_id from auth

  created_at        timestamptz   NOT NULL DEFAULT now(),

  UNIQUE (run_id, variant_index)
);

CREATE INDEX IF NOT EXISTS idx_cold_start_concepts_run
  ON cold_start_concepts (run_id);
CREATE INDEX IF NOT EXISTS idx_cold_start_concepts_status
  ON cold_start_concepts (status);

-- Add cold-start summary onto businesses for quick dashboard lookups
-- without needing to JOIN cold_start_runs every time.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS onboarding_state jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN businesses.onboarding_state IS
  'Customer-facing onboarding summary: { pct_complete, current_phase, next_user_action, last_updated_at }. Mirrored from cold_start_runs.display_state.';
