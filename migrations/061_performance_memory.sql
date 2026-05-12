-- migrations/061_performance_memory.sql
--
-- Pillar #4 of the closed-loop creative system (ADR-0005).
-- pgvector-backed semantic search over historical content + outcomes.
--
-- Before applying:
--   1. Verify the `vector` extension is available in your Supabase project
--      (Project → Database → Extensions → `vector`). Enable it.
--   2. Pick an embedding model. The library expects a 384-dim vector by
--      default (matches our stub embedding). When swapping in OpenAI ada-3
--      (1536-dim) or sentence-transformers (768-dim), change the column
--      type below + the HNSW index dim accordingly.
--
-- Cost notes:
--   - The HNSW index is the expensive piece. ~50MB per 100k rows at 384d.
--   - Search cost is O(log N) — sub-millisecond up to a few million rows.
--
-- Rollback strategy:
--   The library degrades gracefully to LRU mode if these tables don't
--   exist. If this migration causes problems, just `DROP TABLE
--   content_embeddings` and the lib auto-falls back to LRU.

BEGIN;

-- ─── 1. Enable pgvector ─────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── 2. Embeddings table ────────────────────────────────────────────────
-- One row per piece of customer-facing content the business has shipped.
-- Lives alongside generated_content + ad_performance_logs — populated by
-- a trigger or by the embed-on-write code path.
--
-- We store:
--   - the embedding (vector(384))
--   - the source (which table the row came from)
--   - the source_id (FK to that row)
--   - the outcome signal (ROAS, engagement_score, etc.) for ranking
--   - the surface so we can filter at query time
CREATE TABLE IF NOT EXISTS content_embeddings (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid          NOT NULL,
  surface         text          NOT NULL CHECK (surface IN ('social_post','ad_copy','email','seo','landing_page','caption')),
  source          text          NOT NULL CHECK (source IN ('generated_content','ad_performance_logs','content_assets')),
  source_id       uuid          NOT NULL,
  -- The actual text that was embedded. Stored so we can show it back
  -- without joining to the source table (saves a round-trip).
  text            text          NOT NULL,
  -- 384-dim embedding. Resize this if you swap in a different model.
  embedding       vector(384)   NOT NULL,
  -- Outcome signal. ROAS for ads, engagement_score (0..1) for content.
  outcome_score   numeric(8,4)  NULL,
  outcome_label   text          NULL, -- 'win' | 'loss' | 'neutral' (denormalized for fast filter)
  created_at      timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (business_id, source, source_id)
);

CREATE INDEX IF NOT EXISTS content_embeddings_business_surface_idx
  ON content_embeddings (business_id, surface);

CREATE INDEX IF NOT EXISTS content_embeddings_outcome_idx
  ON content_embeddings (business_id, surface, outcome_score DESC);

-- HNSW index for cosine similarity search. m=16 is the standard tradeoff;
-- ef_construction=64 keeps build time reasonable on Supabase free tier.
CREATE INDEX IF NOT EXISTS content_embeddings_hnsw_cos_idx
  ON content_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ─── 3. Search RPC ──────────────────────────────────────────────────────
-- The library calls this via PostgREST RPC. Wraps the cosine-similarity
-- search + business + surface + direction filter in a single round-trip.
CREATE OR REPLACE FUNCTION match_content_embeddings(
  p_business_id   uuid,
  p_query         vector(384),
  p_surface       text,
  p_direction     text DEFAULT 'both',  -- 'wins' | 'losses' | 'both'
  p_k             int  DEFAULT 5
)
RETURNS TABLE (
  id              uuid,
  text            text,
  outcome_score   numeric,
  similarity      float
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    ce.id,
    ce.text,
    ce.outcome_score,
    1 - (ce.embedding <=> p_query) AS similarity
  FROM content_embeddings ce
  WHERE ce.business_id = p_business_id
    AND ce.surface = p_surface
    AND (
      p_direction = 'both'
      OR (p_direction = 'wins'   AND ce.outcome_label = 'win')
      OR (p_direction = 'losses' AND ce.outcome_label = 'loss')
    )
  ORDER BY ce.embedding <=> p_query ASC
  LIMIT p_k;
$$;

-- ─── 4. RLS — businesses see only their own embeddings ──────────────────
ALTER TABLE content_embeddings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS content_embeddings_owner_read ON content_embeddings;
CREATE POLICY content_embeddings_owner_read ON content_embeddings
  FOR SELECT
  USING (
    business_id IN (
      SELECT id FROM businesses
      WHERE user_id = auth.uid() OR id = auth.uid()
    )
  );

-- Service role bypasses RLS (server.js uses service-role key). No INSERT
-- policy needed for end-users — embeddings are written server-side only.

-- ─── 5. Ledger ──────────────────────────────────────────────────────────
INSERT INTO _migrations (filename, checksum, applied_at)
VALUES (
  '061_performance_memory.sql',
  'wave54_pgvector_rag_over_content_outcomes_v1',
  now()
)
ON CONFLICT (filename) DO NOTHING;

COMMIT;
