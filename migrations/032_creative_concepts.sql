-- Migration 032: Creative Director — strategic concept layer
--
-- Stores Cannes-grade strategic concepts produced by the creative-director
-- engine (services/prompts/creative-director). One concept feeds 1+ downstream
-- content_concepts (per migration 024) by joining via creative_concept_id.
--
-- Apply in Supabase SQL editor. Idempotent — safe to re-run.
-- ============================================================================

-- ─── creative_concepts ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS creative_concepts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              UUID NOT NULL,
  business_goal            TEXT,
  content_goal             TEXT,
  idea_level               TEXT NOT NULL DEFAULT 'campaign',          -- business|brand|tagline|advertising|campaign|non_advertising|execution
  insight                  TEXT,                                       -- one-sentence "audience wants X but Y because Z"
  tension_type             TEXT,                                       -- cultural|category|human
  top_concept              JSONB NOT NULL DEFAULT '{}',                -- name, one_sentence, visualization, pattern, scores, kill_argument, comparable_canon
  runner_up                JSONB,                                      -- backup concept
  ideas_considered         JSONB DEFAULT '[]',                         -- audit trail of what was generated and why it was rejected
  weighted_score           NUMERIC(4,2),                               -- 0-10 (six-criteria weighted)
  humankind_score          NUMERIC(4,2),                               -- 0-10
  grey_score               NUMERIC(4,2),                               -- 0-10
  pattern                  TEXT,                                       -- P01..P18
  originality_capped_to    NUMERIC(4,2),                               -- empirical cap from pattern saturation
  comparable_canon         TEXT,                                       -- real campaign this stands alongside
  raw_response             TEXT,                                       -- full Opus response, for audit
  status                   TEXT NOT NULL DEFAULT 'pending_review',     -- pending_review|approved|rejected|used|superseded
  decided_at               TIMESTAMPTZ,
  decision_reason          TEXT,
  parent_plan_id           UUID,                                       -- optional FK to content_plans (no enforced FK in case of test data)
  model_used               TEXT DEFAULT 'claude-opus-4-5',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_creative_concepts_biz_time ON creative_concepts (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_creative_concepts_status ON creative_concepts (status);
CREATE INDEX IF NOT EXISTS idx_creative_concepts_pattern ON creative_concepts (pattern);
ALTER TABLE creative_concepts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "creative_concepts_service_full" ON creative_concepts;
CREATE POLICY "creative_concepts_service_full" ON creative_concepts FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "creative_concepts_owner_read" ON creative_concepts;
CREATE POLICY "creative_concepts_owner_read" ON creative_concepts FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = creative_concepts.business_id AND b.user_id = auth.uid())
);

-- ─── A/B testing column for creative-director measurement ──────────────────
ALTER TABLE creative_concepts ADD COLUMN IF NOT EXISTS ab_variant TEXT;
CREATE INDEX IF NOT EXISTS idx_creative_concepts_variant ON creative_concepts (ab_variant);

-- ─── Optional join: tie a downstream content_concepts row to the creative concept that produced it ─
ALTER TABLE content_concepts ADD COLUMN IF NOT EXISTS creative_concept_id UUID;
CREATE INDEX IF NOT EXISTS idx_content_concepts_creative ON content_concepts (creative_concept_id);
