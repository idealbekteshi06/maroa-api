-- migrations/070_jsonb_check_constraints.sql
-- ----------------------------------------------------------------------------
-- DB-level safety net for JSONB payload columns.
--
-- Audit 2026-05-18 H5: events.payload, approvals.payload, decision_logs.context
-- were free-form jsonb with no validation. App-level Zod schemas
-- (lib/eventSchemas.js) catch most issues, but rogue paths (Inngest steps,
-- legacy migrations, manual SQL backfills) bypass the app. These CHECK
-- constraints are the floor under everything.
--
-- Constraints are minimal — only "this MUST be an object with these keys" —
-- so legitimate variation in payload shapes (per-kind enums) is permitted.
-- The strict per-kind shape is enforced in the app layer.
-- ----------------------------------------------------------------------------

-- events.payload — every event row must include `kind` as a string.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'events_payload_kind_required' AND table_name = 'events'
  ) THEN
    EXECUTE 'ALTER TABLE events
       ADD CONSTRAINT events_payload_kind_required
       CHECK (
         payload IS NULL
         OR (jsonb_typeof(payload) = ''object''
             AND (payload->>''kind'' IS NOT NULL OR kind IS NOT NULL))
       )';
  END IF;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'events table not present — skipping events_payload_kind_required';
END $$;

-- approvals.payload — must be an object with business_id + target_id.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'approvals_payload_shape' AND table_name = 'approvals'
  ) THEN
    EXECUTE 'ALTER TABLE approvals
       ADD CONSTRAINT approvals_payload_shape
       CHECK (
         payload IS NULL
         OR (jsonb_typeof(payload) = ''object''
             AND payload->>''business_id'' IS NOT NULL
             AND payload->>''target_id'' IS NOT NULL)
       )';
  END IF;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'approvals table not present — skipping approvals_payload_shape';
END $$;

-- decision_logs.inputs — must be an object when present.
-- NOTE: the original constraint referenced a `context` column that
-- decision_logs (migration 065) never had — only `inputs`/`agent_name`/
-- `execution_details` exist. That made this block raise undefined_column
-- (not caught below) and abort the whole migration. Target the real column
-- and also catch undefined_column so a schema drift can't abort 070.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'decision_logs_inputs_shape' AND table_name = 'decision_logs'
  ) THEN
    EXECUTE 'ALTER TABLE decision_logs
       ADD CONSTRAINT decision_logs_inputs_shape
       CHECK (
         inputs IS NULL
         OR jsonb_typeof(inputs) = ''object''
       )';
  END IF;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'decision_logs table not present — skipping decision_logs_inputs_shape';
  WHEN undefined_column THEN
    RAISE NOTICE 'decision_logs.inputs not present — skipping decision_logs_inputs_shape';
END $$;

-- inngest_dlq.event_data — soft check: must be an object if present.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'inngest_dlq_event_data_shape' AND table_name = 'inngest_dlq'
  ) THEN
    EXECUTE 'ALTER TABLE inngest_dlq
       ADD CONSTRAINT inngest_dlq_event_data_shape
       CHECK (event_data IS NULL OR jsonb_typeof(event_data) = ''object'')';
  END IF;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'inngest_dlq table not present — skipping inngest_dlq_event_data_shape';
END $$;

COMMENT ON CONSTRAINT events_payload_kind_required ON events IS
  'audit-2026-05-18 H5: every event row must include a kind string.';
