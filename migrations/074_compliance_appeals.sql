-- migrations/074_compliance_appeals.sql
-- ----------------------------------------------------------------------------
-- Compliance v2 appeals table. Customers (Agency + Enterprise tier) who
-- disagree with a hard-block submit an appeal here. Maroa-side reviewer
-- triages within 24h; status moves pending → approved | denied.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS compliance_appeals (
  id              bigserial PRIMARY KEY,
  business_id     uuid NOT NULL,
  draft           text NOT NULL,
  violations      jsonb NOT NULL DEFAULT '[]'::jsonb,
  severity        text,
  rewrite_offered text,
  appeal_reason   text,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'denied', 'withdrawn')),
  reviewer_id     uuid,
  reviewer_notes  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_compliance_appeals_business
  ON compliance_appeals (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_compliance_appeals_pending
  ON compliance_appeals (created_at)
  WHERE status = 'pending';

ALTER TABLE compliance_appeals DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE compliance_appeals IS
  'Compliance v2 appeals (lib/complianceEngine.recordAppeal). Pending rows surface to ops dashboard within 24h SLA.';
