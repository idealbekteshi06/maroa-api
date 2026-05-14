-- migrations/064_agency_pipeline_runs.sql
-- Wave 60 Session 10 — agency-grade master-pipeline audit table.
--
-- Every call to services/agency-pipeline writes one row here for:
--   * post-hoc analysis ("which specialist won this kind of job?")
--   * compliance audit trail ("what blocked publish on March 12?")
--   * ethics audit ("which manipulation_risk_total exceeded ceiling?")
--   * customer-facing reasoning trace (showing why we picked X)
--
-- Reads: dashboard / analytics, admin debug UI.
-- Writes: agency-pipeline only.
-- RLS: service-write, business-self-read.

CREATE TABLE IF NOT EXISTS agency_pipeline_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL,
  job_goal        text NOT NULL,
  channel         text,
  industry        text,

  -- Stage routing
  detected_awareness text,
  detected_funnel    text,
  detection_source   text,    -- 'heuristic' | 'llm' | 'override'
  detection_confidence numeric(4,3),

  -- Specialist dispatch
  specialist_picked  text NOT NULL,
  specialist_score   numeric(4,3),
  specialist_runners_up jsonb,

  -- Composition
  methodologies_applied  jsonb NOT NULL DEFAULT '[]'::jsonb,
  channel_guidance       jsonb,
  compliance_rulesets    jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Output + validation
  generation_text        text,
  critic_score           numeric(4,3),
  critic_fixes           jsonb,
  compliance_violations  jsonb NOT NULL DEFAULT '[]'::jsonb,
  manipulation_risk_total numeric(4,2),
  manipulation_risk_ceiling numeric(4,2),

  -- Terminal state
  ok                 boolean NOT NULL,
  refused            boolean NOT NULL DEFAULT false,
  refusal_reason     text,
  duration_ms        integer,

  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agency_pipeline_runs_business_idx
  ON agency_pipeline_runs (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agency_pipeline_runs_refused_idx
  ON agency_pipeline_runs (refused, created_at DESC)
  WHERE refused = true;

CREATE INDEX IF NOT EXISTS agency_pipeline_runs_specialist_idx
  ON agency_pipeline_runs (specialist_picked, created_at DESC);

-- RLS
ALTER TABLE agency_pipeline_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agency_pipeline_runs_self_read ON agency_pipeline_runs;
CREATE POLICY agency_pipeline_runs_self_read
  ON agency_pipeline_runs
  FOR SELECT
  USING (
    -- canonical column is `user_id` per migration 000_schema_bootstrap.sql:129
    -- and the existing pattern in 060_subscriptions_rls.sql:73.
    business_id IN (
      SELECT id FROM businesses WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS agency_pipeline_runs_service_write ON agency_pipeline_runs;
CREATE POLICY agency_pipeline_runs_service_write
  ON agency_pipeline_runs
  FOR INSERT
  TO service_role
  WITH CHECK (true);

COMMENT ON TABLE agency_pipeline_runs IS
  'Audit trail for the Wave 60 S10 agency-grade master pipeline. One row per generation call. RLS: business owners read their own; service role writes.';
