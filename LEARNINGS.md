# Maroa.ai Backend — Build Learnings, Decisions & Workflow Log

_Started 2026-04-13. Backend repo for the 15-workflow autonomous marketing system. Pairs with `../maroa-ai-marketing-automator/LEARNINGS.md` (the frontend log)._

---

## 0. Repo reality check (audit at start of V2 build-out)

| Aspect | State |
|---|---|
| Stack | Node.js 18+ / Express 4 monolith, single `server.js` (10,236 lines, 212 routes) |
| Router | No `routes/` files yet — everything is inline `app.post/get` in server.js |
| Supabase | Project `zqhyrbttuqkvmdewiytf`, REST via `sbGet/sbPost/sbPatch` helpers (lines 260–278), service-role key in `SUPABASE_KEY` |
| Migrations | 23 SQL files in `migrations/` (001–023); applied manually via Supabase SQL editor, no automated migrator |
| Claude | Direct Anthropic HTTPS via `callClaude(prompt, taskType, maxTokens, extra)` — supports `taskType` routing (strategy→Opus, social_post→Sonnet, caption→Haiku), idempotency log, budget gate per plan, retry w/ backoff, extractJSON, returnRaw, system prompt injection |
| Pinecone | Wired (`pineconeUpsert/Query`, `getBrandExamples`) — brand memory layer already live |
| Higgsfield | Service factory `services/higgsfield.js` already integrated via Segmind |
| Email | Resend via `sendEmail(to, subject, html)` + `sendEmailWithTags` for attribution |
| WhatsApp | Twilio via `sendWhatsApp(to, message)` (line 954-ish) |
| SerpAPI | `serpSearch(query, num)` helper |
| Cron | **Not implemented in-process.** Current design relies on external n8n Cloud scheduled workflows hitting webhook endpoints. Continuing that pattern: WF1 daily cron = external hit to `/webhook/wf1-run-daily` from n8n cron OR Railway scheduled job (decision below). |
| Auth | Webhook secret header `x-webhook-secret` + service-role Supabase RLS |
| Plan gate | `middleware/planGate.js` + `checkPlanLimit` enforce agency-only features and monthly AI caps (already respects brief guardrails) |
| Monthly/daily caps | `checkTokenBudgetForBusiness` in server.js enforces per-plan Claude call limits via `orchestration_logs` count |
| Idempotency | `checkOrchestrationIdempotency(userId, task, windowMs)` helper (line 478) — reuse for WF1 cron double-fire protection |
| Existing content pipeline | `/webhook/content-generate` (line 5383), `/webhook/instant-content` (1908), `/webhook/content-approve` (5556), `/webhook/content-pieces-get` — legacy v1 — will be preserved, WF1 writes into the same `generated_content` table + new `content_concepts/content_assets` for full-spec fidelity |
| Frontend contract for WF1 | `maroa-ai-marketing-automator/src/lib/api.ts` lines 259–340 — exact endpoint paths + JSON shapes — treated as the contract of record |

**Frontend contract paths (must match verbatim):**
- `POST /webhook/wf1-strategic-decision` — body `{ businessId, forceReplan? }` → `{ runId, analysis, concepts[] }`
- `POST /webhook/wf1-plan-get` (via GET in frontend with query params, but the frontend `get()` helper builds a URL — I'll implement both POST and GET for safety) — body `{ business_id, date? }` → `{ date, status, analysis, concepts[] }`
- `POST /webhook/wf1-generate-asset` — body `{ businessId, conceptId }` → `{ assetId, qualityScore }`
- `POST /webhook/wf1-decision` — body `{ businessId, conceptId, decision, editedCaption?, reason? }`
- `GET  /webhook/wf1-learning-state` — query `{ business_id }` → `{ winningPatterns[], antiPatterns[], hashtagBank[], predictionAccuracy }`
- `POST /webhook/wf1-autonomy-mode` — body `{ businessId, mode, hybridWindowHours? }`

_NB: the frontend uses `get()` for `wf1-plan-get` and `wf1-learning-state` — I register both `GET` (with query params) and `POST` variants on these routes. No harm, matches the contract either way._

---

## 1. Decisions (rationale + tradeoffs)

### 1.1 Foundation framework sharing: **copy-in-build**
The canonical strategic framework lives in `../maroa-ai-marketing-automator/src/lib/prompts/foundation.ts` (TypeScript). This backend is plain JavaScript/Node and must not add a TypeScript build step for 3 files. Options considered:

| Option | Pro | Con | Verdict |
|---|---|---|---|
| Symlink the frontend file into backend | Zero drift | Breaks when repos cloned separately (Railway deploys only this repo) | ❌ |
| npm workspace | Clean | Requires monorepo conversion + Railway build-command changes — out of scope | ❌ |
| Copy-in-build script | Simple, proven, Railway-friendly | Potential drift if script isn't run | ✅ |
| Duplicate and maintain both | Zero build deps | Drift guaranteed; violates single-source mandate | ❌ |

**Decision:** Added `scripts/sync_foundation.mjs` which reads the frontend `.ts` files, strips TypeScript type annotations with a minimal regex-based transform (sufficient for the pure-string prompt modules — they have no runtime type dependencies), and writes `services/prompts/foundation.js` + `services/prompts/workflow_1_daily_content.js` as CommonJS. Ran at dev time and in Railway's build step (`npm run build` → `node scripts/sync_foundation.mjs`). The generated files have a header banner: "AUTOGENERATED — DO NOT EDIT". This preserves the frontend as the single source of truth while giving the backend plain-require access.

**Drift protection:** the sync script fails loudly if the source file hash changes but the output hasn't been regenerated. Railway build will fail rather than ship stale prompts.

### 1.2 Cron strategy for WF1 daily 06:00 local
Options:

| Option | Pro | Con | Verdict |
|---|---|---|---|
| n8n Cloud scheduled workflow hitting `/webhook/wf1-run-daily` | Already running, zero new infra | Adds an external dep for a core feature | — |
| Railway cron (native scheduled job) | Internal, one fewer moving part | Railway cron is a hobby-plan feature; may add cost | — |
| In-process interval (setInterval on startup) | Simplest | Lost on restart, hard to time-zone per business, bad for a critical loop | ❌ |
| Supabase pg_cron + edge function → HTTP callback | Works with existing Supabase | Adds complexity, ties logic to DB | — |

**Decision:** Implement `/webhook/wf1-run-daily` as the cron target, but also run an in-process scheduler (`services/cron/wf1Daily.js`) on server boot that:
1. Computes next 06:00 for each active business in their local timezone
2. Uses `checkOrchestrationIdempotency` to prevent double-firing
3. Calls the same internal function the webhook calls

This gives us fault tolerance: if the internal scheduler dies, external cron still fires; if external cron fails, internal still runs. Idempotency guard prevents double execution.

### 1.3 Table strategy: new `content_concepts` + `content_assets` + reuse `generated_content`
The spec wants a proper concept → asset pipeline with approval gates and learning loop. Current `generated_content` conflates both. Decision:

- **New tables** for the WF1 strategic layer: `content_plans` (one per business per day), `content_concepts` (1–3 per plan), `content_assets` (one per approved concept), `content_performance` (after 48h), `learning_patterns` (winners/anti-patterns/hashtag bank)
- **Keep** `generated_content` as the legacy execution layer — WF1 writes to it when publishing, so all downstream consumers (dashboards, scoring, existing webhooks) keep working
- **New** `events`, `approvals`, `brain_decisions` tables per frontend §3.1 — unified across all workflows

### 1.4 Quality gate implementation
Two thresholds (per `AUTONOMY_MODES`):
- ≥80 → approval queue (hybrid/approve_everything modes)
- ≥95 → auto-publish (full_autopilot + hybrid after fallback window)

Scored by a second Claude call (Haiku, fast + cheap) that evaluates the generated asset against brand voice, hook strength, visual brief specificity, pattern freshness, compliance, and the strategist's own predicted engagement. Stored in `content_assets.quality_score` + `quality_breakdown` JSON.

### 1.5 Learning loop window: **48h post-publish**
Matches spec line 126 of workflow_1_daily_content.ts context bundle. Cron task `/webhook/wf1-measure-performance` runs every 30 min, picks up any published `content_assets` with `published_at < now() - 48h` AND `performance_measured_at is null`, fetches platform engagement via existing Meta Graph / TikTok / LinkedIn helpers, writes to `content_performance`, and updates `learning_patterns` (winners ≥ 1.5× baseline, anti-patterns ≤ 0.5× baseline, hashtag bank per-platform reach tracking).

### 1.6 Autonomy modes enforcement
Stored as `businesses.wf1_autonomy_mode` (new column) + `businesses.wf1_hybrid_window_hours`. Defaults to `hybrid` / 4h per spec recommendation. Enforced server-side in the cron task: after strategic decision + generation + quality gate, a single switch decides publish vs approve-queue vs wait.

### 1.7 Guardrails enforcement
Per `WF1_GUARDRAILS` constants in the frontend prompt module. Hardcoded mirror in `services/wf1/guardrails.js` (kept in sync via the same sync script). Volume caps checked against `content_posts` (new table) in 24h window. Topic cooldown against last 7d of `content_concepts.pillar + coreIdea`. Crisis auto-pause reads `events` table for `crisis.detected` entries (written by other workflows). Holiday sensitivity reads from `services/countryIntelligence.js` (already exists with 22-country holiday data) — extended with Ramadan daylight windows.

### 1.8 Test business: **Uje Karadaku** `fea4aae5-14b4-486d-89f4-33a7d7e4ab60`
All dev-mode test runs target this business_id (water brand in Kosovo, B2C DTC/local hybrid, Albanian language, Europe/Belgrade timezone). Its business model classifies as `dtc_ecommerce` with a local-services crossover — WF1 will activate the DTC playbook.

---

## 2. Audit of existing routes that overlap WF1

The current codebase has multiple routes that touch daily content generation. None of them implement the full spec. This table maps what exists vs what WF1 is replacing/extending:

| Existing route | What it does | WF1 action |
|---|---|---|
| `POST /webhook/content-generate` (L5383) | Uses Sonnet to produce a single piece of content in brand voice | Keep as v1 legacy; WF1 supersedes via `/webhook/wf1-strategic-decision` |
| `POST /webhook/instant-content` (L1908) | "Full week of content on demand" — batch generator | Keep — useful for new-user onboarding; not WF1 |
| `POST /webhook/content-approve` (L5556) | Moves `generated_content.status` → approved | Keep; WF1 writes approved-state directly via `/webhook/wf1-decision` |
| `GET /webhook/content-pieces-get` (L5531) | Reads `generated_content` | Extended to include WF1 `content_concepts` joined view |
| `POST /webhook/ai-brain-run` (L6662) | Old orchestrator | Will be WF15 target later |
| `POST /webhook/master-agent` (L7358) | Old master agent | Deprecated by WF15 |
| `POST /webhook/auto-approve-content` (L7933) | Old auto-approval path | Deprecated; WF1 has proper quality-gate path |
| `POST /webhook/publish-approved-content` (L7996) | Publishes approved pieces via platform APIs | **Reused** — WF1 auto-publish calls this directly |

**No breaking changes.** Everything under `/webhook/wf1-*` is net-new; legacy routes continue functioning so old dashboards keep working while the new V2 shell rolls out.

---

## 3. Migrations applied (per workflow)

### 3.1 WF1 — Daily Content Engine

**File:** `migrations/024_wf1_content_engine.sql` (created this session)

Adds:
- `events` (unified activity feed)
- `approvals` (unified approval queue)
- `brain_decisions` (reserved for WF15)
- `content_plans` (one per business per date)
- `content_concepts` (1–3 per plan, strategic decision output)
- `content_assets` (generated platform-native output per approved concept)
- `content_posts` (published state, joined to platform post_id)
- `content_performance` (48h post-publish engagement snapshot)
- `learning_patterns` (winners, anti-patterns, hashtag bank)
- `businesses.wf1_autonomy_mode` + `businesses.wf1_hybrid_window_hours` columns

All tables have `business_id` + `created_at` indexes, RLS enabled with service-role + user policies matching the existing pattern.

**Application status:** SQL ready; user must run in Supabase SQL editor (same manual process as migrations 001–023).

---

## 4. Endpoints added (per workflow)

### 4.1 WF1 — Daily Content Engine

| Method | Path | Purpose | Contract source |
|---|---|---|---|
| POST | `/webhook/wf1-strategic-decision` | Runs Phase 1+2 on demand. Builds context bundle from brand memory + performance + cultural + competitive + audience + business state, calls Claude Opus with `buildStrategicDecisionPrompt`, persists `content_plans` + `content_concepts` rows, returns `{ runId, analysis, concepts[] }` | frontend api.ts:264 |
| POST | `/webhook/wf1-run-daily` | Cron target + internal fallback. Iterates active businesses whose local time is between 06:00 and 06:59, runs strategic-decision for each with idempotency guard, then for each approved concept runs generation phase, then quality gate, then publish-or-queue per autonomy mode | — (cron-only) |
| POST | `/webhook/wf1-plan-get` | Fetch plan for a business (date optional, defaults to today in local TZ). Joins plan + concepts + their latest generated assets | frontend api.ts:271 |
| GET  | `/webhook/wf1-plan-get` | Same as above, GET variant (frontend's `get` helper calls GET) | — |
| POST | `/webhook/wf1-generate-asset` | On-demand Phase 3 run for a specific concept (when user approves a concept and wants the asset produced now) | frontend api.ts:311 |
| POST | `/webhook/wf1-decision` | Approve/reject/edit a concept or asset. Writes to `approvals` + `content_concepts.status` + feeds learning loop (rejection = soft anti-pattern) | frontend api.ts:318 |
| GET  | `/webhook/wf1-learning-state` | Returns current learning-loop state for the business | frontend api.ts:327 |
| POST | `/webhook/wf1-learning-state` | POST variant for parity | — |
| POST | `/webhook/wf1-autonomy-mode` | Updates `businesses.wf1_autonomy_mode` + `wf1_hybrid_window_hours` | frontend api.ts:336 |
| POST | `/webhook/wf1-measure-performance` | Cron target (every 30 min) — picks up posts ≥48h old with no performance measurement, fetches from platform, writes `content_performance`, updates `learning_patterns` | — |

---

## 5. Open handoffs (things for the next session/operator)

- [ ] Run `migrations/024_wf1_content_engine.sql` in Supabase SQL editor before hitting any `/webhook/wf1-*` endpoint
- [ ] Set Railway env var `WF1_INTERNAL_CRON=true` to enable in-process scheduler (default off; enable after first deploy)
- [ ] Configure n8n external cron or Railway scheduled job to hit `/webhook/wf1-run-daily` every 60 min (it self-filters by timezone)
- [ ] Configure n8n or Railway cron for `/webhook/wf1-measure-performance` every 30 min
- [ ] Frontend needs `wf1-plan-get` to be callable via `GET` in addition to current implementation — confirmed both variants registered
- [ ] Test business has no `events`/`approvals` rows yet — first WF1 run seeds them
