-- Migration 035: Anthropic Files API integration
--
-- Tracks files uploaded to Anthropic per business: brand guidelines, past
-- performance reports, content libraries, competitor analysis. Each business
-- can attach files to Claude calls by reference instead of re-injecting
-- 5-10k chars of brand context per call. Pairs with prompt caching.
--
-- Anthropic Files API spec: 500MB per file, 500GB per organization, files
-- persist until explicitly deleted, free for upload/list/delete (only
-- inference-time use is billed).
-- ============================================================================

CREATE TABLE IF NOT EXISTS anthropic_files (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              UUID NOT NULL,
  anthropic_file_id        TEXT NOT NULL,                              -- file_011CN... from Anthropic
  filename                 TEXT NOT NULL,
  mime_type                TEXT,
  size_bytes               BIGINT,
  kind                     TEXT NOT NULL DEFAULT 'brand_guidelines',  -- brand_guidelines|past_performance|content_library|competitor_analysis|custom
  description              TEXT,
  is_default               BOOLEAN NOT NULL DEFAULT FALSE,            -- attach to every Claude call for this business
  uploaded_by_user_id      UUID,
  use_count                INTEGER NOT NULL DEFAULT 0,
  last_used_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_anthropic_files_biz ON anthropic_files (business_id);
CREATE INDEX IF NOT EXISTS idx_anthropic_files_kind ON anthropic_files (business_id, kind);
CREATE INDEX IF NOT EXISTS idx_anthropic_files_default ON anthropic_files (business_id, is_default) WHERE is_default = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_anthropic_files_anthropic_id ON anthropic_files (anthropic_file_id);
ALTER TABLE anthropic_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anthropic_files_service_full" ON anthropic_files;
CREATE POLICY "anthropic_files_service_full" ON anthropic_files FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anthropic_files_owner_read" ON anthropic_files;
CREATE POLICY "anthropic_files_owner_read" ON anthropic_files FOR SELECT USING (
  EXISTS (SELECT 1 FROM businesses b WHERE b.id = anthropic_files.business_id AND b.user_id = auth.uid())
);
