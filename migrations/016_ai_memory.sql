-- Migration 016: AI Memory System — learns from every interaction
CREATE TABLE IF NOT EXISTS ai_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  memory_type TEXT NOT NULL,
  content_snippet TEXT,
  platform TEXT,
  action TEXT,
  metrics JSONB DEFAULT '{}',
  learned_pattern TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_user ON ai_memory(user_id);
CREATE INDEX IF NOT EXISTS idx_memory_type ON ai_memory(memory_type);
ALTER TABLE ai_memory ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_memory" ON ai_memory FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
