-- Migration 084 — Agency Soul ID per business (WF10)
CREATE TABLE IF NOT EXISTS soul_ids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL UNIQUE,
  higgsfield_soul_id TEXT NOT NULL,
  character_name TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_soul_ids_business ON soul_ids(business_id);

ALTER TABLE soul_ids ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "soul_ids_service_full" ON soul_ids;
CREATE POLICY "soul_ids_service_full" ON soul_ids FOR ALL TO service_role USING (true) WITH CHECK (true);
