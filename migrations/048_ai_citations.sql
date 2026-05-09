-- migrations/048_ai_citations.sql
-- ---------------------------------------------------------------------------
-- Week 9 — AI Search Citation Tracking
--
-- Logs every query Maroa runs against an AI search engine for a customer
-- (ChatGPT, Perplexity, Google AI Overviews, Claude, Gemini) and records
-- whether the customer's brand was cited, plus competitor share-of-voice.
-- ---------------------------------------------------------------------------

-- ─── Per-business prompt seed library ────────────────────────────────────
-- 15-20 industry-relevant queries auto-generated from business profile.
-- These are the queries we re-run daily against AI engines.
CREATE TABLE IF NOT EXISTS ai_citation_prompts (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  prompt_text     text          NOT NULL,
  prompt_intent   text          NOT NULL CHECK (prompt_intent IN ('discovery','comparison','recommendation','local_search','review','how_to','vs')),
  is_active       boolean       NOT NULL DEFAULT true,

  -- How was this prompt generated?
  source          text          NOT NULL DEFAULT 'auto'
                  CHECK (source IN ('auto','customer_added','agency_curated')),

  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_citation_prompts_business
  ON ai_citation_prompts (business_id) WHERE is_active = true;

-- ─── Citation runs (one per prompt × engine × day) ───────────────────────
-- The big append-only telemetry table. We never UPDATE rows here — every
-- run gets a fresh row so we can see drift over time.
CREATE TABLE IF NOT EXISTS ai_citations (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  prompt_id             uuid          NULL REFERENCES ai_citation_prompts(id) ON DELETE SET NULL,

  prompt_text           text          NOT NULL,
  engine                text          NOT NULL CHECK (engine IN ('chatgpt','perplexity','google_aio','claude','gemini','bing_copilot')),

  -- Did our brand get cited?
  brand_cited           boolean       NOT NULL DEFAULT false,
  brand_position        int           NULL,                        -- ordinal among citations (1 = first)
  brand_url_cited       text          NULL,

  -- Full result for analysis
  cited_urls            text[]        NOT NULL DEFAULT ARRAY[]::text[],
  competitor_citations  jsonb         NOT NULL DEFAULT '[]'::jsonb,  -- [{ name, position, url }, ...]
  response_summary      text          NULL,                        -- truncated AI response

  -- Cost tracking
  api_cost_usd          numeric(8,4)  NULL,
  api_source            text          NOT NULL CHECK (api_source IN ('dataforseo','perplexity_sonar','serpapi','direct_api','manual')),

  observed_at           timestamptz   NOT NULL DEFAULT now(),
  created_at            timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_citations_business
  ON ai_citations (business_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_citations_engine
  ON ai_citations (business_id, engine, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_citations_cited_only
  ON ai_citations (business_id, observed_at DESC) WHERE brand_cited = true;

-- ─── Reddit + YouTube presence audits ────────────────────────────────────
-- Reddit = 40% of LLM source data, YouTube = 16% (research). We track
-- whether the brand has any presence on these platforms because no llms.txt
-- alone moves citations — community presence does.
CREATE TABLE IF NOT EXISTS community_presence_audits (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  platform            text          NOT NULL CHECK (platform IN ('reddit','youtube','quora','twitter','medium')),

  -- What did we find?
  mention_count_30d   int           NOT NULL DEFAULT 0,
  positive_sentiment_pct numeric(4,3) NULL,
  channel_subscribers int           NULL,                          -- for YouTube
  subreddit_count     int           NULL,                          -- for Reddit

  raw_findings        jsonb         NOT NULL DEFAULT '{}'::jsonb,

  -- Verdict
  verdict             text          NOT NULL DEFAULT 'no_presence'
                      CHECK (verdict IN ('no_presence','weak','growing','established','strong')),
  recommendations     text[]        NOT NULL DEFAULT ARRAY[]::text[],

  observed_at         timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_community_presence_business
  ON community_presence_audits (business_id, platform, observed_at DESC);
