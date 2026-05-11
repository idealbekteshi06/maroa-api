-- migrations/057_jsonb_gin_indexes.sql
-- ----------------------------------------------------------------------------
-- GIN indexes on every JSONB column that is filtered by `->>` in a hot path.
--
-- 287 JSONB occurrences across the schema (per the audit). Without GIN
-- indexes, every `payload->>'kind' = 'foo'` becomes a sequential scan
-- of the entire table. At ~100k events/business/month and 50+ businesses
-- the events + approvals + audit tables turn into ~10s queries.
--
-- jsonb_path_ops is the operator class for `@>` containment queries
-- (cheaper, smaller index). Use jsonb_ops if you also need `?` / `?&` /
-- `?|` existence queries — none of Maroa's current filters do.
--
-- All indexes are CREATE INDEX IF NOT EXISTS so re-applying is safe.
-- ----------------------------------------------------------------------------

-- events table — `payload` JSONB filtered by kind, source, severity
CREATE INDEX IF NOT EXISTS idx_events_payload_gin
  ON events USING GIN (payload jsonb_path_ops);

-- approvals — `payload` JSONB queried per content type
CREATE INDEX IF NOT EXISTS idx_approvals_payload_gin
  ON approvals USING GIN (payload jsonb_path_ops);

-- brain_decisions — JSONB context per autopilot decision
CREATE INDEX IF NOT EXISTS idx_brain_decisions_context_gin
  ON brain_decisions USING GIN (context jsonb_path_ops);

-- ad_audit_results — score_breakdown, citations, opportunities all JSONB
CREATE INDEX IF NOT EXISTS idx_ad_audit_results_score_breakdown_gin
  ON ad_audit_results USING GIN (score_breakdown jsonb_path_ops);

-- cro_audits — dimension_scores, critical_issues, warnings
CREATE INDEX IF NOT EXISTS idx_cro_audits_dimension_scores_gin
  ON cro_audits USING GIN (dimension_scores jsonb_path_ops);

-- weekly_scorecards — week_data + deltas
CREATE INDEX IF NOT EXISTS idx_weekly_scorecards_week_data_gin
  ON weekly_scorecards USING GIN (week_data jsonb_path_ops);

-- business_profiles — brand_voice_anchor (auto-loaded into Claude prompts)
CREATE INDEX IF NOT EXISTS idx_business_profiles_anchor_gin
  ON business_profiles USING GIN (brand_voice_anchor jsonb_path_ops);

-- ai_citations — citations array per audit
CREATE INDEX IF NOT EXISTS idx_ai_citations_payload_gin
  ON ai_citations USING GIN (data jsonb_path_ops);

-- voc_analyses — per-source extracted phrases
CREATE INDEX IF NOT EXISTS idx_voc_analyses_phrases_gin
  ON voc_analyses USING GIN (extracted_phrases jsonb_path_ops);

-- forecasts — projection table per forecast
CREATE INDEX IF NOT EXISTS idx_forecasts_projection_gin
  ON forecasts USING GIN (projection jsonb_path_ops);

-- onboarding_events — event_data filtered by event_type often comes with
-- a JSONB shape filter
CREATE INDEX IF NOT EXISTS idx_onboarding_events_data_gin
  ON onboarding_events USING GIN (event_data jsonb_path_ops);

-- cold_start_runs — state machine JSONB
CREATE INDEX IF NOT EXISTS idx_cold_start_runs_state_gin
  ON cold_start_runs USING GIN (state jsonb_path_ops);

-- After applying, run:
--   SELECT relname, indexname, pg_size_pretty(pg_relation_size(indexname::text))
--   FROM pg_stat_user_indexes JOIN pg_class ON pg_class.relname = indexname
--   WHERE indexname LIKE 'idx_%_gin' ORDER BY pg_relation_size(indexname::text) DESC;
-- to confirm sizes are sensible (~1-10MB per index typical at 50k+ row tables).
