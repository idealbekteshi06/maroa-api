-- Migration 086 — Ad-optimizer actuator tracking
-- Records when an optimizer decision was actually executed against Meta and
-- the raw response (or dry-run intent). Powers PART 4 of the automated Meta
-- Ads system: the engine no longer just patches the DB, it executes on Meta
-- and stamps the result here.
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS execution_response JSONB;

-- Audience IDs synced from Meta (PART 1 — populated by the Sunday
-- syncCustomAudiences job; added here so the column exists ahead of that pass).
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS meta_custom_audience_id TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS meta_lookalike_audience_id TEXT;
