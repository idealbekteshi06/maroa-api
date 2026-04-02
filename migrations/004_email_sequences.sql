-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 004: Behavior-Triggered Email Sequences
-- Run AFTER migration 003.
-- Safe to re-run: all statements use IF NOT EXISTS guards.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_sequences (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  trigger_type  TEXT NOT NULL,
  trigger_value TEXT,
  delay_hours   INT DEFAULT 0,
  is_active     BOOLEAN DEFAULT TRUE,
  emails        JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contact_enrollments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_email  TEXT NOT NULL,
  contact_name   TEXT,
  sequence_id    UUID NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
  current_step   INT DEFAULT 0,
  status         TEXT DEFAULT 'active'
                   CHECK (status IN ('active','completed','unsubscribed','bounced')),
  enrolled_at    TIMESTAMPTZ DEFAULT NOW(),
  next_send_at   TIMESTAMPTZ DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_enrollments_next_send ON contact_enrollments(next_send_at, status);
CREATE INDEX IF NOT EXISTS idx_enrollments_business  ON contact_enrollments(business_id, status);
CREATE INDEX IF NOT EXISTS idx_sequences_business    ON email_sequences(business_id, is_active);

-- Verify
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('email_sequences','contact_enrollments')
ORDER BY tablename;
