-- migrations/069_idempotency_keys.sql
-- ----------------------------------------------------------------------------
-- Idempotency-Key store for mutating customer-facing routes.
--
-- Why: webhooks are deduped via (provider, event_id) in webhook_events.
-- Customer-facing POST/PUT/PATCH routes had no dedup. A browser retry on
-- a transient network blip → content posts twice, ad spend doubles, email
-- enrolments duplicate. middleware/idempotency.js is the new gate; this
-- table is its durable backing store so dedup works across instances and
-- across restarts.
--
-- Lifecycle:
--   pending  → in-flight; concurrent retry sees 409 IDEMPOTENCY_KEY_IN_FLIGHT
--   complete → response cached for 24h; replay returns the cached body
--   failed   → 5xx response cached; client may retry with a new key
--
-- Cleanup: expired rows are pruned by a Postgres cron (set up via
-- pg_cron or a daily Inngest sweeper) — TTL is 24h post-creation.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key             text PRIMARY KEY,
  status          text NOT NULL CHECK (status IN ('pending', 'complete', 'failed')),
  response_status int,
  response_body   jsonb,
  request_hash    text,
  route           text,
  user_id         uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at
  ON idempotency_keys (expires_at);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_user_id
  ON idempotency_keys (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- RLS: service-role only — this table is internal infrastructure, never
-- read directly by customers. Disable RLS to avoid the overhead of policy
-- evaluation on every read.
ALTER TABLE idempotency_keys DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE idempotency_keys IS
  'Stores response payloads keyed by Idempotency-Key header for 24h. Backs middleware/idempotency.js.';
COMMENT ON COLUMN idempotency_keys.request_hash IS
  'sha256(canonical-JSON of request body). Lets us 409 when the same key is reused with a different body.';
