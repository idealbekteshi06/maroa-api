-- Migration 089 — Wave 1 wiring fixes (audit remediation)
--
-- (A) content_performance schema collision fix.
--     migration 024 already created content_performance as a POST-PUBLISH
--     measurement table (post_id NOT NULL, asset_id NOT NULL, hours_since_post
--     NOT NULL, engagement_rate, ...). migration 087 re-declared it with
--     `CREATE TABLE IF NOT EXISTS` for GEN-TIME virality predictions
--     (content_id, virality_score, ...) — a silent no-op, because the table
--     already existed. The WF1 virality writer therefore inserted into the
--     024 shape and failed every time (unknown column content_id + missing
--     NOT NULL post_id/asset_id), swallowed by a .catch().
--
--     These are two different lifecycle stages, so they get two tables. The
--     024 measurement table is left untouched; virality predictions move to
--     their own table that the WF1 writer now targets.
CREATE TABLE IF NOT EXISTS content_virality_predictions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID NOT NULL,
  content_id           UUID NOT NULL,          -- the content_assets row id
  virality_score       INTEGER,
  predicted_engagement TEXT,
  hook_strength        TEXT,
  retention_risk       TEXT,
  raw                  JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cvp_business ON content_virality_predictions (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cvp_content ON content_virality_predictions (content_id);

-- (B) Dead-schema honesty — tables/columns whose integrations are not built
--     yet (no writer + no reader). COMMENT so nobody mistakes them for live.
COMMENT ON TABLE video_clips IS
  'RESERVED / NOT WIRED (audit 2026-05): Personal Clipper integration not implemented. No writer or reader exists. Do not assume clips are produced.';
COMMENT ON COLUMN businesses.higgsfield_element_ids IS
  'RESERVED / NOT WIRED (audit 2026-05): Higgsfield Reference Elements integration not implemented. Never written or read.';
COMMENT ON COLUMN businesses.higgsfield_product_id IS
  'RESERVED / NOT WIRED (audit 2026-05): Higgsfield Marketing Studio product integration not implemented. Never written or read.';

-- (C) higgsfield_credits honesty — the balance source (getBalance) is a stub,
--     so this column is only populated when an operator sets a default grant
--     (HIGGSFIELD_DEFAULT_CREDITS) or the future REST endpoint lands.
COMMENT ON COLUMN businesses.higgsfield_credits IS
  'Higgsfield credit balance. Populated by the daily credit cron ONLY when getBalance() returns a real value (REST endpoint pending) OR when HIGGSFIELD_DEFAULT_CREDITS seeds new businesses. NULL = balance unknown, guard/alerts inactive (see services/wf1/engine.js credit guard).';
