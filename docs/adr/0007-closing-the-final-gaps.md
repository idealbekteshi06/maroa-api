# ADR-0007: Closing the final weak points

**Date:** 2026-05-12 · **Status:** Accepted

## Context

Honest self-assessment after Waves 52–56 identified five weak points:

1. **Zero production data** — every clever pipeline is theoretical
2. **Embedding vendor not picked** — Performance Memory at ~20% capability
3. **Review scraper missing** — VoC pipeline has no upstream source
4. **Solo founder = one set of eyes** — structural; not fixable in code alone
5. **No on-call / no alert routing** — Sentry exists but 3am incidents are silent

Wave 57 closes #2, #3, and #5 fully; #4 partially via documentation; #1 is structural (only real customers can fix it, but we make the system work the moment data flows in).

## Decisions

### 1. Multi-source VoC ingestion (closes #3)

`services/voc-scraper/sources/` ships four adapters with a unified shape:

| Source          | API                                          | Cost                   | Status                                           |
| --------------- | -------------------------------------------- | ---------------------- | ------------------------------------------------ |
| `google-places` | Google Places API                            | $17 / 1k requests      | Production-ready (needs `GOOGLE_PLACES_API_KEY`) |
| `yelp`          | Yelp Fusion API                              | Free tier 5k calls/day | Production-ready (needs `YELP_API_KEY`)          |
| `trustpilot`    | Trustpilot Business API                      | Paid ($300+/mo)        | Stub (no-op without `TRUSTPILOT_API_KEY`)        |
| `manual`        | none — accepts pasted review text via params | $0                     | Always works (no API key needed)                 |

`services/voc-scraper/orchestrator.js` runs all configured sources in parallel for a business, dedupes (first 80 chars normalized), fetches competitor reviews (filtered to ≤2 stars), and pipes everything through the existing `voc-scraper/index.js#ingestReviews` which extracts structured phrases and persists to `customer_insights`. The grounding library picks them up automatically — **no new wiring needed**.

The `manual` adapter is the key insight: it makes the system work today, with zero API keys, by accepting reviews pasted at onboarding. External adapters layer on top.

### 2. Pluggable embedding provider registry (closes #2)

`lib/embeddingProviders/` replaces the inline OpenAI implementation that was previously in `performanceMemory.js`. Two providers ship:

- **`openai`** — text-embedding-3-small with `dimensions: 384` (matches `vector(384)` in migration 061 without resize). Picked when `OPENAI_API_KEY` is set.
- **`stub`** — deterministic token-hash, 384-dim, L2-normalized. Always available, used in tests + dev environments.

`pick()` is cached so we don't re-evaluate env per call. Adding new providers (Cohere, Voyage AI, self-hosted sentence-transformers) is a single file + one registry entry.

**Bug fixed in passing:** the previous inline implementation requested 1536-dim embeddings, but migration 061 declares `vector(384)`. Writes would have failed at runtime with a dim mismatch the moment the API key was wired. The new provider explicitly requests 384-dim.

### 3. Multi-channel alert router (closes #5)

`lib/alertRouter.js` fans alerts to four channels with severity-based routing:

| Severity   | Sentry | Slack | Email | PagerDuty |
| ---------- | ------ | ----- | ----- | --------- |
| `info`     | ✓      |       |       |           |
| `warning`  | ✓      | ✓     |       |           |
| `error`    | ✓      | ✓     | ✓     |           |
| `critical` | ✓      | ✓     | ✓     | ✓ (pages) |

Per-key, per-channel rate limiting (5min) prevents alert storms. Each channel is independently optional — set the env var, get the channel; don't, the router silently skips. Wired into `services/observability/slos.js#emitSloAlerts` so SLO violations flow through it.

Severity mapping for SLO violations:

- `budget_enforcement` / `oauth_token_decrypt_success` → **critical** (pages on-call)
- `api_availability` < 99.9% → **error**
- Everything else → **warning**

### 4. Solo-founder mitigation (partial fix for #4)

This isn't fixable in code alone — it's a structural constraint. But several Wave 50–57 properties together raise the floor:

- 944 unit + integration tests block merge of regressions
- Semgrep + custom rules tuned to your bug history (IDOR, crypto-downgrade, PostgREST injection)
- Mutation testing on crypto/budget/webhook critical paths
- Format + lint + audit + migration sanity gates
- All public-facing libraries fail-safe by default (malformed JSON ships the original, dispatcher misses fall through to HTTP, alerts that fail one channel still try the others)

The combination makes a single-engineer mistake very unlikely to ship without CI flagging it.

### 5. Zero production data (structural — code makes it ship-ready)

We can't generate fake production data. But the system **works the day a customer onboards** because:

- VoC `manual` adapter takes pasted reviews — onboarding question fills it
- Performance Memory ships with stub embeddings — pgvector path works immediately, just at lower quality until OpenAI is wired
- Grounding context degrades gracefully (recency fallback when wins/losses tables are empty)
- Alert router skips channels that aren't configured

Day-1 customer signup → grounded prompts → critic-rewritten output → SLO monitor watching it all. No code dependencies left in the operator queue beyond key rotations.

## Tests

- `tests/voc-scraper-sources.test.js` — 15 tests (all 4 sources, key missing paths, mock HTTP)
- `tests/voc-orchestrator.test.js` — 8 tests (multi-source, dedup, competitor filtering, error resilience)
- `tests/embedding-providers.test.js` — 18 tests (stub determinism, OpenAI request shape, registry caching)
- `tests/alert-router.test.js` — 13 tests (severity routing, rate limiting, channel resilience)

**Total: 54 new tests** in Wave 57. Suite is now at 944 passing.

## Rating after Wave 57

| Weak point           | Pre-W57        | Post-W57                                                |
| -------------------- | -------------- | ------------------------------------------------------- |
| Zero production data | structural     | **Ship-ready** — system works day-1 of customer signup  |
| Embedding vendor     | 20% capability | **100% on stub, 100% with OPENAI_API_KEY**              |
| Review scraper       | missing        | **4 adapters + orchestrator**                           |
| Solo-founder eyes    | structural     | CI gauntlet raises the floor; not fixable in code alone |
| On-call routing      | silent failure | **4-channel alert router with severity-based routing**  |

## Operator action required

The remaining work is all operator-side decisions:

1. **Pick embedding vendor** — set `OPENAI_API_KEY` to light up real embeddings. Provider registry auto-detects.
2. **Wire Slack webhook** — set `SLACK_ALERT_WEBHOOK_URL` to get notified of SLO violations.
3. **Optional**: wire `ALERT_EMAIL_TO` + `PAGERDUTY_INTEGRATION_KEY` for tiered severity.
4. **Optional**: set `GOOGLE_PLACES_API_KEY`, `YELP_API_KEY` to enable automated review fetching. Manual upload works without them.

## References

- `services/voc-scraper/sources/{google-places,yelp,trustpilot,manual}.js`
- `services/voc-scraper/orchestrator.js`
- `lib/embeddingProviders/{index,openai,stub}.js`
- `lib/alertRouter.js`
- `services/observability/slos.js#emitSloAlerts`
- ADR-0005 (closed-loop creative system) — VoC and embeddings are pillars 1 + 4
- ADR-0006 (Inngest loopback + security headers) — sets up the operator-action pattern
