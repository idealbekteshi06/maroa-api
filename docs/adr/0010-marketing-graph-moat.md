# ADR-0010: The Marketing Graph (Maroa's load-bearing moat)

**Date:** 2026-05-14 · **Status:** Accepted

## Context

After Waves 52–60 the system has: cold-start corpus pre-trainer, closed-loop
critic, awareness × funnel router, 35 channel modules, 20 compliance
rulesets, 7 specialist dispatchers, agency-grade master pipeline, IDOR-locked
auth, callClaude single gateway, zero dep vulns, and a carved server.js
(15.6k → 12.7k → continuing).

That gets us to "engineering A, production readiness A-." It does not yet
give us a **moat**. Every feature so far is reproducible by a team with
enough capital. The competition (Adobe, Salesforce, HubSpot all shipping
agentic-marketing 2026) has more headcount, more capital, more
distribution. We can't out-resource them.

What we CAN have that they can't replicate: **deep SMB-specific outcome
data, structured as a graph that compounds with every customer's runtime.**

This ADR establishes the Marketing Graph as Maroa's primary competitive
moat and the load-bearing data layer for every Phase 2+ feature.

## Decision

Build a typed graph of every business-marketing entity + every relationship
between them + outcome scoring on each — populated by every agent at write
time, queried by every agent at read time. Outcomes compound. After 30+
days of customer usage, the graph IS the product.

### 1. Schema (migration 065)

Eight tables:

| Table                      | What                                                                  | Why                                            |
| -------------------------- | --------------------------------------------------------------------- | ---------------------------------------------- |
| `marketing_graph_entities` | typed nodes (product, audience, channel, creative, …)                 | Generic enough to grow without migrations      |
| `marketing_graph_edges`    | typed directed relationships (used_in, targeted_at, attributed_to, …) | Stitches everything together                   |
| `claims_library`           | atomic marketing claims with outcome_signal                           | High-performing claims surface first in N-best |
| `offer_library`            | promotional offers with conversion + revenue counters                 | Reusable across creatives                      |
| `audience_segments`        | platform-addressable audiences                                        | Stored once, referenced by creatives           |
| `creative_assets`          | every creative with Creative Genome decomposition                     | The core learning surface                      |
| `experiments`              | A/B testing state                                                     | Powers the Experiment Engine (Phase 4)         |
| `decision_logs`            | universal agent decision audit trail                                  | Powers the Autopilot Control Room UI (Phase 3) |

Design principles:

- **Typed but not rigid.** `entity_type` is text + `attrs` is jsonb. New
  entity types (webinar, podcast, ad-set, etc.) don't need migrations.
- **Denormalized business_id on every table.** Keeps RLS simple + every
  query has `business_id` as the first filter.
- **Soft FKs.** `creative_assets.claim_ids uuid[]` instead of join tables.
  Trades referential integrity for write speed + simpler queries on the
  read path that matters (N-best reranker).
- **Outcome columns are first-class.** `claims.outcome_signal`,
  `creatives.performance_score`, `offers.conversion_count` are populated
  by the closed-loop learning step — not computed lazily.
- **RLS: business-owner self-read, service-role write.** Same pattern as
  agency_pipeline_runs (migration 064). Frontend can safely read its own
  graph; only backend writes.

### 2. Library — `lib/marketingGraph.js`

Factory `makeMarketingGraph({ sbGet, sbPost, sbPatch, logger, metrics })`.
17 methods covering entity/edge CRUD, claim recording, offer tracking,
audience seeding, creative recording, performance updates, experiment
lifecycle. **Fail-safe**: every DB call is try/caught; failures degrade
to soft results (`null` / `[]`). A Supabase outage never breaks content
generation — graph is an amenity, not a hot-path dependency.

`isHealthy()` is cached. The library probes once on first use; if
migration 065 isn't applied yet, the library no-ops for the lifetime of
the process. This lets us deploy the library before the operator has
applied the migration.

### 3. Library — `lib/decisionLog.js`

Generalizes Wave 60 S10's `agency_pipeline_runs` to ALL agents.
Factory `makeDecisionLogger({ sbGet, sbPost, sbPatch, logger, metrics })`.

Lifecycle per decision:

1. `proposeDecision({ businessId, agentName, decisionType, recommendationText,
confidence, expectedUpside, risk, costUsd, manipulationRisk,
autoSafeBand })` — write row before acting.
2. `recordExecution(id, { executed, executionDetails, refused, refusalReason })`
   — after the agent has actually run.
3. `recordOutcome(id, { outcome, outcomeScore })` — after measurement
   window (typically 1–7 days).

Auto-safe banding matches the strategy doc:

- **green** → auto-publish, no approval (default for routine agent actions)
- **yellow** → operator notified before publish (brand-sensitive)
- **red** → never auto-publish (regulated / high-risk / above spend threshold)

Routes that go yellow/red automatically set `required_approval = true`.
The `pendingApprovals(businessId)` query drives the Autopilot Control
Room inbox UI (Phase 3).

### 4. CI guardrails

Two new test files prevent silent drift:

`tests/route-auth-registry.test.js` — scans `server.js` for every
`app.{get,post,put,delete,patch}` declaration and verifies each falls
into ONE of: public, jwt, webhook, signed-webhook, admin. Catches the
exact IDOR pattern the 2026-05-13 audit found.

Already caught + fixed in this commit: 7 routes (`/api/content/generate`,
`/api/cron-health/:businessId`, `/api/business/:businessId/brand-voice`,
`/api/schema/:userId`, `/api/pricing/:userId`,
`/api/sales/objection-handler`, `/api/generate`) had no auth mount. All
now require Bearer JWT via the same factory shipped in P1.

`tests/ai-gateway-guard.test.js` — fails if any non-allowlisted file
calls `api.anthropic.com/v1/messages` directly. Approved bypasses are
documented in the test file's `APPROVED_FILES` set (server.js for
callClaude itself + /debug probe; services/higgsfield.js for standalone
fallback paths). Each new addition is a code-review event.

### 5. Wiring into existing agents (TODO — separate commit)

The libraries are READY. Wiring is a per-agent task:

- ad-optimizer → log every refresh / pause / scale decision
- content-generate → log + record creative in the graph
- cro → log every audit + rewrite recommendation
- voc → record claims sourced from real customer reviews
- competitor-watch → record competitor entities + edges
- agency-pipeline → already logs to agency_pipeline_runs; mirror into
  decision_logs for unified UI

Wiring is gated by feature flag `MARKETING_GRAPH_ENABLED` (TBA in env).
Same posture as Wave 60: dark by default, flip on after migration is
applied + smoke test passes.

## Cost model

| Activity                    | Cost                         | Frequency               |
| --------------------------- | ---------------------------- | ----------------------- |
| Migration 065 apply         | $0                           | one-time                |
| Decision log row write      | ~$0 (single Supabase INSERT) | per agent decision      |
| Graph entity/edge write     | ~$0                          | per agent action        |
| Performance score recompute | ~$0 (pure compute)           | per outcome measurement |

Read costs dominate at scale (the N-best reranker hits `topCreatives` +
`pickTopClaims` on every generation). Indexes on
`(business_id, performance_score DESC)` keep these sub-millisecond up to
millions of rows per business.

## Failure modes (all soft)

| Failure                   | Behavior                                                 |
| ------------------------- | -------------------------------------------------------- |
| Migration 065 not applied | `isHealthy()` returns false; all writes/reads no-op      |
| Supabase outage mid-write | Logged, metric incremented, function returns null        |
| Stale outcome_signal      | Library is read-only after first probe; latency-tolerant |
| RLS misconfig             | Reads return `[]` (operator sees in metrics)             |

Same fail-safe envelope as 061 (performance memory) + 062 (corpus).

## Tests shipped

- `tests/marketing-graph.test.js` — 23 unit tests (isHealthy, upsertEntity,
  linkEntities, getEntitiesByType, recordClaim dedupe, pickTopClaims,
  recordOffer, recordCreative with Genome, updateCreativePerformance
  scoring math, recordExperiment validation, completeExperiment, defensive
  paths).
- `tests/decision-log.test.js` — 19 unit tests (proposeDecision validation,
  confidence clamping, band → required_approval mapping, soft results
  when offline, recordExecution + recordOutcome, pendingApprovals,
  recentDecisions filtering, approve flow).
- `tests/route-auth-registry.test.js` — 4 tests scanning server.js.
- `tests/ai-gateway-guard.test.js` — 3 tests scanning lib/ + middleware/ + routes/ + services/.

Suite: 1388/1388 passing (was 1339). Lint: 0 errors.

## Operator action

1. **Apply migration 065 in Supabase SQL editor** — the file is
   `migrations/065_marketing_graph.sql`. Idempotent.
2. **Record in `_migrations`** ledger with checksum.
3. **No new env vars yet** — the libraries are off by default
   (`isHealthy()` returns false until the tables exist).
4. **Wiring agents into the graph is a follow-up.** This ADR + the
   libraries are the foundation; per-agent wiring goes into separate
   commits that can be tested + rolled back independently.

## References

- `migrations/065_marketing_graph.sql`
- `lib/marketingGraph.js`
- `lib/decisionLog.js`
- `tests/marketing-graph.test.js`
- `tests/decision-log.test.js`
- `tests/route-auth-registry.test.js`
- `tests/ai-gateway-guard.test.js`
- ADR-0005 (closed-loop creative system) — the graph is what makes the
  loop compound over time
- ADR-0008 (global marketing corpus) — the graph holds business-specific
  outcomes; the corpus holds world-class cold-start patterns
- 2026-05-13 audit memory — Phase 1 trust hardening that preceded this
- Strategy memory `maroa_strategy_ai_cmo.md` — North Star positioning
  that drove the prioritization
