-- Migration 033: Soul ID — business_characters
--
-- Stores trained Higgsfield Soul ID characters per business. Each business can
-- train multiple characters (founder, mascot, model_persona, customer_proxy).
-- Once trained, character_id is reused across every image/video generation
-- to lock identity consistency.
--
-- Apply in Supabase SQL editor. Idempotent — safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS business_characters (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              UUID NOT NULL,
  name                     TEXT NOT NULL,                             -- 'founder', 'mascot', 'sarah_persona', etc.
  character_type           TEXT NOT NULL DEFAULT 'founder',           -- founder|mascot|model_persona|customer_proxy|other
  higgsfield_character_id  TEXT,                                      -- soul_character_id returned by Higgsfield create-character API
  training_status          TEXT NOT NULL DEFAULT 'pending',           -- pending|uploading|training|ready|failed
  source_image_urls        JSONB NOT NULL DEFAULT '[]',               -- 1-5 reference photos (Higgsfield requires 1-5; 20+ for best Soul ID)
  source_image_count       INTEGER NOT NULL DEFAULT 0,
  training_started_at      TIMESTAMPTZ,
  trained_at               TIMESTAMPTZ,
  training_error           TEXT,
  credit_cost              INTEGER DEFAULT 40,                        -- Higgsfield charges ~40 credits ≈ $2.50/character
  is_default               BOOLEAN NOT NULL DEFAULT FALSE,            -- one default per business — used when no character_id specified
  last_used_at             TIMESTAMPTZ,
  use_count                INTEGER NOT NULL DEFAULT 0,
  metadata                 JSONB DEFAULT '{}',                        -- description, demographics, brand notes
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_business_characters_biz ON business_characters (business_id);
CREATE INDEX IF NOT EXISTS idx_business_characters_status ON business_characters (training_status);
CREATE INDEX IF NOT EXISTS idx_business_characters_default ON business_characters (business_id, is_default) WHERE is_default = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_business_characters_default
  ON business_characters (business_id) WHERE is_default = TRUE;
ALTER TABLE business_characters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "business_characters_service_full" ON business_characters;
CREATE POLICY "business_characters_service_full" ON business_characters FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "business_characters_owner_read" ON business_characters;
CREATE POLICY "business_characters_owner_read" ON business_characters FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = business_characters.business_id AND b.user_id = auth.uid())
);

-- ─── Optional: assets can reference which character was used ─────────────────
ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS character_id UUID REFERENCES business_characters(id);
CREATE INDEX IF NOT EXISTS idx_content_assets_character ON content_assets (character_id);
