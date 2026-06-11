-- migrations/092_fix_atomic_rpcs_and_errors.sql
-- ----------------------------------------------------------------------------
-- 1. Fix the migration-071 atomic RPCs, which referenced columns/constraints
--    that don't exist and therefore threw on EVERY call — so callers silently
--    fell back to the non-atomic two-write path (the H4 atomicity guarantee
--    never actually held).
--      cold_start_initialize: used `phase` (real: current_phase), an ON CONFLICT
--        target that isn't a unique constraint (UNIQUE is on business_id only),
--        and omitted the NOT-NULL `variant_index`.
--      ad_optimizer_decision: inserted into ad_audit_results columns that don't
--        exist (reason/score/created_at; real: decision_reason/audit_score/
--        audited_at) and set ad_campaigns.last_decision_at (real:
--        last_optimized_at), and matched campaigns by a text meta id against a
--        uuid column.
-- 2. Create the `errors` table that 8+ code sites read/write (and CLAUDE.md §4
--    documents) but no migration ever created — on a fresh DB every error-sink
--    write 400s and the ad-optimizer anti-thrashing signal is silently empty.
-- ----------------------------------------------------------------------------

BEGIN;

-- _atomic_response already exists from 071; recreate defensively for fresh DBs.
CREATE OR REPLACE FUNCTION _atomic_response(p_ok boolean, p_data jsonb DEFAULT NULL, p_error text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('ok', p_ok, 'data', COALESCE(p_data, '{}'::jsonb), 'error', p_error);
$$;

-- ─── cold_start_initialize (corrected) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION cold_start_initialize(
  p_business_id uuid,
  p_phase       text DEFAULT 'generate_concepts',
  p_concepts    jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_run_id  uuid;
  v_concept jsonb;
  v_idx     int := 0;
  v_inserted int := 0;
BEGIN
  INSERT INTO cold_start_runs (business_id, current_phase, status, started_at, updated_at)
  VALUES (p_business_id, p_phase, 'running', now(), now())
  ON CONFLICT (business_id)
  DO UPDATE SET current_phase = EXCLUDED.current_phase, status = 'running', updated_at = now()
  RETURNING id INTO v_run_id;

  IF jsonb_typeof(p_concepts) = 'array' THEN
    FOR v_concept IN SELECT * FROM jsonb_array_elements(p_concepts) LOOP
      v_idx := v_idx + 1;
      INSERT INTO cold_start_concepts (run_id, business_id, variant_index, concept, status, created_at)
      VALUES (
        v_run_id,
        p_business_id,
        COALESCE(NULLIF(v_concept->>'variant_index','')::int, v_idx),
        COALESCE(v_concept->'concept', v_concept),
        COALESCE(v_concept->>'status', 'proposed'),
        now()
      )
      ON CONFLICT (run_id, variant_index)
      DO UPDATE SET concept = EXCLUDED.concept, status = EXCLUDED.status;
      v_inserted := v_inserted + 1;
    END LOOP;
  END IF;

  RETURN _atomic_response(true, jsonb_build_object('run_id', v_run_id, 'concepts_inserted', v_inserted));
EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$$;

-- ─── ad_optimizer_decision (corrected) ─────────────────────────────────────
-- Drop the broken 071 signature (uuid, text, text, text, numeric, jsonb, text, numeric).
DROP FUNCTION IF EXISTS ad_optimizer_decision(uuid, text, text, text, numeric, jsonb, text, numeric);

CREATE OR REPLACE FUNCTION ad_optimizer_decision(
  p_business_id      uuid,
  p_campaign_id      uuid,
  p_decision         text,
  p_decision_reason  text,
  p_audit_score      int,
  p_score_breakdown  jsonb   DEFAULT NULL,
  p_new_daily_budget numeric DEFAULT NULL,
  p_patch_status     text    DEFAULT NULL,
  p_patch_budget     numeric DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_audit_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO ad_audit_results (
    id, campaign_id, business_id, audited_at, decision, decision_reason,
    new_daily_budget, audit_score, score_breakdown
  ) VALUES (
    v_audit_id, p_campaign_id, p_business_id, now(), p_decision, p_decision_reason,
    p_new_daily_budget, p_audit_score, COALESCE(p_score_breakdown, '{}'::jsonb)
  );

  IF p_patch_status IS NOT NULL OR p_patch_budget IS NOT NULL THEN
    UPDATE ad_campaigns
       SET status               = COALESCE(p_patch_status, status),
           daily_budget         = COALESCE(p_patch_budget, daily_budget),
           last_decision        = p_decision,
           last_decision_reason = p_decision_reason,
           last_optimized_at    = now()
     WHERE id = p_campaign_id AND business_id = p_business_id;
  END IF;

  RETURN _atomic_response(true, jsonb_build_object('audit_id', v_audit_id, 'decision', p_decision));
EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$$;

-- ─── errors table (was missing entirely) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS errors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid REFERENCES businesses(id) ON DELETE CASCADE,
  workflow       text,
  workflow_name  text,
  error_message  text,
  retry_payload  jsonb,
  retry_count    int  NOT NULL DEFAULT 0,
  resolved       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_errors_business_unresolved
  ON errors (business_id, resolved, created_at DESC);

ALTER TABLE errors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "errors_service_all" ON errors;
CREATE POLICY "errors_service_all" ON errors FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "errors_owner_read" ON errors;
CREATE POLICY "errors_owner_read" ON errors FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = errors.business_id AND b.user_id = auth.uid())
);

COMMIT;
