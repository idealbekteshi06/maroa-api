-- migrations/055_migrations_ledger.sql
-- ----------------------------------------------------------------------------
-- Migration ledger — tracks which migration files have been applied to this
-- database, with a content checksum so drift between repo and DB is caught.
--
-- BEFORE this ledger existed, migrations were applied by hand via the
-- Supabase SQL editor. The only "track" was operator memory.
--
-- After this ledger:
--   scripts/check-migrations.js --verify-applied compares files in
--   migrations/ against rows in this table and flags:
--     - applied but missing from repo (corrupted clone)
--     - in repo but not applied (need to run)
--     - checksum mismatch (someone edited an applied migration — DANGER)
--
-- The ledger itself uses IF NOT EXISTS so applying this file is idempotent.
-- On first run, the operator should insert backfill rows for every prior
-- migration that's already applied (see scripts/check-migrations.js).
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS _migrations (
  id           bigserial PRIMARY KEY,
  filename     text NOT NULL UNIQUE,
  checksum     text NOT NULL,              -- sha256 hex of file contents at apply time
  applied_at   timestamptz NOT NULL DEFAULT now(),
  applied_by   text DEFAULT current_user,
  duration_ms  integer,
  notes        text
);

CREATE INDEX IF NOT EXISTS idx__migrations_applied_at
  ON _migrations (applied_at DESC);

COMMENT ON TABLE _migrations IS
  'Migration ledger. scripts/check-migrations.js --verify-applied compares files in migrations/ against rows here.';
COMMENT ON COLUMN _migrations.checksum IS
  'sha256 of file contents at apply time. Drift (someone edited an applied migration) is flagged on next check.';
