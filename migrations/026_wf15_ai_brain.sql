-- Migration 026: Workflow #15 — AI Brain (Conversational Command Center)
-- ============================================================================

-- brain_conversations: one per conversation thread
CREATE TABLE IF NOT EXISTS brain_conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL,
  title         TEXT,
  message_count INT DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brain_conv_biz ON brain_conversations (business_id, last_message_at DESC);
ALTER TABLE brain_conversations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brain_conv_service_full" ON brain_conversations;
CREATE POLICY "brain_conv_service_full" ON brain_conversations FOR ALL TO service_role USING (true) WITH CHECK (true);

-- brain_messages: every turn
CREATE TABLE IF NOT EXISTS brain_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES brain_conversations(id) ON DELETE CASCADE,
  business_id     UUID NOT NULL,
  role            TEXT NOT NULL,          -- user | assistant | system | tool
  content         TEXT NOT NULL,
  attachments     JSONB DEFAULT '[]',
  tool_calls      JSONB DEFAULT '[]',
  reasoning       TEXT,
  model_used      TEXT,                    -- haiku | sonnet | opus
  cost_usd        NUMERIC(10,4),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brain_msg_conv ON brain_messages (conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_brain_msg_biz ON brain_messages (business_id, created_at DESC);
ALTER TABLE brain_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brain_msg_service_full" ON brain_messages;
CREATE POLICY "brain_msg_service_full" ON brain_messages FOR ALL TO service_role USING (true) WITH CHECK (true);

-- brain_tool_calls: individual tool invocations (detailed state tracking)
CREATE TABLE IF NOT EXISTS brain_tool_calls (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      UUID REFERENCES brain_messages(id) ON DELETE CASCADE,
  business_id     UUID NOT NULL,
  tool            TEXT NOT NULL,
  input_summary   TEXT,
  input           JSONB,
  status          TEXT NOT NULL DEFAULT 'pending',
  progress        JSONB,
  result          JSONB,
  error           TEXT,
  rationale       TEXT,
  alternatives_considered JSONB,
  requires_approval BOOLEAN DEFAULT false,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_brain_tool_biz_status ON brain_tool_calls (business_id, status);
CREATE INDEX IF NOT EXISTS idx_brain_tool_message ON brain_tool_calls (message_id);
ALTER TABLE brain_tool_calls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brain_tool_service_full" ON brain_tool_calls;
CREATE POLICY "brain_tool_service_full" ON brain_tool_calls FOR ALL TO service_role USING (true) WITH CHECK (true);

-- brain_attachments: multimodal upload tracking
CREATE TABLE IF NOT EXISTS brain_attachments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  modality     TEXT NOT NULL,   -- voice | image | url | file
  url          TEXT NOT NULL,
  mime_type    TEXT,
  name         TEXT,
  transcription TEXT,
  ocr_text     TEXT,
  scraped_summary TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE brain_attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brain_attach_service_full" ON brain_attachments;
CREATE POLICY "brain_attach_service_full" ON brain_attachments FOR ALL TO service_role USING (true) WITH CHECK (true);

-- brain_memory: medium-term learned preferences per business
CREATE TABLE IF NOT EXISTS brain_memory (
  business_id   UUID PRIMARY KEY,
  owner_preferences JSONB DEFAULT '{}',
  recent_learnings JSONB DEFAULT '[]',
  long_term_summary TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE brain_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brain_memory_service_full" ON brain_memory;
CREATE POLICY "brain_memory_service_full" ON brain_memory FOR ALL TO service_role USING (true) WITH CHECK (true);
