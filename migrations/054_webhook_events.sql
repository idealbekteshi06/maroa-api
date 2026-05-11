-- migrations/054_webhook_events.sql
-- ----------------------------------------------------------------------------
-- Webhook delivery idempotency table.
--
-- Every webhook provider (Paddle, Stripe, Meta, Higgsfield, Inngest, Ayrshare)
-- retries on non-2xx or perceived network failure, and some send the same
-- delivery twice on purpose during failover. Without idempotency, retries
-- re-run handlers: re-grant plans, re-fire cold-start, double-count usage,
-- double-send emails.
--
-- This table enforces at-most-once semantics. lib/webhookEvents.js writes
-- a row to this table at the start of every handler. The PRIMARY KEY on
-- (provider, event_id) means a duplicate insert fails — the handler sees
-- "duplicate" and short-circuits.
--
-- Retention: 90 days (longer than any provider's replay window). The
-- maintenance cron in services/observability/retention.js sweeps older rows.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_events (
  provider     text NOT NULL,
  event_id     text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  status       text NOT NULL DEFAULT 'received',  -- received | processed | failed
  payload      jsonb,
  error        text,

  PRIMARY KEY (provider, event_id)
);

-- Sweep candidate index (retention cron filters by received_at)
CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at
  ON webhook_events (received_at);

-- Status filter for ops dashboards (where status != 'processed')
CREATE INDEX IF NOT EXISTS idx_webhook_events_status_received
  ON webhook_events (status, received_at DESC)
  WHERE status <> 'processed';

COMMENT ON TABLE webhook_events IS
  'Per-provider webhook delivery dedup. (provider, event_id) PRIMARY KEY enforces at-most-once handler execution.';
