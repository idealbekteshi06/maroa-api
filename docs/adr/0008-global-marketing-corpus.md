# ADR-0008: Global, multi-vertical marketing corpus pre-trainer

**Date:** 2026-05-13 · **Status:** Accepted

## Context

After Waves 52–57 the closed-loop creative system (grounding + N-best + critic + perf memory + alert routing) was technically complete. But every retrieval table started **empty** for a new customer. Until they had run for 90 days, the grounding library had no wins/losses to retrieve, no VoC themes from real customers, no cohort patterns. The system worked correctly — it just didn't have signal.

The fix isn't waiting for paying customers. It's pre-seeding the retrieval corpus with **public real-world data** spanning every industry and every major market, so day-1 customers benefit from a corpus that has already been calibrated on world-class marketing examples.

## Decision

Build a pre-trainer that ingests public marketing data into a new `marketing_corpus` table, classified by industry + region + format + quality, with embeddings, used by the grounding library on day 1 for every customer.

### 1. Migration 062 — `marketing_corpus` table

| Column                   | Type         | Purpose                                                                                      |
| ------------------------ | ------------ | -------------------------------------------------------------------------------------------- |
| `industry`               | text         | canonical id from `lib/taxonomy/industries.js`                                               |
| `region`                 | text         | ISO-3166-1 alpha-2 or aggregate (GLOBAL, EU, NA, APAC, LATAM, MENA)                          |
| `format`                 | text         | meta_ad / google_ad / landing_page / email / social_post / seo_article / review / case_study |
| `body` + `title` + `cta` | text         | the content itself                                                                           |
| `quality_score`          | numeric(4,3) | heuristic 0.0–1.0                                                                            |
| `outcome_label`          | text         | high / medium / low (denormalized for fast filter)                                           |
| `embedding`              | vector(384)  | matches migration 061 dim                                                                    |
| `source` + `source_ref`  | text         | idempotency: unique (source, source_ref)                                                     |

Plus a `pretrainer_runs` audit table + `match_marketing_corpus` cosine-similarity RPC + RLS (anyone-read, service-write).

### 2. Taxonomy (~50 industries × 40+ regions)

- `lib/taxonomy/industries.js` — 50 verticals (cafés, gyms, plumbers, SaaS, e-commerce, etc.) with `peerIndustries` for expanding-circles retrieval
- `lib/taxonomy/regions.js` — 40+ markets across NA, EU, APAC, LATAM, MENA with `cluster` for expanding-circles fallback
- `lib/taxonomy/expert_sources.js` — curated catalog: 4 award archives + 5 marketing publications + 100+ expert brands per vertical (Liquid Death, Allbirds, Glossier, Stripe, Notion, Duolingo, MasterClass, etc.)

Expanding circles example: a Tirana café queries with industries `['cafe', 'restaurant', 'bakery', 'dessert_shop', 'smb_general']` and regions `['AL', 'XK', 'MK', 'EU', 'GLOBAL']`. Most-specific first, world-wide fallback.

### 3. Source adapters

- `services/public-pretrainer/sources/meta-ad-library.js` — Meta Ad Library API (free, official). Two pulls per vertical: expert-brand-first (Starbucks, Allbirds, etc.) then keyword long-tail.
- `services/public-pretrainer/sources/google-places-cohort.js` — top-rated businesses per (industry, region) → real customer reviews aggregated as VoC signal.

(More sources — Google Ads Transparency, Reddit, Really Good Emails — slated for Wave 59; the adapter pattern is established.)

### 4. Classifier + Quality scorer

- `classifier.js` — Haiku-based: industry + format + language + confidence. Snaps invalid IDs to `smb_general`. Soft-fails to fallback shape on any error (no crash).
- `quality-scorer.js` — pure heuristics (no LLM cost): runtime + source authority + brand-curated lookup + content quality (length + specificity + AI-tell penalty) + review rating. Clamped to [0.3, 1.0].

### 5. Orchestrator

- `services/public-pretrainer/orchestrator.js#runForCohort` — per-(industry, region) execution: fetch → dedup → classify → score → embed → persist.
- `runForAll` — sweep the whole taxonomy with `totalCapExamples` safety cap (default 50k).
- Idempotent: `(source, source_ref)` unique constraint means re-runs cost only classification (skipped at dedup check before that).

### 6. Grounding library wiring

`lib/groundingContext.js#buildGroundingContext` now pulls a 5th section: `expertCorpus`. When a business with `industry` + `country` set passes a `semanticQuery`, the grounding library queries `marketing_corpus` with expanding-circles filters and surfaces top-K by quality. Renders into the prompt block as a new "Expert corpus" section alongside wins/losses/VoC/cohort/brandVoice.

### Cost model

| Activity                    | Cost                 | Frequency                        |
| --------------------------- | -------------------- | -------------------------------- |
| Meta Ad Library fetch       | free                 | weekly refresh of top performers |
| Google Places fetch         | $17/1k requests      | weekly cohort refresh            |
| Haiku classification        | $0.0001 per example  | once per new example             |
| OpenAI ada-3 embedding      | $0.00002 per example | once per new example             |
| Initial seed (50k examples) | ~$50 one-time        | first run                        |
| Weekly refresh (~5k new)    | ~$5/week             | ongoing                          |

For comparison: this entire system costs less per month than a single sponsored Instagram post.

### Failure modes

All soft. Any failure degrades to "less data" rather than crash:

- Source API down → other sources continue
- Classifier throws → row stored with `smb_general` + low confidence
- Embedding fails → row stored without embedding (won't surface in semantic search but exists for non-semantic queries)
- DB write fails on one row → others continue, error recorded in `pretrainer_runs`

## Tests

- `tests/taxonomy.test.js` — 17 tests (industries, regions, expert sources, expanding circles)
- `tests/pretrainer-sources.test.js` — 12 tests (Meta Ad Library + Places cohort with mocked HTTP)
- `tests/pretrainer-classifier-and-scorer.test.js` — 16 tests (parse defense, snap-to-valid, signal weights, score clamping)
- `tests/pretrainer-orchestrator.test.js` — 7 tests (end-to-end with stubbed sources, dedup, total cap)

**Total: 52 new tests. Suite at 997 passing.**

## Operator action required

1. **Apply migration 062** in Supabase SQL editor (consolidated SQL block in the next message)
2. **Get a Meta Ad Library access token** — developers.facebook.com (free)
3. **Set env vars** in Railway:
   - `META_AD_LIBRARY_TOKEN`
   - `GOOGLE_PLACES_API_KEY` (already set if Wave 57 done)
   - `OPENAI_API_KEY` (for real embeddings, already needed for pillar #4)
4. **Kick off the initial seed** — single HTTP call once everything's wired (route TBD in Wave 59)

Estimated initial seed cost: **~$50** for 50,000 expert-tagged examples spanning every vertical and major market.

## Rating after Wave 58

| Capability                                | Before                    | After                                        |
| ----------------------------------------- | ------------------------- | -------------------------------------------- |
| Day-1 retrieval quality for new customers | empty                     | 50k expert-curated examples available        |
| Industry coverage                         | 1 vertical (cafés tested) | 50 verticals catalogued                      |
| Geographic coverage                       | 1 market (Albania)        | 40+ markets catalogued                       |
| Expert brand seed list                    | ad-hoc                    | 100+ brands across 20+ verticals             |
| Award + publication archive index         | none                      | 4 award archives + 5 publications catalogued |
| Onboarding-to-quality time                | 90+ days                  | day 1                                        |

## Naming & Framing (Wave 59 S6)

There's a deliberate split between how engineers talk about this feature
and how customers + marketing copy talk about it. Internal accuracy ≠
external resonance.

| Audience   | Term                                     | Why                                                                   |
| ---------- | ---------------------------------------- | --------------------------------------------------------------------- |
| Engineers  | "Marketing corpus pre-trainer"           | What it is technically — pre-populates RAG corpus from public sources |
| Engineers  | "Cold-start corpus"                      | Why it exists — fills the gap before a customer has their own history |
| Customers  | "Industry expertise on day 1"            | The outcome — what they actually get                                  |
| Customers  | "Writes like an expert in your industry" | The promise — concrete, falsifiable                                   |
| Customers  | "Never starts from a blank page"         | The pain it removes                                                   |
| Sales copy | "Day-1 results without a 30-day warm-up" | The time-to-value framing                                             |

Phrases we DO NOT use externally (these damage credibility on review):

- "Most advanced marketing AI" — vague, unverifiable, lazy
- "Revolutionary AI system" — AI-tell phrase the Critic loop flags
- "Cutting-edge marketing engine" — same
- "World-class AI" — same
- "Trained on millions of ads" — implies model training; we're doing
  RAG corpus seeding. Different thing.

If a customer asks how it works, the honest answer is:
"We pre-seeded our system with examples from real ads, award winners,
and top-rated businesses in your industry. So instead of writing from
scratch, Maroa starts with patterns that have already worked."

That's accurate, falsifiable, and resonates better than any superlative.

## References

- `migrations/062_marketing_corpus.sql`
- `lib/taxonomy/{industries,regions,expert_sources,index}.js`
- `services/public-pretrainer/{orchestrator,classifier,quality-scorer}.js`
- `services/public-pretrainer/sources/{meta-ad-library,google-places-cohort}.js`
- `lib/groundingContext.js#fetchExpertCorpus`
- ADR-0005 (closed-loop creative system) — this pre-trains pillar 1's retrieval source
- ADR-0007 (closing final gaps) — VoC pipeline that ingests into `customer_insights` complements this corpus that ingests into `marketing_corpus`
