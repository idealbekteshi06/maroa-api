# ADR-0005: Closed-Loop Creative System (Grounding → N-best → Critic)

**Date:** 2026-05-12 · **Status:** Accepted

## Context

Single-shot LLM generation produces output bounded by the model's prior, not by what actually works for _this_ business. Two specific failure modes drove this ADR:

1. **Generic output** — content/ads/SEO that "could be for any cafe", because the model only sees the brand voice anchor and a generic prompt, not the business's actual wins, losses, or VoC.
2. **No creative diversity** — generating 3 variants per day in sequence gives 3 angles; what an agency does is brainstorm 30+ and pick 3. Humans don't because brainstorming is slow; LLMs can do it in parallel.

The Adversarial Critic loop (ADR not written — see [LEARNINGS.md](../../LEARNINGS.md) and `lib/adversarialCritic.js`) catches bad output. But the upstream lever — feeding the model real signal _before_ it writes — was missing.

## Decision

Implement a 5-pillar closed-loop creative system. Three pillars are now in code; two are next-wave:

| #   | Pillar                        | File                                                                 | Status                                               |
| --- | ----------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | Grounding Context             | `lib/groundingContext.js`                                            | shipped (Wave 53)                                    |
| 2   | N-best + Reranker             | `lib/nBestReranker.js`                                               | shipped (Wave 53)                                    |
| 3   | Adversarial Critic            | `lib/adversarialCritic.js`                                           | shipped (Wave 52)                                    |
| 4   | Performance Memory (pgvector) | `lib/performanceMemory.js` + `migrations/061_performance_memory.sql` | shipped (Wave 54 — migration pending operator apply) |
| 5   | Closed-loop prompt update     | `services/wf1/learningLoop.js` extension                             | pending Wave 56                                      |

### Wave 55: Output-quality boosters (built atop the 5 pillars)

Four additional libraries that compound with the pillars to produce
human-expert-grade output:

| Lib                                   | Purpose                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `services/voc-scraper/index.js`       | Extracts real customer phrases from raw reviews (Google / Trustpilot / competitor 1-stars). Writes structured rows to `customer_insights` — grounding library reads them automatically. No new wiring.                                                                                           |
| `lib/nBestReranker.js#ANGLE_TAXONOMY` | 8-angle psychological diversity for N-best generation (mainstream / contrarian / fomo / social_proof / authority / curiosity / reciprocity / specificity). Forces creative diversity at the prompt level, not via temperature noise.                                                             |
| `lib/strategicThinking.js`            | Opt-in chain-of-thought wrapper. Auto-selects native extended-thinking on Sonnet 4.5+ / Opus 4.7+; falls back to `<strategy>...</strategy>` tag prompting on older models. Use for high-stakes generations only (wf1 strategic phase, critic rewrite, judge ranking) — NOT in core `callClaude`. |
| `services/ai-seo/serp-outliner.js`    | SERP-driven 10x outline: top-5 ranking pages → gap analysis → 10x outline → section-by-section write. Agency-tier only (each article ~$0.15–0.30).                                                                                                                                               |

**Why these and not Antigravity's verbatim suggestions:**

- VoC injection: Antigravity suggested a separate VoC system. We already have `customer_insights` + grounding wired — the only missing piece was raw-review extraction. So we built the extraction, not a parallel system.
- `<thinking>` tags: Antigravity suggested injecting these into core `callClaude`. Doing so would double token costs on 50+ surfaces, many of which don't need reasoning (classification, hashtags, scoring). We built an opt-in wrapper instead. Selective deployment.
- Contrarian angles: Antigravity treated it as a separate prompt. We treated it as one entry in a curated angle taxonomy, plugged into the existing N-best library. No new code path.
- SERP outliner: this one we built closer to Antigravity's spec because it's a real new capability (SerpAPI integration, section-by-section).

### Pillar #4: Performance Memory (Wave 54)

Two backends, picked at runtime:

- **pgvector** (preferred, after migration 061 is applied): 384-dim embeddings stored in `content_embeddings` with HNSW index. Query via `match_content_embeddings(business_id, query_vec, surface, direction, k)` RPC. O(log N) latency, scales to millions of rows.
- **In-process LRU** (fallback, no Supabase migration needed): fetch recent rows from `generated_content` / `ad_performance_logs`, score by Jaccard token overlap with query, cache 5min per (business, surface). Less precise but ship-able today.

The library auto-detects which backend is available via `init()` → probes for the `content_embeddings` table. If the probe throws, falls back to LRU silently. **The grounding library calls `performanceMemory.findSimilar()` whenever a `semanticQuery` is supplied, and falls back to recency-based wins/losses otherwise.** Surfaces that don't pass a semanticQuery (like the initial wf1 retrofit) keep working unchanged; surfaces that opt-in get RAG-quality results once migration 061 is applied.

**Where pgvector helps most:** the creative-engine retrofit (Wave 53) currently grounds variant generation in _recent_ wins/losses. After migration 061, those become _semantically-similar_ wins/losses — "find ads that worked for similar audiences with similar hooks," not just "find recent ads." Same library API, dramatically better signal.

**Embedding vendor:** TBD. The lib ships with a deterministic token-hash stub (384-dim, L2-normalized) for tests. Production needs a real embedding model — candidates are OpenAI ada-3 (1536-dim, $0.13/M tokens) or self-hosted sentence-transformers. Decision deferred to operator; the lib's `embed()` is the only swap-out point.

**Pipeline:**

```
grounding (wins+losses+VoC+cohort+brand)
     │
     ▼
oversample 2× candidates (in parallel)
     │
     ▼
N-best judge (Haiku, JSON rankings)
     │
     ▼
top-K candidates
     │
     ▼
Adversarial Critic loop (Haiku critique, Sonnet rewrite)
     │
     ▼
ship
```

**Cost model per surface per business per day** (growth tier, K=3, oversample=6):

- 6× Sonnet variant generation: ~$0.018
- 1× Haiku judge call: ~$0.001
- 3× Haiku critic + (worst case) 3× Sonnet rewrite: ~$0.012
- **Total: ~$0.031/day** — 2% of the $1.50/day cost guard.

The same cost discipline applies to all five surfaces (`social_post`, `ad_copy`, `email`, `seo`, `landing_page`).

## Why this works against agencies

| Capability                        | Agency                        | Maroa with closed-loop              |
| --------------------------------- | ----------------------------- | ----------------------------------- |
| Creative diversity per generation | 3 angles brainstormed         | 6–10 angles judged                  |
| Memory of past performance        | senior CD's recall            | every win + loss in the prompt      |
| Customer voice integration        | quarterly VoC review          | active VoC themes in every prompt   |
| Cohort intelligence               | rare cross-account synthesis  | top-2 cohort patterns auto-injected |
| QA before ship                    | first-draft ships if deadline | Critic loop on every piece          |
| Cost per piece                    | $50–500                       | $0.03                               |
| Latency                           | hours-days                    | seconds                             |

Agencies cannot match this on cost or latency, and a senior creative director cannot read 50,000 past ads in 200ms to find what worked.

## Failure modes and fallbacks

Every stage degrades gracefully — partial signal is better than no signal.

| Failure                                      | Fallback                                            |
| -------------------------------------------- | --------------------------------------------------- |
| `buildGroundingContext` Supabase query fails | empty block prepended (existing prompt still works) |
| Single section (wins / VoC / cohort) fails   | other sections still render                         |
| N-best judge returns malformed JSON          | insertion order ships top-K                         |
| N-best judge throws                          | insertion order ships top-K                         |
| Adversarial Critic throws                    | original draft ships                                |
| Adversarial Critic marks `pass`              | no rewrite call (saves cost)                        |

## Plan gating

| Tier   | Variants/day | N-best oversample     | Critic surfaces          |
| ------ | ------------ | --------------------- | ------------------------ |
| free   | 0            | n/a                   | n/a (engine doesn't run) |
| growth | 3            | 6 candidates → top-3  | body                     |
| agency | 5            | 10 candidates → top-5 | body + headline          |

## Consequences

**Good:**

- Output specificity rises measurably (telemetry: `critic_kept_original_total` rate should rise over weeks as the grounded copywriter improves)
- Per-customer compute cost stays under the existing cost guard
- A clean library boundary lets us retrofit any surface (`wf1` content pipeline next)
- Telemetry counters (`nbest_runs_total`, `critic_runs_total`) let us A/B test "with vs. without grounding"

**Tradeoffs:**

- Variant generation latency: was ~3s/variant, now ~6s/batch (oversample + judge runs in parallel)
- Per-business cost: was ~$0.015/day, now ~$0.031/day
- Library complexity: 3 libraries instead of inline prompts (offset by 35 + 21 + 14 = 70 tests covering them)

## References

- [`lib/groundingContext.js`](../../lib/groundingContext.js)
- [`lib/nBestReranker.js`](../../lib/nBestReranker.js)
- [`lib/adversarialCritic.js`](../../lib/adversarialCritic.js)
- [`services/creative-engine/index.js`](../../services/creative-engine/index.js) — first surface to adopt all 3 pillars
- Reflexion paper (Shinn et al. 2023) — the academic foundation for the Critic loop
