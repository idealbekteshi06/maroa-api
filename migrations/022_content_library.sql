-- content_library: Higgsfield / product catalog generated assets
CREATE TABLE IF NOT EXISTS content_library (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  business_id UUID,
  product_id UUID,
  content_type TEXT NOT NULL,
  file_url TEXT NOT NULL,
  caption TEXT,
  hashtags TEXT,
  platform TEXT,
  content_score NUMERIC(3,1),
  score_breakdown JSONB,
  status TEXT DEFAULT 'scheduled',
  scheduled_at TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_library_user_id ON content_library(user_id);
CREATE INDEX IF NOT EXISTS idx_content_library_status ON content_library(status);
CREATE INDEX IF NOT EXISTS idx_content_library_scheduled_at ON content_library(scheduled_at);

ALTER TABLE content_library ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users can manage own content" ON content_library;
CREATE POLICY "users can manage own content"
  ON content_library FOR ALL
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "service role full access" ON content_library;
CREATE POLICY "service role full access"
  ON content_library FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
