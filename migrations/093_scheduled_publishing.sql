-- Migration 093 — scheduled publishing for WF1 content_assets
--
-- WHY: content_assets.posting_time_local ("HH:MM", set by the WF1 engine from
-- grounded best-time signals) was stored but NEVER honored — every approved or
-- auto-approved asset published immediately, ignoring the optimal slot the
-- system itself computed. This adds the durable state a 15-minute scheduler
-- sweep needs to publish each asset at its slot exactly once.
--
-- Columns (all additive, IF NOT EXISTS — safe to re-run; safe on a drifted DB):
--   scheduled_at        — UTC instant to publish (NULL = not scheduled)
--   publish_attempts    — retry counter for the sweep (gives-up guard)
--   publish_claimed_at  — set when the sweep claims a row (stale-claim recovery)
--
-- New status values used by the app layer (status is free-text TEXT, no CHECK
-- to alter): 'scheduled' (waiting for its slot) and 'publishing' (claimed by a
-- sweep, in flight). Both flow back to 'published' or 'failed' as before.
--
-- The whole migration is wrapped so a missing content_assets table (extreme
-- drift) downgrades to a notice instead of aborting the migration runner.

DO $$
BEGIN
  IF to_regclass('public.content_assets') IS NULL THEN
    RAISE NOTICE 'content_assets table absent — skipping 093 scheduled-publishing columns';
    RETURN;
  END IF;

  ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
  ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS publish_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS publish_claimed_at TIMESTAMPTZ;

  COMMENT ON COLUMN content_assets.scheduled_at IS
    'UTC instant the scheduler should publish this asset (migration 093). Computed from posting_time_local in the business timezone. NULL = publish immediately / not scheduled.';
  COMMENT ON COLUMN content_assets.publish_attempts IS
    'Scheduler retry counter (migration 093). Sweep gives up + marks failed after WF1 MAX_PUBLISH_ATTEMPTS.';
  COMMENT ON COLUMN content_assets.publish_claimed_at IS
    'Set when a scheduler sweep claims this row for publishing (migration 093). Stale claims (status=publishing older than the reclaim window) are returned to scheduled.';
END $$;

-- Partial index: the sweep query is `status='scheduled' AND scheduled_at <= now()`.
-- Partial keeps it tiny — only unsent scheduled rows are indexed.
CREATE INDEX IF NOT EXISTS idx_content_assets_scheduled
  ON content_assets (scheduled_at)
  WHERE status = 'scheduled';

-- Secondary: stale-claim recovery scans status='publishing'.
CREATE INDEX IF NOT EXISTS idx_content_assets_publishing
  ON content_assets (publish_claimed_at)
  WHERE status = 'publishing';
