-- Migration 036: Anthropic Message Batches API integration
--
-- Tracks bulk Claude calls submitted via the Message Batches API. 50% cost
-- savings on async work, perfect for overnight content generation across
-- all active businesses.
--
-- Batch lifecycle: in_progress -> canceling -> ended.
-- Per-request results retrieved from Anthropic when batch ends.
-- ============================================================================

CREATE TABLE IF NOT EXISTS anthropic_batches (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anthropic_batch_id       TEXT NOT NULL,                              -- msgbatch_01... from Anthropic
  purpose                  TEXT NOT NULL,                              -- 'wf1_overnight' | 'wf13_weekly_brief' | 'custom'
  request_count            INTEGER NOT NULL DEFAULT 0,
  status                   TEXT NOT NULL DEFAULT 'in_progress',        -- in_progress|canceling|ended
  processing_status        TEXT,                                       -- succeeded|errored|canceled|expired (per-request roll-up)
  succeeded_count          INTEGER DEFAULT 0,
  errored_count            INTEGER DEFAULT 0,
  canceled_count           INTEGER DEFAULT 0,
  expired_count            INTEGER DEFAULT 0,
  results_url              TEXT,
  submitted_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at                 TIMESTAMPTZ,
  expires_at               TIMESTAMPTZ,
  request_index            JSONB DEFAULT '[]',                         -- array of { custom_id, business_id, target_table, target_id }
  cost_estimate_usd        NUMERIC(10,4),
  metadata                 JSONB DEFAULT '{}',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_anthropic_batches_status ON anthropic_batches (status);
CREATE INDEX IF NOT EXISTS idx_anthropic_batches_purpose_time ON anthropic_batches (purpose, submitted_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_anthropic_batches_id ON anthropic_batches (anthropic_batch_id);
ALTER TABLE anthropic_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anthropic_batches_service_full" ON anthropic_batches;
CREATE POLICY "anthropic_batches_service_full" ON anthropic_batches FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Per-request results table (one row per individual request inside a batch)
CREATE TABLE IF NOT EXISTS anthropic_batch_results (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id                 UUID NOT NULL REFERENCES anthropic_batches(id) ON DELETE CASCADE,
  custom_id                TEXT NOT NULL,
  business_id              UUID,
  result_status            TEXT,                                       -- succeeded|errored|canceled|expired
  response_body            JSONB,                                      -- the message response
  error                    JSONB,
  applied                  BOOLEAN NOT NULL DEFAULT FALSE,             -- did downstream pipeline pick up the result
  applied_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_anthropic_batch_results_batch ON anthropic_batch_results (batch_id);
CREATE INDEX IF NOT EXISTS idx_anthropic_batch_results_biz ON anthropic_batch_results (business_id);
CREATE INDEX IF NOT EXISTS idx_anthropic_batch_results_unapplied ON anthropic_batch_results (batch_id) WHERE applied = FALSE;
ALTER TABLE anthropic_batch_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anthropic_batch_results_service_full" ON anthropic_batch_results;
CREATE POLICY "anthropic_batch_results_service_full" ON anthropic_batch_results FOR ALL TO service_role USING (true) WITH CHECK (true);
