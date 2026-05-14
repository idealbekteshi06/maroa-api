-- migrations/065_marketing_graph.sql
-- ───────────────────────────────────────────────────────────────────────
-- The Marketing Graph — Maroa.ai's load-bearing moat (ADR-0010).
--
-- A typed graph of every business-marketing entity + every relationship
-- between them + every claim + every offer + every audience + every
-- creative (with Creative Genome decomposition) + every experiment +
-- every agent decision.
--
-- Why: agents that read/write this graph compound over time. Outcomes
-- feed back into claims/offers/audience-segment performance scores.
-- After 30+ days of customer usage the graph is a self-improving asset
-- that competitors with more capital cannot replicate because they
-- don't have the SMB-specific context.
--
-- Design notes:
--   - Entities + edges are typed-not-rigid: entity_type is text + attrs
--     is jsonb so we can grow types (e.g. add 'webinar' or 'podcast'
--     later) without a migration.
--   - Per-table FK to businesses is intentional (denormalized) so RLS
--     stays simple + every query has business_id as the first filter.
--   - decision_logs generalizes agency_pipeline_runs (Wave 60 S10) to
--     ALL agents. Existing agency_pipeline_runs stays; new agents use
--     decision_logs.
--   - claims_library + offer_library + audience_segments + creative_assets
--     each carry an aggregate performance signal that lets the grounding
--     library + N-best reranker prefer high-performing instances.
--
-- Cost notes:
--   - Empty schema is free. Grows with usage. Each row is ~1-2KB.
--   - Indexes: business_id + (created_at DESC) covers 95% of read paths.
--   - No pgvector here — embeddings stay in content_embeddings (061).
--
-- Rollback: drop all 8 tables — Maroa libraries degrade gracefully when
-- the tables don't exist (same pattern as 061 + 062).

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- Extensions — declared first so any index that needs them parses cleanly.
-- (Originally this lived at the bottom; that fails because the trgm index
-- on claims_library at section 3 references gin_trgm_ops before the
-- extension is enabled. Fixed 2026-05-14.)
-- ═══════════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- used by claims_library trgm index

-- ═══════════════════════════════════════════════════════════════════════
-- 1. ENTITIES — typed nodes in the marketing graph
-- ═══════════════════════════════════════════════════════════════════════
-- Every distinct marketing-meaningful thing a business has: a product,
-- an audience, a channel, a competitor, a landing page, a citation
-- target, a revenue event. Typed but flexible via attrs jsonb.
--
-- Valid entity_type values (extensible — keep this comment in sync):
--   product · offer · audience · location · competitor · channel · claim
--   creative · landing_page · citation · revenue_event · review · keyword
--   blog_post · email_sequence · social_post · video · campaign · ad_set
CREATE TABLE IF NOT EXISTS marketing_graph_entities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL,
  entity_type     text NOT NULL,
  entity_subtype  text,                          -- e.g. 'meta-ads-image' under channel
  title           text NOT NULL,                 -- human-readable
  description     text,
  attrs           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','draft')),
  source          text,                          -- 'agent:ad-optimizer', 'import:meta', 'user', etc.
  external_id     text,                          -- e.g. Meta ad-set id, Google campaign id

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mge_business_type_idx
  ON marketing_graph_entities (business_id, entity_type, created_at DESC);

CREATE INDEX IF NOT EXISTS mge_external_idx
  ON marketing_graph_entities (business_id, entity_type, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS mge_attrs_gin_idx
  ON marketing_graph_entities USING gin (attrs);

-- ═══════════════════════════════════════════════════════════════════════
-- 2. EDGES — typed directed relationships
-- ═══════════════════════════════════════════════════════════════════════
-- Captures: claim → used_in → creative, audience → targeted_by → campaign,
-- competitor → outperformed_by → creative, revenue_event → attributed_to →
-- landing_page, etc.
--
-- Valid edge_type values (extensible):
--   promoted_in · targeted_at · derived_from · replaced_by · used_in
--   attributed_to · outperformed_by · competes_with · cites · contains
CREATE TABLE IF NOT EXISTS marketing_graph_edges (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL,
  source_entity_id    uuid NOT NULL REFERENCES marketing_graph_entities (id) ON DELETE CASCADE,
  target_entity_id    uuid NOT NULL REFERENCES marketing_graph_entities (id) ON DELETE CASCADE,
  edge_type           text NOT NULL,
  weight              numeric(8,4) NOT NULL DEFAULT 1.0,
  attrs               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mgedge_source_idx
  ON marketing_graph_edges (source_entity_id, edge_type);

CREATE INDEX IF NOT EXISTS mgedge_target_idx
  ON marketing_graph_edges (target_entity_id, edge_type);

CREATE INDEX IF NOT EXISTS mgedge_business_idx
  ON marketing_graph_edges (business_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════
-- 3. CLAIMS LIBRARY — atomic marketing claims with outcome scoring
-- ═══════════════════════════════════════════════════════════════════════
-- "30-day money-back guarantee", "fastest cleaning in Tirana",
-- "5,000+ orders this month", "loved by 200+ clients".
--
-- Each claim is reusable across creatives. outcome_signal aggregates
-- how creatives using this claim performed (set by the closed-loop
-- learning step). high-performing claims surface first in N-best.
CREATE TABLE IF NOT EXISTS claims_library (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                 uuid NOT NULL,
  claim_text                  text NOT NULL,
  claim_type                  text,           -- feature | benefit | social_proof | urgency | guarantee | authority | specificity
  evidence_url                text,           -- landing page or substantiation source
  substantiation_doc_id       uuid,           -- nullable FK to substantiation table when added
  outcome_signal              numeric(5,3) NOT NULL DEFAULT 0.5,  -- 0..1
  usage_count                 integer NOT NULL DEFAULT 0,
  status                      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired','draft')),
  compliance_flags            jsonb NOT NULL DEFAULT '[]'::jsonb,  -- from services/prompts/compliance

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  last_used_at                timestamptz
);

CREATE INDEX IF NOT EXISTS claims_business_idx
  ON claims_library (business_id, outcome_signal DESC, last_used_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS claims_text_trgm_idx
  ON claims_library USING gin (claim_text gin_trgm_ops);

-- Note: gin_trgm_ops requires the pg_trgm extension. Enable below.

-- ═══════════════════════════════════════════════════════════════════════
-- 4. OFFER LIBRARY — promotional offers with conversion tracking
-- ═══════════════════════════════════════════════════════════════════════
-- "20% off first order", "BOGO Tuesday", "free trial 14 days".
-- Reusable across creatives. Conversion + revenue counters update from
-- ad_performance_logs + content performance tables.
CREATE TABLE IF NOT EXISTS offer_library (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL,
  name                text NOT NULL,
  description         text,
  offer_type          text NOT NULL CHECK (offer_type IN ('discount_pct','discount_dollar','bogo','free_trial','bundle','free_shipping','first_order','referral','other')),
  offer_value         numeric(10,2),                 -- pct (0..100) or dollars
  valid_from          timestamptz,
  valid_until         timestamptz,
  channels            text[] NOT NULL DEFAULT '{}',  -- which channels it ran on
  conversion_count    integer NOT NULL DEFAULT 0,
  revenue_usd         numeric(12,2) NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','draft','retired')),
  attrs               jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS offers_business_status_idx
  ON offer_library (business_id, status, valid_until DESC NULLS LAST);

-- ═══════════════════════════════════════════════════════════════════════
-- 5. AUDIENCE SEGMENTS — addressable audiences across platforms
-- ═══════════════════════════════════════════════════════════════════════
-- Each row = one platform-specific audience: a Meta interest set, a
-- Google in-market segment, a custom email list, a retargeting cohort.
-- Stored once, referenced by creatives + campaigns via edges.
CREATE TABLE IF NOT EXISTS audience_segments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL,
  name                text NOT NULL,
  segment_type        text NOT NULL CHECK (segment_type IN ('interest','lookalike','custom_list','retargeting','demographic','contextual','intent','exclusion','other')),
  source_platform     text NOT NULL,                  -- meta | google | tiktok | linkedin | owned
  platform_id         text,                           -- external audience id
  size_estimate       bigint,
  spec                jsonb NOT NULL DEFAULT '{}'::jsonb,
  performance_summary jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {ctr, cpa, roas, impressions}
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audience_business_platform_idx
  ON audience_segments (business_id, source_platform, status);

-- ═══════════════════════════════════════════════════════════════════════
-- 6. CREATIVE ASSETS — every creative, with Creative Genome decomposition
-- ═══════════════════════════════════════════════════════════════════════
-- The "Creative Genome" idea from the strategy: every creative is
-- decomposed into hook_type + offer + angle + emotion + visual_style +
-- cta + audience + channel + performance. Lets the system learn things
-- like "fear-relief hooks + clean visual outperform discount hooks for
-- dentists in Kosovo."
CREATE TABLE IF NOT EXISTS creative_assets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL,
  asset_type          text NOT NULL CHECK (asset_type IN ('image','video','copy','headline','carousel','reel','story','email_html','landing_block')),
  asset_url           text,
  thumbnail_url       text,

  -- Genome decomposition (classification — set by agents at create time)
  hook_type           text,                           -- fear_relief | curiosity | social_proof | scarcity | authority | aspiration | reciprocity | pattern_interrupt
  angle               text,                           -- problem_aware | solution_aware | product_aware | most_aware | brand
  emotion             text,                           -- excitement | trust | urgency | belonging | aspiration | relief | curiosity
  visual_style        text,                           -- clean_minimal | ugc | polished_studio | hand_drawn | bold_color | text_overlay
  cta_text            text,
  channel             text NOT NULL,                  -- matches services/prompts/channels ids

  -- Performance (denormalized from ad_performance_logs + content_pieces)
  impressions         bigint NOT NULL DEFAULT 0,
  clicks              integer NOT NULL DEFAULT 0,
  conversions         integer NOT NULL DEFAULT 0,
  spend_usd           numeric(10,2) NOT NULL DEFAULT 0,
  revenue_usd         numeric(12,2) NOT NULL DEFAULT 0,
  performance_score   numeric(5,3),                   -- composite, 0..1 (closed-loop learning sets this)

  -- Foreign refs (soft — nullable; library handles missing rows)
  claim_ids           uuid[] NOT NULL DEFAULT '{}',
  offer_id            uuid,
  audience_id         uuid,
  experiment_id       uuid,

  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived','draft')),
  attrs               jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creative_business_channel_perf_idx
  ON creative_assets (business_id, channel, performance_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS creative_hook_idx
  ON creative_assets (business_id, hook_type)
  WHERE hook_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS creative_experiment_idx
  ON creative_assets (experiment_id)
  WHERE experiment_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 7. EXPERIMENTS — autonomous A/B testing state
-- ═══════════════════════════════════════════════════════════════════════
-- Each experiment is a hypothesis + N variants + a budget + an outcome.
-- Experiment-engine agent (Phase 4) reads this to decide what to run
-- next; UI's Autopilot Control Room reads completed experiments to
-- explain "we found that X outperforms Y by Z%."
CREATE TABLE IF NOT EXISTS experiments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL,
  name                text NOT NULL,
  hypothesis          text,
  variant_count       integer NOT NULL CHECK (variant_count >= 2 AND variant_count <= 10),
  status              text NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','running','paused','completed','failed','cancelled')),
  winner_creative_id  uuid REFERENCES creative_assets (id) ON DELETE SET NULL,
  confidence_score    numeric(5,4),                    -- 0..1, statistical
  primary_metric      text,                            -- ctr | cpa | roas | conversions | revenue
  budget_usd          numeric(10,2),
  spend_usd           numeric(10,2) NOT NULL DEFAULT 0,
  lift_pct            numeric(7,3),                    -- winner vs control
  conclusion          text,
  attrs               jsonb NOT NULL DEFAULT '{}'::jsonb,

  started_at          timestamptz,
  ended_at            timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS experiments_business_status_idx
  ON experiments (business_id, status, started_at DESC NULLS LAST);

-- ═══════════════════════════════════════════════════════════════════════
-- 8. DECISION LOGS — universal agent decision audit trail
-- ═══════════════════════════════════════════════════════════════════════
-- Generalizes Wave 60 S10's agency_pipeline_runs to ALL agents:
-- ad-optimizer, content-generator, cro, voc, competitor-watch,
-- agency-pipeline, lifecycle-marketer, growth-engineer, etc.
--
-- Every agent decision writes one row. The Autopilot Control Room
-- UI (Phase 3) reads this table to show:
--   - what Maroa noticed
--   - what it recommends
--   - confidence + expected upside + risk + cost
--   - whether human approval is required
--   - what it actually did
--   - the measured outcome (filled in by closed-loop learning later)
--
-- auto_safe_band semantics:
--   green  → auto-publish, no approval needed
--   yellow → notify operator before publish (brand-sensitive)
--   red    → never auto-publish (regulated / high-risk / above spend threshold)
CREATE TABLE IF NOT EXISTS decision_logs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              uuid NOT NULL,
  agent_name               text NOT NULL,                  -- ad-optimizer | content-generator | cro | voc | competitor-watch | agency-pipeline | ...
  decision_type            text NOT NULL,                  -- refresh_creative | scale_budget | pause_campaign | generate_content | apply_cro_fix | ...
  decision_subtype         text,

  -- Context (inputs at decision time)
  inputs                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  trigger                  text,                           -- cron | webhook | user-request | self-initiated

  -- Recommendation
  recommendation_text      text NOT NULL,                  -- human-readable
  confidence               numeric(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  expected_upside_text     text,                           -- e.g. "+15% CTR within 7 days"
  expected_upside_value    numeric(10,3),                  -- numeric quantification when possible
  risk_text                text,
  cost_usd                 numeric(10,2) NOT NULL DEFAULT 0,
  manipulation_risk        numeric(4,2),                   -- Wave 60 ethics ceiling — only set for content decisions

  -- Approval routing
  auto_safe_band           text NOT NULL DEFAULT 'green' CHECK (auto_safe_band IN ('green','yellow','red')),
  required_approval        boolean NOT NULL DEFAULT false,
  approved_by              uuid,                           -- user_id, nullable until approved
  approved_at              timestamptz,

  -- Execution state
  executed                 boolean NOT NULL DEFAULT false,
  executed_at              timestamptz,
  execution_details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  refused                  boolean NOT NULL DEFAULT false,
  refusal_reason           text,

  -- Outcome (set by closed-loop learning AFTER measurement window)
  outcome_measured_at      timestamptz,
  outcome                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome_score            numeric(5,3),                   -- 0..1 against expected_upside

  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS decision_logs_business_created_idx
  ON decision_logs (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS decision_logs_agent_idx
  ON decision_logs (agent_name, created_at DESC);

CREATE INDEX IF NOT EXISTS decision_logs_pending_approval_idx
  ON decision_logs (business_id, required_approval, approved_at)
  WHERE required_approval = true AND approved_at IS NULL;

CREATE INDEX IF NOT EXISTS decision_logs_refused_idx
  ON decision_logs (business_id, refused, created_at DESC)
  WHERE refused = true;

-- ═══════════════════════════════════════════════════════════════════════
-- Row-level security — same pattern as agency_pipeline_runs (064)
-- All 8 tables: business-owner self-read; service role writes everything.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE marketing_graph_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_graph_edges    ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims_library           ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_library            ENABLE ROW LEVEL SECURITY;
ALTER TABLE audience_segments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_assets          ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiments              ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_logs            ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'marketing_graph_entities',
    'marketing_graph_edges',
    'claims_library',
    'offer_library',
    'audience_segments',
    'creative_assets',
    'experiments',
    'decision_logs'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_self_read ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_self_read ON %I FOR SELECT USING ('
      ||   'business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())'
      ||')',
      t, t
    );

    EXECUTE format('DROP POLICY IF EXISTS %I_service_write ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_service_write ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      t, t
    );
  END LOOP;
END
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- updated_at triggers — auto-bump on UPDATE
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION _marketing_graph_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'marketing_graph_entities',
    'claims_library',
    'offer_library',
    'audience_segments',
    'creative_assets',
    'experiments'
  ])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_touch_updated_at ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_touch_updated_at BEFORE UPDATE ON %I '
      ||'FOR EACH ROW EXECUTE FUNCTION _marketing_graph_touch_updated_at()',
      t, t
    );
  END LOOP;
END
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- Inline comments on tables (visible in Supabase Studio + pg_dump)
-- ═══════════════════════════════════════════════════════════════════════
COMMENT ON TABLE marketing_graph_entities IS
  'Typed nodes in the Marketing Graph — products, audiences, channels, creatives, etc. ADR-0010.';
COMMENT ON TABLE marketing_graph_edges IS
  'Typed directed relationships between entities (promoted_in, targeted_at, derived_from, etc.).';
COMMENT ON TABLE claims_library IS
  'Atomic marketing claims with outcome scoring. High-scoring claims surface first in N-best.';
COMMENT ON TABLE offer_library IS
  'Promotional offers with conversion + revenue tracking. Reusable across creatives.';
COMMENT ON TABLE audience_segments IS
  'Platform-addressable audiences (Meta interests, Google in-market, retargeting cohorts).';
COMMENT ON TABLE creative_assets IS
  'Every creative with Creative Genome decomposition (hook_type, angle, emotion, visual_style, cta).';
COMMENT ON TABLE experiments IS
  'Autonomous A/B testing state — hypothesis, variants, winner, lift_pct, conclusion.';
COMMENT ON TABLE decision_logs IS
  'Universal agent decision audit trail. Replaces ad-hoc logging across all agents. Drives Autopilot Control Room UI.';

COMMIT;
