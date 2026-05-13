-- migrations/062_marketing_corpus.sql
--
-- The global pre-trained marketing corpus. Pre-populates the closed-loop
-- creative system's retrieval layer with real-world expert-sourced examples
-- spanning every industry and major market, so day-1 customers retrieve
-- against a high-quality corpus instead of an empty table.
--
-- Wave 58 (ADR-0008). Builds on:
--   - 061_performance_memory.sql      (pgvector extension + content_embeddings)
--   - 057_jsonb_gin_indexes.sql       (GIN indexing pattern for filters)
--
-- Storage scope: designed to hold up to ~1M examples comfortably. At 384-dim
-- embeddings that's roughly 1.5 GB of pgvector storage — well within
-- Supabase's standard tier.

BEGIN;

-- ─── 1. The corpus table ─────────────────────────────────────────────────
-- One row per ingested example. Spans ads, landing pages, emails, social
-- posts, SEO content — discriminated by `format`. Each row carries provenance
-- (where we got it), classification tags (industry/region), quality score
-- (how confident we are it's a "good" example), and its embedding.
CREATE TABLE IF NOT EXISTS marketing_corpus (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── Provenance ─────────────────────────────────────────────────────
  source               text          NOT NULL CHECK (source IN (
                         'meta_ad_library',
                         'google_ads_transparency',
                         'serp_corpus',
                         'google_places_cohort',
                         'really_good_emails',
                         'reddit_marketing',
                         'marketing_examined',
                         'manual_curation'
                       )),
  source_url           text          NULL,
  source_ref           text          NULL,   -- the platform's native ID
  fetched_at           timestamptz   NOT NULL DEFAULT now(),

  -- ── Classification (Haiku-assigned) ────────────────────────────────
  industry             text          NOT NULL,   -- 'cafe', 'gym', 'saas_b2b', etc. (see taxonomy)
  sub_industry         text          NULL,
  region               text          NOT NULL,   -- ISO-3166-1 alpha-2 ('US', 'AL', 'GB'); 'GLOBAL' allowed
  locale               text          NULL,       -- 'en-US', 'sq-AL' if known
  format               text          NOT NULL CHECK (format IN (
                         'meta_ad', 'google_ad', 'landing_page',
                         'email', 'social_post', 'seo_article',
                         'review', 'case_study'
                       )),

  -- ── Content ────────────────────────────────────────────────────────
  title                text          NULL,        -- subject / headline / page title
  body                 text          NOT NULL,    -- the actual content
  cta                  text          NULL,
  visual_brief         text          NULL,        -- what the image/video shows (for ads)
  language             text          NULL,

  -- ── Quality + outcome signal ───────────────────────────────────────
  -- 0.0–1.0. Higher = more confident this is a "good example".
  -- Heuristics: runtime, spend tier, brand recognition, award status,
  -- reviewer-curated lists. See services/public-pretrainer/quality-scorer.js
  quality_score        numeric(4,3)  NOT NULL DEFAULT 0.5,
  quality_signals      jsonb         NULL,        -- {runtime_days: 90, award: 'Effie 2024', spend_tier: 'high'}

  -- Outcome inference (best guess from public signals — not direct
  -- performance data because that's private). 'high' / 'medium' / 'low'.
  outcome_label        text          NULL CHECK (outcome_label IN ('high','medium','low')),

  -- ── Embedding (set by pre-trainer pipeline AFTER classification) ───
  -- Matches migration 061's vector(384) so the existing
  -- match_content_embeddings RPC works against this table too.
  embedding            vector(384)   NULL,

  -- ── Metadata ───────────────────────────────────────────────────────
  taxonomy_version     text          NOT NULL DEFAULT 'v1',
  metadata             jsonb         NULL,        -- arbitrary source-specific extras

  UNIQUE (source, source_ref)
);

-- Filter indexes — the grounding library queries are:
--   "give me top-K marketing_corpus rows where industry IN (...)
--    AND region IN (...) AND format = ... ORDER BY embedding <=> $vec"
CREATE INDEX IF NOT EXISTS marketing_corpus_industry_region_idx
  ON marketing_corpus (industry, region, format);

CREATE INDEX IF NOT EXISTS marketing_corpus_quality_idx
  ON marketing_corpus (industry, region, quality_score DESC);

CREATE INDEX IF NOT EXISTS marketing_corpus_fetched_at_idx
  ON marketing_corpus (fetched_at DESC);

-- HNSW index for cosine similarity search. Same params as content_embeddings.
-- Built only when there are rows — empty HNSW is wasteful.
CREATE INDEX IF NOT EXISTS marketing_corpus_hnsw_cos_idx
  ON marketing_corpus USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ─── 2. Search RPC ────────────────────────────────────────────────────────
-- The grounding library calls this when a customer needs examples. The
-- "expanding circles" pattern: prefer regional matches, fall back to global.
-- The caller supplies an ordered list of acceptable regions; we return the
-- best matches respecting that priority.
CREATE OR REPLACE FUNCTION match_marketing_corpus(
  p_query           vector(384),
  p_industries      text[],            -- ordered: most-specific first
  p_regions         text[],            -- ordered: most-specific first
  p_format          text,
  p_min_quality     numeric DEFAULT 0.6,
  p_k               int     DEFAULT 5
)
RETURNS TABLE (
  id              uuid,
  title           text,
  body            text,
  cta             text,
  industry        text,
  region          text,
  quality_score   numeric,
  similarity      float,
  source          text
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    mc.id,
    mc.title,
    mc.body,
    mc.cta,
    mc.industry,
    mc.region,
    mc.quality_score,
    1 - (mc.embedding <=> p_query) AS similarity,
    mc.source
  FROM marketing_corpus mc
  WHERE mc.format = p_format
    AND mc.industry = ANY(p_industries)
    AND mc.region   = ANY(p_regions)
    AND mc.quality_score >= p_min_quality
    AND mc.embedding IS NOT NULL
  ORDER BY mc.embedding <=> p_query ASC
  LIMIT p_k;
$$;

-- ─── 3. RLS ──────────────────────────────────────────────────────────────
-- The corpus is GLOBAL (not customer-specific) — every business reads from
-- it. So RLS is "anyone authenticated can read; only service_role writes".
ALTER TABLE marketing_corpus ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marketing_corpus_anyone_read    ON marketing_corpus;
DROP POLICY IF EXISTS marketing_corpus_service_write  ON marketing_corpus;

CREATE POLICY marketing_corpus_anyone_read ON marketing_corpus
  FOR SELECT TO authenticated, anon
  USING (true);

CREATE POLICY marketing_corpus_service_write ON marketing_corpus
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- ─── 4. Run history (for idempotency + monitoring) ────────────────────────
-- Tracks each pre-trainer execution so we can skip already-ingested batches
-- and surface the freshness of each (industry, region, source) tuple.
CREATE TABLE IF NOT EXISTS pretrainer_runs (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  source            text          NOT NULL,
  industry          text          NULL,
  region            text          NULL,
  started_at        timestamptz   NOT NULL DEFAULT now(),
  finished_at       timestamptz   NULL,
  examples_fetched  int           NOT NULL DEFAULT 0,
  examples_kept     int           NOT NULL DEFAULT 0,   -- after dedup + quality filter
  examples_skipped  int           NOT NULL DEFAULT 0,
  cost_usd_cents    int           NOT NULL DEFAULT 0,   -- classifier + embedding cost
  status            text          NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','partial','failed')),
  error_message     text          NULL
);

CREATE INDEX IF NOT EXISTS pretrainer_runs_source_industry_region_idx
  ON pretrainer_runs (source, industry, region, started_at DESC);

ALTER TABLE pretrainer_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pretrainer_runs_service ON pretrainer_runs;
CREATE POLICY pretrainer_runs_service ON pretrainer_runs
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- ─── 5. Ledger ────────────────────────────────────────────────────────────
INSERT INTO _migrations (filename, checksum, applied_at)
VALUES (
  '062_marketing_corpus.sql',
  'wave58_global_marketing_corpus_v1',
  now()
)
ON CONFLICT (filename) DO NOTHING;

COMMIT;
