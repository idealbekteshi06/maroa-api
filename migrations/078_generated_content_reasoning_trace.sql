-- migrations/078_generated_content_reasoning_trace.sql
-- ----------------------------------------------------------------------------
-- Audit 2026-05-20 P1-4. The "no black boxes" promise on the about page
-- depends on every generated piece carrying a structured trace of what the
-- AI thought about. Pre-078 we had a 280-char `strategy_reason` field that
-- captured the headline reason — not enough to show grounding used, judge
-- verdicts, or critic feedback.
--
-- `reasoning_trace JSONB` is now the canonical place where:
--   - lib/groundingContext.js drops the cohort/wins/losses/voc/brand blocks
--     it used to anchor the generation
--   - lib/nBestReranker.js drops candidate judge scores
--   - lib/adversarialCritic.js drops the critic verdict + rewrite log
--   - the publish path drops platform_id + posted_at when the piece ships
--
-- Read by the dashboard's "why?" panel. Indexed via GIN so the dashboard
-- can filter on grounding mode (cold_start vs warm) for ops dashboards.
-- ----------------------------------------------------------------------------

ALTER TABLE generated_content
  ADD COLUMN IF NOT EXISTS reasoning_trace jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_generated_content_reasoning_trace_gin
  ON generated_content
  USING gin (reasoning_trace jsonb_path_ops);

COMMENT ON COLUMN generated_content.reasoning_trace IS
  'Structured chain-of-thought captured at generation time. Powers the "why?" dashboard panel. Includes grounding mode, judge scores, critic verdict, model used, latency. See lib/groundingContext + lib/nBestReranker + lib/adversarialCritic.';
