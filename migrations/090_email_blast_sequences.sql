-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 090: Single-writer consolidation for email_sequences
--
-- The shared `email_sequences` table had THREE writers with divergent schemas:
--   1. services/email-lifecycle (CANONICAL) — stage/cadence_days + email_sequence_runs
--   2. routes/email-lifecycle.js (legacy trigger-based blasts) — trigger_type +
--      inline emails[] + contact_enrollments
--   3. services/wf7 (deprecated) — already de-fanged (no longer writes the table)
--
-- This moves the legacy routes-based system (#2) onto its OWN table so the
-- canonical email-lifecycle engine becomes the SOLE writer to `email_sequences`.
-- See CANONICAL_WORKFLOWS.md.
--
-- Columns mirror the original email_sequences shape from migration 004 (the
-- trigger-based model that routes/email-lifecycle.js actually uses).
--
-- Safe to re-run: IF NOT EXISTS / IF EXISTS guards throughout. Additive — no
-- data is moved or dropped here. Pre-existing trigger_type rows remain in
-- email_sequences as inert legacy data; an optional backfill (copy them into
-- email_blast_sequences, then delete from email_sequences) is a follow-up.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_blast_sequences (
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

CREATE INDEX IF NOT EXISTS idx_blast_sequences_business ON email_blast_sequences(business_id, is_active);

-- contact_enrollments belonged to the legacy routes system; its sequence_id FK
-- pinned it to email_sequences(id). Drop that FK so enrollments can reference
-- the relocated email_blast_sequences rows. NOT re-added: pre-existing rows may
-- still point at email_sequences ids, which a fresh FK would reject.
ALTER TABLE contact_enrollments DROP CONSTRAINT IF EXISTS contact_enrollments_sequence_id_fkey;

-- Verify
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename = 'email_blast_sequences';
