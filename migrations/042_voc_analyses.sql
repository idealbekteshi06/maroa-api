-- Migration 042 — voc_analyses
CREATE TABLE IF NOT EXISTS voc_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  analyzed_at TIMESTAMPTZ DEFAULT NOW(),
  source_count JSONB DEFAULT '{}',
  total_reviews_analyzed INTEGER,
  primary_language TEXT,
  review_languages_detected JSONB DEFAULT '[]',
  pain_points JSONB DEFAULT '[]',
  jtbd_signals JSONB DEFAULT '[]',
  persona_refinement JSONB,
  sentiment JSONB,
  competitor_mentions JSONB DEFAULT '[]',
  recommendations_for_marketing JSONB DEFAULT '[]',
  data_quality TEXT CHECK (data_quality IN ('good','limited','minimal','insufficient')),
  caveats JSONB DEFAULT '[]',
  short_circuited BOOLEAN DEFAULT FALSE,
  short_circuit_reason TEXT,
  plan_used TEXT
);
ALTER TABLE voc_analyses ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE voc_analyses ADD COLUMN IF NOT EXISTS source_count JSONB DEFAULT '{}';
ALTER TABLE voc_analyses ADD COLUMN IF NOT EXISTS total_reviews_analyzed INTEGER;
ALTER TABLE voc_analyses ADD COLUMN IF NOT EXISTS primary_language TEXT;
ALTER TABLE voc_analyses ADD COLUMN IF NOT EXISTS review_languages_detected JSONB DEFAULT '[]';
ALTER TABLE voc_analyses ADD COLUMN IF NOT EXISTS pain_points JSONB DEFAULT '[]';
ALTER TABLE voc_analyses ADD COLUMN IF NOT EXISTS jtbd_signals JSONB DEFAULT '[]';
ALTER TABLE voc_analyses ADD COLUMN IF NOT EXISTS persona_refinement JSONB;
ALTER TABLE voc_analyses ADD COLUMN IF NOT EXISTS sentiment JSONB;
ALTER TABLE voc_analyses ADD COLUMN IF NOT EXISTS competitor_mentions JSONB DEFAULT '[]';
ALTER TABLE voc_analyses ADD COLUMN IF NOT EXISTS recommendations_for_marketing JSONB DEFAULT '[]';
ALTER TABLE voc_analyses ADD COLUMN IF NOT EXISTS data_quality TEXT;
ALTER TABLE voc_analyses ADD COLUMN IF NOT EXISTS caveats JSONB DEFAULT '[]';
ALTER TABLE voc_analyses ADD COLUMN IF NOT EXISTS short_circuited BOOLEAN DEFAULT FALSE;
ALTER TABLE voc_analyses ADD COLUMN IF NOT EXISTS short_circuit_reason TEXT;
ALTER TABLE voc_analyses ADD COLUMN IF NOT EXISTS plan_used TEXT;

CREATE INDEX IF NOT EXISTS idx_voc_analyses_business ON voc_analyses(business_id);
CREATE INDEX IF NOT EXISTS idx_voc_analyses_analyzed_at ON voc_analyses(analyzed_at DESC);

ALTER TABLE voc_analyses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_full_voc_analyses" ON voc_analyses;
CREATE POLICY "service_full_voc_analyses" ON voc_analyses FOR ALL USING (true) WITH CHECK (true);
