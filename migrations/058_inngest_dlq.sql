-- migrations/058_inngest_dlq.sql
-- ----------------------------------------------------------------------------
-- Dead-letter queue for Inngest jobs that exceed retry budget.
--
-- Inngest retries 3-4 times with exponential backoff. After the final
-- failure the job is logged in Inngest's dashboard but Maroa-internal
-- doesn't see it — no Sentry trail, no recovery hook, no ops dashboard.
--
-- This DLQ table captures every terminal failure so:
--   1. Sentry can fire from the Inngest function's `onFailure` handler
--      with the full event payload + error trace.
--   2. Ops can replay failed events by selecting from the DLQ and
--      re-sending via the Inngest API or a `dlq-replay` cron.
--   3. Customer-impacting failures (e.g. cold-start phases) surface in
--      the admin dashboard.
--
-- Wired from services/inngest/functions.js — each function gets an
-- `onFailure` handler that inserts into this table.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS inngest_dlq (
  id              bigserial PRIMARY KEY,
  function_id     text NOT NULL,
  event_name      text NOT NULL,
  event_id        text,                          -- Inngest's event id, if available
  business_id     uuid,                          -- denormalized for fast per-customer queries
  attempt_count   integer NOT NULL DEFAULT 1,
  failed_at       timestamptz NOT NULL DEFAULT now(),
  error_message   text NOT NULL,
  error_stack     text,
  event_data      jsonb,
  resolved_at     timestamptz,
  resolution_note text
);

-- Most queries scan recent failures per business
CREATE INDEX IF NOT EXISTS idx_inngest_dlq_business_failed
  ON inngest_dlq (business_id, failed_at DESC);

-- Ops dashboard: unresolved failures only
CREATE INDEX IF NOT EXISTS idx_inngest_dlq_unresolved
  ON inngest_dlq (failed_at DESC)
  WHERE resolved_at IS NULL;

-- Function-level failure rate (which Inngest function is flaky?)
CREATE INDEX IF NOT EXISTS idx_inngest_dlq_function_failed
  ON inngest_dlq (function_id, failed_at DESC);

COMMENT ON TABLE inngest_dlq IS
  'Dead-letter queue for Inngest jobs that exceeded retry budget. See services/inngest/dlqRecorder.js.';
