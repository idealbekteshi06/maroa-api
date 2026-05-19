-- migrations/071_atomic_rpcs.sql
-- ----------------------------------------------------------------------------
-- Atomic multi-table writes via Supabase RPC functions.
--
-- Audit 2026-05-18 H4: PostgREST has no native BEGIN/COMMIT for multi-table
-- writes. cold-start (cold_start_runs + cold_start_concepts) and ad-optimizer
-- (ad_audit_results + ad_campaigns patch) ran as two separate POSTs. If the
-- second failed, the first was orphaned.
--
-- These plpgsql functions wrap the writes in a single transaction. They're
-- INVOKER-security so the calling Supabase client's auth/role is honored.
-- Caller signature is keyword-args via the PostgREST RPC convention.
--
-- Usage from the app:
--   await sbRpc('cold_start_initialize', {
--     p_business_id: businessId,
--     p_phase: 'compose-strategy',
--     p_concepts: [...]
--   });
-- ----------------------------------------------------------------------------

-- Helper: simple sbRpc-friendly response envelope so callers can branch on
-- success/failure without throwing.
CREATE OR REPLACE FUNCTION _atomic_response(p_ok boolean, p_data jsonb DEFAULT NULL, p_error text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'ok', p_ok,
    'data', COALESCE(p_data, '{}'::jsonb),
    'error', p_error
  );
$$;

-- ─── cold_start_initialize ────────────────────────────────────────────────
-- Creates a cold_start_runs row + the initial cold_start_concepts in ONE tx.
-- If concepts insert fails, the runs row is rolled back too.
CREATE OR REPLACE FUNCTION cold_start_initialize(
  p_business_id uuid,
  p_phase       text DEFAULT 'compose-strategy',
  p_concepts    jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_run_id uuid;
  v_concept jsonb;
  v_inserted int := 0;
BEGIN
  -- Upsert the run row — idempotent by (business_id, phase).
  INSERT INTO cold_start_runs (business_id, phase, status, started_at)
  VALUES (p_business_id, p_phase, 'running', now())
  ON CONFLICT (business_id, phase)
  DO UPDATE SET status = 'running', started_at = now()
  RETURNING id INTO v_run_id;

  -- Bulk-insert concepts. If any single insert fails, the whole tx rolls back.
  IF jsonb_typeof(p_concepts) = 'array' THEN
    FOR v_concept IN SELECT * FROM jsonb_array_elements(p_concepts) LOOP
      INSERT INTO cold_start_concepts (run_id, business_id, concept, created_at)
      VALUES (v_run_id, p_business_id, v_concept, now());
      v_inserted := v_inserted + 1;
    END LOOP;
  END IF;

  RETURN _atomic_response(
    true,
    jsonb_build_object('run_id', v_run_id, 'concepts_inserted', v_inserted)
  );
EXCEPTION WHEN OTHERS THEN
  -- Re-raise so PostgREST returns 5xx; transaction is rolled back automatically.
  RAISE;
END;
$$;

COMMENT ON FUNCTION cold_start_initialize IS
  'audit-2026-05-18 H4: atomic cold-start init. Replaces the two-call pattern in services/cold-start/index.js.';

-- ─── ad_optimizer_decision ────────────────────────────────────────────────
-- Records the audit row and updates ad_campaigns in ONE tx so a partial
-- write can't leave a logged decision without the campaign reflecting it.
CREATE OR REPLACE FUNCTION ad_optimizer_decision(
  p_business_id    uuid,
  p_campaign_id    text,
  p_decision       text,
  p_reason         text,
  p_score          numeric,
  p_score_breakdown jsonb DEFAULT NULL,
  p_patch_status   text DEFAULT NULL,
  p_patch_budget   numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_audit_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO ad_audit_results (
    id, business_id, campaign_id, decision, reason, score, score_breakdown, created_at
  ) VALUES (
    v_audit_id, p_business_id, p_campaign_id, p_decision, p_reason, p_score,
    COALESCE(p_score_breakdown, '{}'::jsonb), now()
  );

  IF p_patch_status IS NOT NULL OR p_patch_budget IS NOT NULL THEN
    UPDATE ad_campaigns
       SET status = COALESCE(p_patch_status, status),
           daily_budget = COALESCE(p_patch_budget, daily_budget),
           last_decision = p_decision,
           last_decision_reason = p_reason,
           last_decision_at = now()
     WHERE business_id = p_business_id
       AND meta_campaign_id = p_campaign_id;
  END IF;

  RETURN _atomic_response(
    true,
    jsonb_build_object('audit_id', v_audit_id, 'decision', p_decision)
  );
EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$$;

COMMENT ON FUNCTION ad_optimizer_decision IS
  'audit-2026-05-18 H4: atomic audit insert + campaign patch. Use instead of the two-call pattern.';
