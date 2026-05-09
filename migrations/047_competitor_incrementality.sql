-- migrations/047_competitor_incrementality.sql
-- ---------------------------------------------------------------------------
-- Week 8 — Competitor War Room + Incrementality Engine
-- ---------------------------------------------------------------------------

-- ─── Competitor signals (raw observations) ────────────────────────────────
-- One row per detected change to a competitor's ad activity. The auditor
-- compares snapshots over time; this table is the running event log.
CREATE TABLE IF NOT EXISTS competitor_signals (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- Who is the competitor (denormalized — we don't have a competitors table)
  competitor_name text          NOT NULL,
  competitor_url  text          NULL,
  source          text          NOT NULL CHECK (source IN ('meta_ad_library','google_auction_insights','serpapi','tiktok_creative_center','manual')),

  -- What changed
  signal_type     text          NOT NULL CHECK (signal_type IN ('new_ad_launched','ad_paused','spend_increase','spend_decrease','new_creative','keyword_overlap','share_of_voice_change')),
  signal_payload  jsonb         NOT NULL DEFAULT '{}'::jsonb,

  -- Severity / confidence
  severity        text          NOT NULL DEFAULT 'info'
                  CHECK (severity IN ('info','watch','alert','critical')),
  confidence      numeric(4,3)  NULL,

  -- Reaction tracking
  reaction_taken  text          NULL,
  reacted_at      timestamptz   NULL,

  observed_at     timestamptz   NOT NULL DEFAULT now(),
  created_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_competitor_signals_business
  ON competitor_signals (business_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_competitor_signals_alerts
  ON competitor_signals (business_id, severity)
  WHERE severity IN ('alert','critical') AND reaction_taken IS NULL;

-- ─── Incrementality tests ────────────────────────────────────────────────
-- Geo-holdout test: hold out spend in N% of geos, measure conversion lift
-- in served geos vs holdout geos. Gives true incremental ROAS, not the
-- platform-claimed (over-counted) version.
CREATE TABLE IF NOT EXISTS incrementality_tests (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  test_type           text          NOT NULL CHECK (test_type IN ('geo_holdout','intent_holdout','user_holdout')),
  platform            text          NOT NULL CHECK (platform IN ('meta','google','tiktok','cross_channel')),

  -- Test design
  treatment_geos      text[]        NOT NULL DEFAULT ARRAY[]::text[],
  control_geos        text[]        NOT NULL DEFAULT ARRAY[]::text[],
  holdout_pct         numeric(4,3)  NOT NULL DEFAULT 0.10,

  -- Lifecycle
  started_at          timestamptz   NOT NULL DEFAULT now(),
  ended_at            timestamptz   NULL,
  status              text          NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','completed','aborted','inconclusive')),

  -- Results (filled in when status -> completed)
  treatment_conversions     int             NULL,
  control_conversions       int             NULL,
  treatment_spend           numeric(10,2)   NULL,
  control_spend             numeric(10,2)   NULL,
  incremental_lift_pct      numeric(7,3)    NULL,
  platform_claimed_roas     numeric(8,2)    NULL,
  true_incremental_roas     numeric(8,2)    NULL,
  p_value                   numeric(6,4)    NULL,
  is_statistically_significant boolean      NULL,

  notes                     text            NULL,
  created_at                timestamptz     NOT NULL DEFAULT now(),
  updated_at                timestamptz     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incrementality_tests_business
  ON incrementality_tests (business_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_incrementality_tests_active
  ON incrementality_tests (business_id, status) WHERE status = 'running';

CREATE OR REPLACE FUNCTION incrementality_tests_touch_updated_at()
RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_incrementality_tests_touch_updated_at ON incrementality_tests;
CREATE TRIGGER trg_incrementality_tests_touch_updated_at
  BEFORE UPDATE ON incrementality_tests
  FOR EACH ROW EXECUTE FUNCTION incrementality_tests_touch_updated_at();
