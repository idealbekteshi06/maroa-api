# Maroa.ai — Project Knowledge Base

> **Last updated:** 2026-05-11. If this is more than a quarter old, treat
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

**Pricing tiers:** `free` · `growth ($49/mo)` · `agency ($99/mo)` —
enforced by `middleware/planGate.js` + `middleware/planLimits.js` +
`lib/costGuard.js`.

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

The 28 original n8n workflows are now implemented as a mix of HTTP
endpoints and Inngest functions. Each `services/wf*` folder contains the
engine. The schedule lives in `services/inngest/functions.js`.

| #   | Service                       | Trigger                           | Status                    |
| --- | ----------------------------- | --------------------------------- | ------------------------- |
| 01  | `services/wf1/`               | Inngest daily 09:00 UTC           | live                      |
| 02  | `services/ad-optimizer/`      | Inngest daily 08:00 UTC           | live                      |
| 03  | `services/wf3/`               | webhook `/new-user-signup`        | live                      |
| 04  | retention                     | inlined in scorecard              | merged                    |
| 05  | `services/wf5/`               | Inngest Mon 10:00 UTC             | live                      |
| 06  | `services/wf6/`               | Inngest Sun 22:00 UTC             | live (weekly-scorecard)   |
| 07  | `services/wf7/`               | every 6h                          | live                      |
| 08  | `services/wf8/`               | daily 08:00 UTC                   | live                      |
| 09  | `services/higgsfield.js`      | on-demand (Soul ID, image, video) | live                      |
| 10  | `services/wf10/`              | webhook on account-connected      | live                      |
| 12  | `services/wf12/`              | weekly                            | live                      |
| 13  | `services/wf13/`              | weekly synthesis                  | live                      |
| 14  | `services/wf14/`              | Fri 14:00 UTC                     | live (competitor)         |
| 15  | `services/wf15/`              | webhook `/instant-content`        | live (AI Brain)           |
| 22  | `services/voc/`               | weekly                            | live                      |
| 26  | `services/creative-engine/`   | event-driven (refresh on low CTR) | live                      |
| 28  | ~~Google My Business poster~~ | **REMOVED**                       | Google API killed in 2024 |

Plus new capabilities born after the migration:

- `services/cro/` — landing-page CRO audit + rewrites
- `services/ai-seo/` — AI-search citability + llms.txt + JSON-LD
- `services/forecasting/` — ROAS + spend forecast 30/60/90
- `services/cold-start/` — onboarding orchestrator
- `services/social-multi/` — Ayrshare + Meta Graph publish
- `services/pacing-alerts/` — every-4h ad-spend pacing
- `services/competitor-watch/` — competitor intelligence
- `services/citation-tracker/` — AI-citation tracking
- `services/email-lifecycle/` — day 1/3/7/14/30 emails
- `services/autopilot-brain/` — top-level orchestrator (Week 12)

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
  under 4,000 lines.
- Migration 060 — drop plaintext OAuth columns after backfill verified.
- Real test harnesses for fake-Anthropic / fake-Inngest / fake-Supabase.
- Mutation testing on the prompt-module scoring code.
- Status page + on-call rota.

See [LEARNINGS.md](./LEARNINGS.md) for the full decision rationale on
the items above.
