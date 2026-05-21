-- WF11 — Smart Routing (specialist model + SLA + escalations)
-- Extends WF9 inbox_threads with specialist assignment and escalation tracking.

ALTER TABLE inbox_threads
  ADD COLUMN IF NOT EXISTS specialist_role TEXT,
  ADD COLUMN IF NOT EXISTS escalation_level INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_can_autorespond BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_inbox_sla_breach
  ON inbox_threads (business_id, status, sla_deadline)
  WHERE status IN ('new', 'routed') AND sla_deadline IS NOT NULL;

CREATE TABLE IF NOT EXISTS inbox_routing_settings (
  business_id                    UUID PRIMARY KEY,
  autonomy_mode                  TEXT NOT NULL DEFAULT 'hybrid',
  deal_escalation_threshold_usd  NUMERIC NOT NULL DEFAULT 5000,
  refund_escalation_threshold_usd NUMERIC NOT NULL DEFAULT 200,
  default_sla_minutes            INT NOT NULL DEFAULT 240,
  owner_notify_email             TEXT,
  specialist_overrides           JSONB NOT NULL DEFAULT '{}',
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE inbox_routing_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inbox_routing_settings_service" ON inbox_routing_settings;
CREATE POLICY "inbox_routing_settings_service" ON inbox_routing_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS inbox_escalations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL,
  thread_id        UUID NOT NULL REFERENCES inbox_threads(id) ON DELETE CASCADE,
  specialist_role  TEXT NOT NULL,
  reason           TEXT NOT NULL,
  level            INT NOT NULL DEFAULT 1,
  notified         BOOLEAN NOT NULL DEFAULT false,
  resolved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbox_esc_biz ON inbox_escalations (business_id, created_at DESC);
ALTER TABLE inbox_escalations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inbox_escalations_service" ON inbox_escalations;
CREATE POLICY "inbox_escalations_service" ON inbox_escalations
  FOR ALL TO service_role USING (true) WITH CHECK (true);
