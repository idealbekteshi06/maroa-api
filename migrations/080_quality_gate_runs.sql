-- Analytics persistence for maroa-quality-gate skill (ship | retry | reject)

CREATE TABLE IF NOT EXISTS quality_gate_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID,
  content_type    TEXT NOT NULL DEFAULT 'generic',
  decision        TEXT NOT NULL,
  ship_safe       BOOLEAN NOT NULL DEFAULT false,
  retries         INT NOT NULL DEFAULT 0,
  blocking_issues JSONB NOT NULL DEFAULT '[]',
  checks_summary  JSONB NOT NULL DEFAULT '{}',
  input_chars     INT,
  output_chars    INT,
  skill_tag       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qg_runs_biz_time ON quality_gate_runs (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qg_runs_decision ON quality_gate_runs (decision, created_at DESC);

ALTER TABLE quality_gate_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "qg_runs_service" ON quality_gate_runs;
CREATE POLICY "qg_runs_service" ON quality_gate_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
