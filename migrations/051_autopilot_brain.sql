-- migrations/051_autopilot_brain.sql
-- Week 12 — Autopilot Brain (cross-domain orchestrator + daily brief)

-- One row per (business, date). The Autopilot Brain runs every morning at
-- 08:00 UTC, snapshots the business state across all 11 capability pillars,
-- chooses today's plan, narrates the why, and emails the brief.
CREATE TABLE IF NOT EXISTS autopilot_runs (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  run_date        date          NOT NULL,

  -- Cross-domain snapshot at run time
  signals_snapshot jsonb        NOT NULL DEFAULT '{}'::jsonb,

  -- The plan: an ordered list of decisions per domain
  decisions       jsonb         NOT NULL DEFAULT '[]'::jsonb,

  -- Conflict-resolution outputs (when 2+ domains wanted incompatible things)
  conflicts_resolved jsonb      NOT NULL DEFAULT '[]'::jsonb,

  -- The customer-facing brief (1-paragraph narrative)
  brief_text      text          NULL,
  brief_html      text          NULL,
  brief_sent_at   timestamptz   NULL,

  -- Cost + LLM metadata
  llm_calls       int           NOT NULL DEFAULT 0,
  llm_cost_usd    numeric(8,4)  NOT NULL DEFAULT 0,
  ran_with_advisor boolean      NOT NULL DEFAULT false,

  -- Run lifecycle
  status          text          NOT NULL DEFAULT 'completed'
                  CHECK (status IN ('running','completed','failed')),
  started_at      timestamptz   NOT NULL DEFAULT now(),
  completed_at   timestamptz   NULL,
  error           text          NULL,

  created_at      timestamptz   NOT NULL DEFAULT now(),

  UNIQUE (business_id, run_date)
);

CREATE INDEX IF NOT EXISTS idx_autopilot_runs_business
  ON autopilot_runs (business_id, run_date DESC);
