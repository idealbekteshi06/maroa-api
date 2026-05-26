# Maroa.ai — Project Knowledge Base

> **Last updated:** 2026-05-19. If this is more than a quarter old, treat
> it as suspect and verify against `git log` + the live code.

This file is the canonical architectural map. Read it before making any
non-trivial change. Pair with [LEARNINGS.md](./LEARNINGS.md) which is
the decision log explaining _why_ each piece is the way it is.

---

## 1. What this is

Maroa.ai is an AI marketing automation SaaS for small businesses
($5–$500/day ad budgets). Customers connect their Meta + Google + social
accounts; the system writes content, runs ads, scores creatives, tracks
competitors, fires lifecycle emails, generates CRO audits, and reports
weekly — without daily human input.

**Pricing tiers:** `starter ($25/mo)` · `growth ($59/mo)` · `agency ($99/mo)` ·
`enterprise (custom)` — enforced by `middleware/planGate.js` +
`middleware/planLimits.js` + `lib/costGuard.js`. Cancel-anytime
monthly billing. No free tier, no trial, no money-back guarantee.

---

## 2. Architecture (current — post-n8n migration)

Until ~Apr 2026 this ran on n8n Cloud. The 28 workflows are now
implemented as Express routes + Inngest functions in this repo. The
`n8n-workflows/` folder is legacy archive — nothing imports it.

```
                     ┌───────────────────────┐
   Customer ─────▶   │   Lovable frontend    │   (React, separate repo)
                     └──────────┬────────────┘
                                │ HTTPS + JWT
                                ▼
                     ┌───────────────────────┐
                     │  Express API server   │   server.js (this repo)
                     │  (Railway, autoscale) │
                     └──┬─────────────┬──────┘
            sbGet/Post  │             │ inngest.send(event)
                        ▼             ▼
                ┌───────────┐  ┌──────────────┐
                │ Supabase  │  │   Inngest    │ ◀── durable cron + events
                │ Postgres  │  │              │
                └─────┬─────┘  └──────┬───────┘
                      │               │
                      │               ▼
                      │      ┌────────────────────┐
                      │      │ POST loopback HTTP │
                      │      │ to own /webhook/*  │
                      │      └────────────────────┘
                      ▼
       ┌────────── External APIs ──────────┐
       │ Anthropic Claude (Sonnet/Opus/Haiku)
       │ Higgsfield (image/video — Cloud + FNF fallback)
       │ Meta Graph v21 (Ads + Pages + IG + Threads)
       │ Google Ads v18
       │ Ayrshare (LinkedIn, Pinterest, TikTok, YouTube)
       │ Paddle (payments) + Stripe (legacy)
       │ Resend (email) · Twilio (WhatsApp)
       │ Pexels · Replicate · SerpAPI
       └────────────────────────────────────┘
```

Cross-cutting layers:

- **Observability** — JSON logs (correlation IDs), Prometheus `/metrics`,
  Sentry with PII scrubbing, `/healthz` + `/readyz`.
- **Cost discipline** — `lib/costGuard.js` per-business monthly cap;
  `services/observability/cost-tracker.js` records every Anthropic call.
- **Resilience** — `lib/circuitBreaker.js` per external API; Inngest
  retries with exponential backoff; 15s default external HTTP timeout.

---

## 3. Tech stack (exact versions in `package.json`)

| Layer         | Tool                            | Note                                                                            |
| ------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| Node          | ≥18                             | `package.json:engines`                                                          |
| HTTP          | Express 4                       | One monolithic `server.js` — being carved into `routes/*.js`                    |
| Background    | Inngest 4                       | Replaces n8n cron; events + `step.sleep`                                        |
| DB            | Supabase Postgres               | PostgREST + service-role key for inserts                                        |
| LLM           | Anthropic Claude 4.x            | Sonnet 4.5 default · Opus 4.7 for hard reasoning · Haiku 4.5 for cheap classify |
| Image/Video   | Higgsfield 2026                 | Cloud-first → FNF fallback                                                      |
| Social        | Meta v21 + Ayrshare             | LinkedIn, Pinterest, TikTok, YouTube via Ayrshare                               |
| Payments      | Paddle                          | Stripe still wired but secondary                                                |
| Email         | Resend HTTPS                    | Railway blocks SMTP — see LEARNINGS §3                                          |
| Observability | Sentry + Prometheus + JSON logs | `services/observability/`                                                       |
| Deploy        | Railway                         | Production: `maroa-api-production.up.railway.app`                               |
| Frontend      | Lovable                         | `maroa-ai-marketing-automator.lovable.app`                                      |

---

## 4. Database schema highlights

Read `migrations/000_schema_bootstrap.sql` + the numbered migrations for
the truth. High-traffic tables:

| Table                                                         | What it holds                                                                                             |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `businesses`                                                  | One row per customer org. Profile, plan, OAuth tokens (encrypted in `*_enc` columns), all stats counters. |
| `generated_content`                                           | One row per generated post. Captions, image_url, scheduled/published timestamps, performance score.       |
| `ad_campaigns`                                                | Live Meta + Google campaigns we manage.                                                                   |
| `ad_performance_logs`                                         | Daily metric snapshot per campaign.                                                                       |
| `ad_audit_results`                                            | Output of ad-optimizer (decision, reason, score).                                                         |
| `llm_cost_logs`                                               | Every Anthropic call's cost + tokens — drives `cost-report` and `costGuard`.                              |
| `webhook_events`                                              | Paddle/Stripe/etc. dedup. `(provider, event_id)` PK.                                                      |
| `_migrations`                                                 | Migration ledger — filename + checksum + applied_at.                                                      |
| `cold_start_runs`                                             | Onboarding orchestrator state machine.                                                                    |
| `content_plans`, `concepts`, `assets`, `posts`, `performance` | WF1 daily content pipeline (CASCADE chain).                                                               |
| `events`                                                      | Cross-workflow event log (JSONB payloads).                                                                |
| `errors`                                                      | Persistent error sink — drives anti-thrashing in ad-optimizer.                                            |
| `oauth_states`                                                | PKCE state for Twitter/TikTok OAuth flows.                                                                |

Note: there are **138 tables** total. The schema is JSONB-heavy in the
event/audit space — payloads are stored as `jsonb` and queried with
`->>` operators. Add GIN indexes if you filter by a JSONB key in a hot path.

---

## 5. Workflow inventory (current vs. original n8n)

The original n8n workflows are now implemented as a mix of Inngest
functions (scheduled + event-driven) and Express HTTP routes. This table
is reverse-engineered from the live code (`services/inngest/functions.js`

- `server.js` route registrations + `tests/`), **not** from the old n8n
  exports — those JSON files were deleted from the repo, so no byte-diff is
  possible. Verified 2026-05-25.

**Status legend**

- ✅ **firing** — registered in the Inngest `functions` array (verified by
  `tests/inngest-functions.test.js`) and runs on its cron, OR fires on a
  named event. These run unattended in production.
- 🟙 **mounted** — a reachable HTTP route, but only runs when something
  calls it. Per the `services/wf_batch_routes.js` header these have **no
  frontend `api.ts` contract yet**, so they are NOT confirmed firing in
  prod — they're callable, not driven.
- 🔴 **no test** — zero behavioural test coverage. Treat as unverified.
- 🟡 **shallow test** — only a factory-shape/contract or prompt-level
  smoke test; engine logic is not exercised.

### A. Scheduled + event-driven (Inngest) — ✅ firing

| Workflow                             | What it does                                                                                                                                                                                           | File                                          | Trigger                              | Tests                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------ | ------------------------------------------------------- |
| Ad optimizer                         | Daily audit of every active campaign → pulls FRESH Meta insights, decides scale/pause/resume/budget/refresh, then **executes the decision on Meta** (actuator, dry-run gated by `META_AD_LAUNCH_LIVE`) | `services/ad-optimizer/`                      | cron `0 8 * * *`                     | ✅ `ad-optimizer*.test.js`, `meta-ads-actuator.test.js` |
| Pacing alerts                        | Flags ad-spend over/under-pacing                                                                                                                                                                       | `services/pacing-alerts/`                     | cron `0 */4 * * *`                   | ✅ `pacing-alerts.test.js`                              |
| Weekly scorecard                     | Generates + emails the weekly performance recap (absorbs old WF04 retention)                                                                                                                           | `services/weekly-scorecard/`                  | cron `0 22 * * 0`                    | ✅ `weekly-scorecard.test.js`                           |
| WF1 content sweep                    | Hourly sweep; generates each business's daily content at its local 06:00                                                                                                                               | `services/wf1/`                               | cron `0 * * * *`                     | ✅ `wf1-engine-tdz.test.js`                             |
| WF1 measure fallbacks                | Re-measures posts whose metrics were pending                                                                                                                                                           | `services/wf1/`                               | cron `30 * * * *`                    | 🟡 (shared with WF1)                                    |
| WF1 overnight batch submit           | Submits the nightly Anthropic batch job                                                                                                                                                                | `services/wf1/`                               | cron `0 23 * * *`                    | 🟡 (shared with WF1)                                    |
| WF1 overnight batch apply            | Polls + applies completed batch results                                                                                                                                                                | `services/wf1/`                               | cron `*/10 * * * *`                  | 🟡 (shared with WF1)                                    |
| Anthropic batch reconcile            | Reconciles non-WF1 Anthropic batches                                                                                                                                                                   | `services/anthropic-batch.js`                 | cron `*/5 * * * *`                   | 🟡 `anthropic-2026.test.js`                             |
| Creative engine daily                | Generates fresh creative variants                                                                                                                                                                      | `services/creative-engine/`                   | cron `0 9 * * *`                     | ✅ `creative-engine-*.test.js`                          |
| Creative engine evaluate             | Refreshes creatives on low CTR / decay                                                                                                                                                                 | `services/creative-engine/`                   | cron `0 */6 * * *`                   | ✅ (shared)                                             |
| Measurement health                   | Daily probe of metric-ingestion health                                                                                                                                                                 | `services/measurement-health/`                | cron `0 7 * * *`                     | 🟡 `multi-platform-ads.test.js`                         |
| Citation tracker                     | Checks AI-search (ChatGPT/Perplexity/etc.) citability daily                                                                                                                                            | `services/citation-tracker/`                  | cron `0 6 * * *`                     | ✅ `citation-tracker.test.js`                           |
| Competitor watch                     | Competitor intelligence sweep                                                                                                                                                                          | `services/competitor-watch/`                  | cron `0 */4 * * *`                   | ✅ `competitor-incrementality.test.js`                  |
| Email lifecycle                      | Dispatches day 1/3/7/14/30 lifecycle emails                                                                                                                                                            | `services/email-lifecycle/`                   | cron `*/15 * * * *`                  | 🟡 `email-and-pages.test.js`                            |
| WF11 inbox SLA                       | Sweeps inbox threads breaching SLA                                                                                                                                                                     | `services/wf11/`                              | cron `*/15 * * * *`                  | ✅ `wf11.test.js`                                       |
| WF2 calibration                      | Weekly recalibration of lead-scoring weights                                                                                                                                                           | `services/wf2/`                               | cron `0 3 * * 0`                     | 🔴 none                                                 |
| WF13 weekly synthesis                | Synthesizes the weekly strategy brief                                                                                                                                                                  | `services/wf13/`                              | cron `0 7 * * 0`                     | 🟡 `anthropic-2026.test.js`                             |
| Autopilot brain                      | Top-level daily orchestrator (Week 12)                                                                                                                                                                 | `services/autopilot-brain/`                   | cron `0 8 * * *`                     | ✅ `autopilot-brain.test.js`                            |
| Ops analytics snapshots              | Daily analytics rollups                                                                                                                                                                                | `services/ops-maintenance/`                   | cron `0 6 * * *`                     | 🔴 none                                                 |
| Ops daily health bundle              | Daily ops health digest                                                                                                                                                                                | `services/ops-maintenance/`                   | cron `30 7 * * *`                    | 🔴 none                                                 |
| Ops weekly maintenance               | Weekly DB/ops housekeeping                                                                                                                                                                             | `services/ops-maintenance/`                   | cron `30 5 * * 0`                    | 🔴 none                                                 |
| Ops growth engine                    | Monday growth-metrics job                                                                                                                                                                              | `services/ops-maintenance/`                   | cron `0 9 * * 1`                     | 🔴 none                                                 |
| Ops monthly reports                  | Month-start customer reports                                                                                                                                                                           | `services/monthly-report/`                    | cron `0 8 1 * *`                     | 🔴 none                                                 |
| Taxonomy refresh                     | Quarterly AI-proposed taxonomy adds (Slack-only, never auto-merge)                                                                                                                                     | `services/taxonomy-refresh/`                  | cron `0 9 1-7 1,4,7,10 1`            | ✅ `taxonomy*.test.js`                                  |
| Content 24h feedback                 | Durable 24h-after-publish performance score                                                                                                                                                            | `services/inngest/functions.js`               | event `content.publish.feedback-24h` | ✅ `e2e-publish-pipeline.test.js`                       |
| Cold-start run/resume                | Onboarding orchestrator state machine                                                                                                                                                                  | `services/cold-start/`                        | events `cold-start.run` / `.resume`  | ✅ `cold-start.test.js`                                 |
| Manual ad-audit / pacing / scorecard | Dashboard-triggered manual reruns of the three crons above                                                                                                                                             | `services/inngest/functions.js`               | events `manual.*`                    | 🟡 (cover target engines)                               |
| Higgsfield credits daily check       | Refreshes each business's Higgsfield credit balance (when REST balance endpoint lands) and emails owners with credits < 200; the WF1 engine hard-blocks generation when < 100                          | `services/inngest/functions.js` + `server.js` | cron `0 7 * * *`                     | 🟡 (covered by wf1 credit-guard test)                   |
| Higgsfield Soul ID train poll        | Event-driven durable poll fired by `POST /api/higgsfield/train-soul`; waits for Higgsfield training to complete then stamps `businesses.higgsfield_soul_id`                                            | `services/inngest/functions.js` + `server.js` | event `higgsfield/soul-train.poll`   | 🟡 (path mirrored from cold-start)                      |

### B. HTTP-route / on-demand — 🟙 mounted (fire only when called)

| Workflow                       | What it does                                                                  | File                     | Trigger                                 | Tests                          |
| ------------------------------ | ----------------------------------------------------------------------------- | ------------------------ | --------------------------------------- | ------------------------------ |
| WF15 — AI Brain                | Conversational command center; instant content generation                     | `services/wf15/`         | route `POST /webhook/instant-content`   | 🟡 `anthropic-2026.test.js`    |
| WF12 — Launch orchestrator     | Plans + tracks a product launch                                               | `services/wf12/`         | routes `/webhook/wf12-*`, `/api/launch` | 🟡 `wf-batch-contract.test.js` |
| WF10 — Higgsfield Studio       | Image/video studio jobs, Soul ID (agency)                                     | `services/wf10/`         | routes `/webhook/wf10-*`                | 🔴 none                        |
| WF9 — Unified inbox            | Intake/triage/draft-reply for inbound messages                                | `services/wf9/`          | routes `/webhook/wf9-*`                 | 🔴 none                        |
| WF8 — Customer insights        | Generates customer-insight reports                                            | `services/wf8/`          | routes `/webhook/wf8-*`                 | 🟡 `wf-batch-contract.test.js` |
| WF7 — Email lifecycle engine   | Segment/sequence/enroll primitives (the cron above drives dispatch)           | `services/wf7/`          | routes `/webhook/wf7-*`                 | 🔴 none                        |
| WF6 — Local + digital presence | GBP/SEO presence audit + JSON-LD schema gen                                   | `services/wf6/`          | routes `/webhook/wf6-*`                 | 🟡 `wf-batch-contract.test.js` |
| WF5 — Competitor intel engine  | On-demand competitor analysis (cron `competitor-watch` is the scheduled path) | `services/wf5/`          | routes `/webhook/wf5-*`                 | 🟡 `anthropic-2026.test.js`    |
| WF4 — Reviews & reputation     | Review monitoring + response drafting                                         | `services/wf4/`          | routes `/webhook/wf4-*`                 | 🔴 none                        |
| WF3 — Ad optimization (legacy) | Older ad-loop engine; `ad-optimizer` cron is the active path                  | `services/wf3/`          | mounted in `server.js`                  | 🟡 `anthropic-2026.test.js`    |
| WF2 — Lead scoring & routing   | Scores + routes inbound leads (cron above only recalibrates)                  | `services/wf2/`          | routes `/webhook/wf2-*`                 | 🔴 none                        |
| WF14 — Budget & ROI optimizer  | Reallocates budget across campaigns                                           | `services/wf14/`         | routes `/webhook/wf14-*`                | 🔴 none                        |
| WF13 — Weekly brief (routes)   | Read/trigger surface for the synthesis cron above                             | `services/wf13/`         | routes (`registerWf13Routes`)           | 🟡 `anthropic-2026.test.js`    |
| Higgsfield (media)             | Soul ID / image / video generation primitives                                 | `services/higgsfield.js` | on-demand (called by WF10/WF1)          | ✅ `higgsfield-*.test.js`      |

### C. Post-migration named capabilities (HTTP routes, customer-facing)

- `services/cro/` — landing-page CRO audit + rewrites — ✅ `cro.test.js`
- `services/ai-seo/` — AI-search citability + llms.txt + JSON-LD — ✅ `ai-seo.test.js`
- `services/forecasting/` — ROAS + spend forecast 30/60/90 — ✅ `forecasting.test.js`
- `services/voc/` — voice-of-customer mining — ✅ `voc*.test.js`
- `services/social-multi/` — Ayrshare + Meta Graph publish — (covered via Meta publish tests)

### Removed / merged

- **WF28 — Google My Business poster: REMOVED.** Google killed the API in 2024.
- **WF04 — retention: MERGED** into the weekly scorecard.

### ⚠️ Test-coverage gaps (mounted but unverified)

These run customer-facing logic with **zero behavioural tests** — fix
before relying on them: **WF2** (lead scoring), **WF4** (reviews),
**WF7** (email lifecycle engine), **WF9** (inbox), **WF10** (studio),
and the **ops/monthly-report** crons. The 🟡 "shallow" rows
(`anthropic-2026` / `wf-batch-contract`) only assert factory shape or
prompt wiring, not engine behaviour.

### ⚠️ Duplication to resolve

Three capabilities exist as **both** a legacy route-engine and a newer
scheduled service doing similar work — pick one per capability and delete
the other: ad optimization (`wf3` vs `ad-optimizer`), competitor intel
(`wf5` vs `competitor-watch`), email (`wf7` vs `email-lifecycle`). Also,
`autopilot-brain` and `ad-optimizer` both fire at `0 8 * * *` — confirm
the brain orchestrates rather than races the optimizer.

---

## 6. The 5 rules that matter

These are load-bearing. Breaking them creates silent bugs that take
weeks to find.

**Rule 1 — Single env source.** Read env vars from `env` (the validated
zod object), not `process.env`. Boot fails fast if anything required is
missing.

**Rule 2 — One callClaude.** Don't write raw `apiRequest` calls to
`api.anthropic.com`. Always go through `callClaude()` so retries +
prompt-caching + cost tracking + budget enforcement happen. callClaude
accepts both the positional (`prompt, model, max_tokens, extra`) and
object (`{system, user, model, max_tokens, extra}`) shapes.

**Rule 3 — Webhook security has 3 parts.** HMAC verification (already
in `services/paddle.js`, `services/stripe/index.js`) AND timestamp
tolerance (≤5 min) AND idempotency via `lib/webhookEvents.markProcessed`.
Skipping any one of them leaves a replay or duplicate-fire bug.

**Rule 4 — PostgREST filters need encoded inputs.** Anything that ends
up in a `?id=eq.X` filter must be UUID-validated + `encodeURIComponent`'d
at the boundary. See `middleware/planGate.js`, `middleware/planLimits.js`,
`lib/costGuard.js` for the pattern.

**Rule 5 — OAuth state binds to user + nonce.** Never sign state with
just `businessId` — that's account-takeover-able. The current scheme
(`services/oauth/{meta,google}.js`) signs
`businessId|userId|nonce|ts|hmac`.

**Rule 6 — Customer-facing generation goes through the closed-loop creative
system.** Don't write raw `callClaude` for customer-facing copy. Use:

- `lib/groundingContext.js` to inject wins+losses+VoC+cohort+brand into the prompt
- `lib/nBestReranker.js` to oversample candidates and judge-pick top-K
- `lib/adversarialCritic.js` to critique + rewrite before shipping
- `lib/performanceMemory.js` for pgvector-backed semantic search over past
  outcomes — pass `semanticQuery` + `performanceMemory` to `buildGroundingContext()`
  and the wins/losses become RAG-quality (vs recency-based fallback).
  See ADR-0005. The pattern is already in `services/creative-engine/index.js`
  — mirror it. Output specificity from grounded prompts beats raw model
  quality every time, and the cost is bounded (~$0.03/business/day).

---

## 6a. Cold-Start Corpus — Industry-Aware Grounding

(Engineering name: "marketing corpus pre-trainer". Customer-facing name:
"industry expertise on day 1.")

A pre-trained global corpus (`marketing_corpus` table, migration 062) seeded
from public sources — Meta Ad Library expert brands, Google Places top
cohorts, award winners (Cannes/Effie/D&AD/One Show). Lets new customers
retrieve from world-class examples on day 1 instead of an empty table.

**Load-bearing constraints (Wave 59 hardening — do not break):**

- **Quality floor: 0.55.** Rows scoring below `qualityScorer.ACCEPTABLE_THRESHOLD`
  are dropped, not stored at low score. Prevents mediocre examples from
  polluting retrieval.
- **Eligibility gate: brand + runtime.** Meta ads must be from an expert
  brand (or award winner) AND have runtime ≥ 60 days before they reach
  the classifier. Saves Haiku cost on rows we'd reject anyway.
- **Award tier: 0.95.** Brands in `expertSources.AWARD_WINNERS` always
  get top-tier score regardless of other signals.
- **Tier-gated injection: free=0, growth=2, agency=5.** Free tier never
  sees corpus rows — pure monetization + cost lever. Unknown plan = free.
- **Cold-start switch: 50 published pieces.** Once a customer has shipped
  ≥ `COLD_START_THRESHOLD` of their own content, corpus turns off — their
  own performance data is the better signal.
- **Prompt caching: enabled.** Corpus block tagged `cache_control:ephemeral`
  via `ctx.toCacheableBlocks()`. 90% input-cost reduction on repeat calls
  within the 5-min TTL.
- **Taxonomy refresh: quarterly, Slack-only.** `services/taxonomy-refresh`
  proposes adds/removes via Claude → posts to Slack. NEVER auto-merges —
  humans review + open a PR.

See ADR-0008 for the full architecture.

---

## 7. Local dev quickstart

See [README.md](./README.md) for the canonical version. Short form:

```bash
git clone <fork> && cd Maroa.ai
npm install
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_KEY, N8N_WEBHOOK_SECRET,
# OAUTH_TOKEN_ENC_KEY (run: openssl rand -hex 32)
npm run dev
```

---

## 8. Production test account

| Field         | Value                                  |
| ------------- | -------------------------------------- |
| email         | `idealbekteshi06@gmail.com`            |
| business_name | `ibgboost.com`                         |
| business_id   | `fea4aae5-14b4-486d-89f4-33a7d7e4ab60` |
| plan          | `growth`                               |

Use this UUID for end-to-end test calls. Never run destructive ops
against it without explicit approval — it's a real account.

---

## 9. What's next (active backlog)

- Carve `server.js` into `routes/*.js` per domain. Target: server.js
  under 4,000 lines (currently ~12,600).
- Write the OAuth plaintext drop migration after the backfill is verified
  in production. Migration 060 was repurposed for subscriptions_rls — the
  drop migration was never written. See `scripts/encrypt-oauth-tokens.js`
  for the backfill procedure.
- Real test harnesses for fake-Anthropic / fake-Inngest / fake-Supabase.
- Mutation testing on the prompt-module scoring code.
- Status page + on-call rota.

See [LEARNINGS.md](./LEARNINGS.md) for the full decision rationale on
the items above.

---

## 10. Audit hardening (2026-05-18 → 2026-05-19)

A full backend audit ran on 2026-05-18; the fixes landed across the
following turn. Highlights — read the linked code if extending these
patterns:

- **Circuit breakers wired** — `lib/breakers.js` is now actually called.
  callClaude, FB/IG publish, Replicate, DALL-E, SerpAPI, and the OpenAI
  embedding helper all route through `lib/externalHttp.js` (breaker +
  retry + per-service timeout). New external HTTP code SHOULD use it.
- **Retry-with-jitter** — `lib/retryWithJitter.js`. Composes with the
  breaker; honors `Retry-After`; respects `AbortSignal`. Tests under
  `tests/retry-with-jitter.test.js` cover the matrix.
- **Per-service timeouts** — `lib/serviceTimeouts.js`. Higgsfield gets
  90s (image gen is slow), Paddle gets 10s (fail-fast on payment), Anthropic
  25s, etc. Default is 15s.
- **Idempotency-Key middleware** — `middleware/idempotency.js` + migration 069. Mounted as `optional` on `/api/content/*`, `/api/social/*`,
  `/api/ad-campaigns/*`, `/api/email-lifecycle/*`, `/api/launch`. Flip
  to `required` after frontend rollout. Browser retries no longer
  double-fire mutations.
- **Atomic multi-table writes** — migration 071 + `sbRpc()` helper. Use
  `cold_start_initialize` and `ad_optimizer_decision` instead of two
  separate `sbPost`/`sbPatch` calls when the rows are tied.
- **JSONB validation** — `lib/eventSchemas.js` + migration 070. CHECK
  constraints enforce `payload->>'kind'` on `events`, basic shape on
  `approvals` and `decision_logs`. App-side Zod validators in
  `validateEventPayload` etc. Use them on every insert.
- **Two-phase webhook dedup** — `lib/webhookEvents.js` now marks rows
  as `received` → side-effect → `processed`/`failed`. Failed events are
  re-runnable on retry; previously they were silently swallowed by the
  PK constraint.
- **Real readiness probes** — `/readyz` actually pings Anthropic
  (`/v1/models`), Higgsfield (`/v1/models`), and reports DLQ accumulation
  - open breaker snapshot. 10s cache so a flood of probes doesn't DDoS.
- **DLQ auto-alerts** — Inngest terminal failures now ping Slack
  (`SLACK_ALERT_WEBHOOK_URL`) and Sentry. Same-function rate-limit 5 min.
- **Bounded in-process caches** — `lib/groundingContext.js` caps at 5k
  entries. Metrics registry caps at 10k label combinations. abuseDetector
  consistent 10k cap.
- **Sentry release tag** — auto-resolves to `RELEASE` env → Railway commit
  SHA → `git describe`. Source maps now match the running version.

See `LEARNINGS.md` for the audit decision rationale.
