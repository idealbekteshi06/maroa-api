-- Migration 043 — brand_voice_anchor + history
-- ----------------------------------------------------------------------------

-- Add column to existing business_profiles (idempotent)
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS brand_voice_anchor JSONB;
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS brand_voice_regenerated_at TIMESTAMPTZ;

-- History table (rollback support — keep last N anchors per business)
CREATE TABLE IF NOT EXISTS brand_voice_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  anchor JSONB NOT NULL,
  derived_from JSONB DEFAULT '[]',
  confidence TEXT,
  version INTEGER
);
ALTER TABLE brand_voice_history ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE brand_voice_history ADD COLUMN IF NOT EXISTS anchor JSONB;
ALTER TABLE brand_voice_history ADD COLUMN IF NOT EXISTS derived_from JSONB DEFAULT '[]';
ALTER TABLE brand_voice_history ADD COLUMN IF NOT EXISTS confidence TEXT;
ALTER TABLE brand_voice_history ADD COLUMN IF NOT EXISTS version INTEGER;

CREATE INDEX IF NOT EXISTS idx_brand_voice_history_business ON brand_voice_history(business_id);
CREATE INDEX IF NOT EXISTS idx_brand_voice_history_generated_at ON brand_voice_history(generated_at DESC);

ALTER TABLE brand_voice_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_full_brand_voice_history" ON brand_voice_history;
CREATE POLICY "service_full_brand_voice_history" ON brand_voice_history FOR ALL USING (true) WITH CHECK (true);
