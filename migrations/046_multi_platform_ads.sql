-- migrations/046_multi_platform_ads.sql
-- ---------------------------------------------------------------------------
-- Week 5-7 — Multi-platform paid ads (Google + TikTok) + Measurement Health
-- + Daily Creative Engine + Attribution-Model Breakpoint Flag
--
-- Adds:
--   1. attribution_model_version on ad_performance_logs (March 2026 breakpoint)
--   2. measurement_health table — EMQ + dedup ratio + EC status per business
--   3. ad_creative_variants — Daily Creative Engine inventory + test outcomes
--   4. cross_account_patterns — Anonymized "what worked" patterns for transfer
-- ---------------------------------------------------------------------------

-- ─── 1. Attribution-model breakpoint flag ─────────────────────────────────
-- Meta rewrote click attribution in March 2026. Pre/post comparisons across
-- that breakpoint are apples-to-oranges. Tag every log so trend analysis
-- can split windows correctly.
ALTER TABLE ad_performance_logs
  ADD COLUMN IF NOT EXISTS attribution_model_version text NOT NULL DEFAULT 'meta_2026_03';

CREATE INDEX IF NOT EXISTS idx_ad_perf_logs_attribution_model
  ON ad_performance_logs (attribution_model_version);

-- ─── 2. Measurement Health ───────────────────────────────────────────────
-- One row per (business_id, day, platform). Reads Meta EMQ score, pixel↔CAPI
-- dedup ratio, Google Enhanced Conversions status. If EMQ < 6 or dedup
-- < 70%, the optimizer is told NOT to trust spend/ROAS metrics for scaling.
CREATE TABLE IF NOT EXISTS measurement_health (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              uuid          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  platform                 text          NOT NULL CHECK (platform IN ('meta','google','tiktok')),
  recorded_at              timestamptz   NOT NULL DEFAULT now(),

  -- Meta-specific
  emq_score                numeric(3,1)  NULL,
  pixel_capi_dedup_ratio   numeric(4,3)  NULL,
  capi_events_24h          int           NULL,

  -- Google-specific
  enhanced_conversions_on  boolean       NULL,
  enhanced_conv_match_rate numeric(4,3)  NULL,
  conv_action_count        int           NULL,

  -- TikTok-specific
  events_api_health        text          NULL,
  events_24h               int           NULL,

  -- Verdict
  health_verdict           text          NOT NULL DEFAULT 'unknown'
                           CHECK (health_verdict IN ('healthy','degraded','broken','unknown')),
  trust_for_scaling        boolean       NOT NULL DEFAULT false,
  reasons                  text[]        NOT NULL DEFAULT ARRAY[]::text[],

  raw                      jsonb         NULL,

  created_at               timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_measurement_health_business_platform
  ON measurement_health (business_id, platform, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_measurement_health_verdict
  ON measurement_health (health_verdict) WHERE health_verdict <> 'healthy';

-- ─── 3. Ad Creative Variants — Daily Creative Engine ─────────────────────
-- Every day the engine generates 3-5 new creative variants per business and
-- routes 1% of budget to test them. Winners get promoted; losers get killed
-- after 72h. This table is the inventory + test ledger.
CREATE TABLE IF NOT EXISTS ad_creative_variants (
  id                  uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid            NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  campaign_id         uuid            NULL REFERENCES ad_campaigns(id) ON DELETE SET NULL,

  -- Lineage: where did this variant come from?
  source              text            NOT NULL CHECK (source IN ('cold_start','daily_engine','customer_upload','refresh','cross_account_transfer')),
  parent_variant_id   uuid            NULL REFERENCES ad_creative_variants(id) ON DELETE SET NULL,

  -- The actual creative
  format              text            NOT NULL CHECK (format IN ('image','video','carousel','text_only')),
  headline            text            NULL,
  body                text            NULL,
  cta                 text            NULL,
  asset_url           text            NULL,
  higgsfield_model    text            NULL,
  higgsfield_request_id text          NULL,

  -- Test lifecycle
  status              text            NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','testing','winning','losing','promoted','killed','archived')),
  test_started_at     timestamptz     NULL,
  test_ended_at       timestamptz     NULL,

  -- Outcomes (populated as test runs)
  spend_test_pct      numeric(5,4)    NOT NULL DEFAULT 0.01,    -- default 1% of budget
  impressions         int             NOT NULL DEFAULT 0,
  clicks              int             NOT NULL DEFAULT 0,
  conversions         int             NOT NULL DEFAULT 0,
  spend               numeric(10,2)   NOT NULL DEFAULT 0,
  ctr                 numeric(6,4)    NULL,
  cpa                 numeric(10,2)   NULL,
  roas                numeric(8,2)    NULL,

  -- Decision metadata
  z_score_ctr         numeric(6,3)    NULL,
  z_score_roas        numeric(6,3)    NULL,
  confidence          numeric(4,3)    NULL,
  decision_reason     text            NULL,

  created_at          timestamptz     NOT NULL DEFAULT now(),
  updated_at          timestamptz     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creative_variants_business_status
  ON ad_creative_variants (business_id, status);
CREATE INDEX IF NOT EXISTS idx_creative_variants_testing
  ON ad_creative_variants (business_id, test_started_at DESC) WHERE status = 'testing';
CREATE INDEX IF NOT EXISTS idx_creative_variants_source
  ON ad_creative_variants (source);

CREATE OR REPLACE FUNCTION ad_creative_variants_touch_updated_at()
RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ad_creative_variants_touch_updated_at ON ad_creative_variants;
CREATE TRIGGER trg_ad_creative_variants_touch_updated_at
  BEFORE UPDATE ON ad_creative_variants
  FOR EACH ROW EXECUTE FUNCTION ad_creative_variants_touch_updated_at();

-- ─── 4. Cross-account anonymized patterns ────────────────────────────────
-- Aggregates "what worked" patterns across all Maroa businesses in the same
-- industry/region/budget tier. Used by Daily Creative Engine to seed
-- variants. Anonymized — no business_id linkage in this table.
CREATE TABLE IF NOT EXISTS cross_account_patterns (
  id                  uuid            PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Cohort key (industry + region + budget tier)
  industry            text            NOT NULL,
  region              text            NULL,
  budget_tier         text            NOT NULL CHECK (budget_tier IN ('5','20','50','100','500')),

  -- The pattern itself
  pattern_type        text            NOT NULL CHECK (pattern_type IN ('headline','hook','cta','format','audience','timing')),
  pattern_signature   text            NOT NULL,                 -- e.g. "before_after_image+question_headline"
  pattern_payload     jsonb           NOT NULL,                 -- the actual reusable pattern

  -- Lift signal
  observation_count   int             NOT NULL DEFAULT 1,
  median_roas_lift    numeric(6,3)    NULL,                     -- vs cohort baseline
  median_ctr_lift     numeric(6,3)    NULL,
  confidence          numeric(4,3)    NULL,                     -- 0..1

  last_updated_at     timestamptz     NOT NULL DEFAULT now(),

  UNIQUE (industry, region, budget_tier, pattern_type, pattern_signature)
);

CREATE INDEX IF NOT EXISTS idx_cross_account_lookup
  ON cross_account_patterns (industry, budget_tier, pattern_type)
  WHERE confidence > 0.7;
