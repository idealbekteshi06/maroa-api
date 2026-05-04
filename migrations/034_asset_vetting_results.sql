-- Migration 034: Asset Vetter results
--
-- Stores the verdict object returned by the maroa-image-vetter system for each
-- customer-uploaded image evaluated. Lets the dashboard display the audit trail
-- and lets the system avoid re-vetting the same image twice.
--
-- Apply in Supabase SQL editor. Idempotent — safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS asset_vetting_results (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                 UUID NOT NULL,
  image_url                   TEXT NOT NULL,
  content_theme               TEXT,
  genre                       TEXT,                                    -- food_beverage|service_business|b2b_saas|...
  verdict                     TEXT NOT NULL,                           -- use_as_is|enhance_via_higgsfield|regenerate_fresh|reject
  total_100                   NUMERIC(5,2),                            -- 0-100 weighted total
  borderline                  BOOLEAN NOT NULL DEFAULT FALSE,
  scores                      JSONB NOT NULL DEFAULT '{}',             -- 8 dimension scores
  hard_gates_fired            JSONB DEFAULT '[]',                      -- e.g. [{name:'safety',forces:'reject',reason:'...'}]
  manual_review_recommended   BOOLEAN NOT NULL DEFAULT FALSE,
  next_action                 JSONB,                                   -- enhance/regenerate/publish/reject details + I2I prompts if applicable
  notes                       JSONB,                                   -- per-dimension single-sentence notes
  subject_phrase              TEXT,                                    -- subject lock used for I2I if enhance
  applied                     BOOLEAN NOT NULL DEFAULT FALSE,          -- did downstream pipeline actually act on this verdict
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_avr_biz_time ON asset_vetting_results (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_avr_verdict ON asset_vetting_results (verdict);
CREATE INDEX IF NOT EXISTS idx_avr_image ON asset_vetting_results (image_url);
ALTER TABLE asset_vetting_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "avr_service_full" ON asset_vetting_results;
CREATE POLICY "avr_service_full" ON asset_vetting_results FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "avr_owner_read" ON asset_vetting_results;
CREATE POLICY "avr_owner_read" ON asset_vetting_results FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = asset_vetting_results.business_id AND b.user_id = auth.uid())
);
