# CANONICAL_WORKFLOWS.md

> **Phase 1 deliverable (no code).** For each duplicated capability this file
> picks the **one** canonical (wired + tested) implementation and marks its
> twin **deprecated**. It is the single source of truth for **what every
> dashboard screen binds to** in Phase 3. The UI must bind only to the
> "**UI binds to**" target below — never the deprecated twin.
>
> Verified against live code on **2026-06-08**. Evidence is cited as
> `file:line`. If this drifts from `git log` + the live code, re-verify.

---

## How each call was made (decision criteria, in priority order)

1. **Firing** — is it registered in the Inngest `functions` array
   (`services/inngest/functions.js`) so it runs unattended in production?
2. **Tested** — does it have _behavioural_ tests in `tests/` (not just a
   factory-shape / contract smoke test)?
3. **Wired** — does it expose a mounted HTTP surface for on-demand calls + reads?
4. **Data model** — which tables does it write? (The UI reads _these_, so the
   canonical pick also picks the data model the screens render.)

A capability is canonical when it wins on (1)+(2). Where the firing engine
lacks an HTTP surface, that is called out as a **wiring gap** to close in
Phase 2 — it does **not** justify binding the UI to the deprecated twin.

---

## Decision summary (the cheat-sheet Phase 3 binds to)

| Capability                                  | ✅ Canonical                | ⛔ Deprecated twin                               | UI binds to (routes + tables)                                                                                           | Firing?                | Tests                                                        |
| ------------------------------------------- | --------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------ |
| **Ad optimization**                         | `services/ad-optimizer`     | `services/wf3`                                   | ad-optimizer's own routes + `manual.ad-audit` event; read `ad_audit_results`, `ad_campaigns`, `ad_performance_logs`     | cron `0 8 * * *` ✅    | `ad-optimizer*.test.js`, `meta-ads-actuator.test.js` ✅      |
| **Competitor intel**                        | `services/competitor-watch` | `services/wf5`                                   | ⚠️ **no route yet** — read `competitor_signals` (+ `compileWarRoomBriefing`); **not** wf5's `competitor_briefs`         | cron `0 */4 * * *` ✅  | `competitor-incrementality.test.js` ✅                       |
| **Email lifecycle**                         | `services/email-lifecycle`  | `services/wf7`                                   | ⚠️ **no route yet** — read `email_sequences`, `email_sequence_runs`; **not** wf7's `email_enrollments`/`email_segments` | cron `*/15 * * * *` ✅ | `email-and-pages.test.js` 🟡 (shallow)                       |
| **CRO** (conversion)                        | `services/cro`              | _(none — distinct concern)_                      | `croService` routes; read `cro_audits`                                                                                  | on-demand              | `cro.test.js` ✅                                             |
| **AI-SEO** (citability + schema + llms.txt) | `services/ai-seo`           | `services/wf6` _(schema / AI-readiness overlap)_ | `/api/ai-seo`; read `ai_seo_audits`, `ai_seo_artifacts`                                                                 | on-demand              | `ai-seo.test.js`, `routes-launch-research-ai-seo.test.js` ✅ |
| **AI-search citation monitoring**           | `services/citation-tracker` | _(none — complements ai-seo, not a twin)_        | ⚠️ **no read route yet** — read `ai_citations`, `ai_citation_prompts`                                                   | cron `0 6 * * *` ✅    | `citation-tracker.test.js` ✅                                |

Legend: ✅ firing + tested · 🟡 shallow test only · ⚠️ wiring gap to close in Phase 2.

---

## Per-capability detail + evidence

### 1. Ad optimization → `ad-optimizer` (deprecate `wf3`)

- **Canonical `ad-optimizer`** is firing (`services/inngest/functions.js:162`,
  cron `0 8 * * *` at `:169`), has a manual trigger event `manual.ad-audit`
  (`:253`/`:261`), mounts its own routes (`adOptimizer.registerRoutes`,
  `server.js:9653`), and is the best-tested engine in the repo
  (`ad-optimizer.test.js`, `ad-optimizer-decision-log.test.js`,
  `meta-ads-actuator.test.js` — including the Meta actuator).
- **Deprecated `wf3`** is a mounted-only legacy loop
  (`registerWf3Routes`, `server.js:2001`/`:9677`) with only a shallow
  prompt-wiring test (`anthropic-2026.test.js`). CLAUDE.md already labels it
  "older ad-loop engine; ad-optimizer cron is the active path."
- **This is the clean case** — canonical has cron + routes + a manual event,
  so the UI (read screens + a "run audit now" button) can bind entirely to
  `ad-optimizer` with no new wiring.

### 2. Competitor intel → `competitor-watch` (deprecate `wf5`)

- **Canonical `competitor-watch`** is firing
  (`services/inngest/functions.js:668`, cron `0 */4 * * *` at `:674`), tested
  (`competitor-incrementality.test.js`), and writes **`competitor_signals`**
  (`services/competitor-watch/index.js:179`, `:193`). It exposes a
  `compileWarRoomBriefing({ businessId, days })` function but **only
  `index.js` exists — no `registerRoutes.js`**, i.e. no HTTP surface.
- **Deprecated `wf5`** is mounted-only
  (`/webhook/wf5-run-analysis`, `/webhook/wf5-latest`, `/webhook/wf5-dashboard`
  — `services/wf_batch_routes.js:15`,`:33`,`:45`) and writes a **different**
  table, `competitor_briefs` (`services/wf5/index.js:103`) + `events` (`:116`).
- **Binding rule:** the Competitor Intel screen reads `competitor_signals`
  (the canonical output) and renders the briefing from `compileWarRoomBriefing`.
  Do **not** read `competitor_briefs` or call any `wf5-*` route.
- **Wiring gap (Phase 2):** add a thin read/trigger route (or a
  `manual.competitor-watch` Inngest event, mirroring `manual.ad-audit`) onto
  `competitor-watch` so the UI has a canonical endpoint. Until that exists the
  screen is read-only against the table — it must **not** fall back to `wf5`.

### 3. Email lifecycle → `email-lifecycle` (deprecate `wf7`)

- **Canonical `email-lifecycle`** is firing
  (`services/inngest/functions.js:591`, cron `*/15 * * * *` at `:597`) and
  writes `email_sequences` + **`email_sequence_runs`**
  (`services/email-lifecycle/index.js:75`, `:112`). Test coverage is shallow
  (`email-and-pages.test.js`) → **Phase 3 prerequisite: add a real smoke test.**
  Only `index.js` exists — **no HTTP surface.**
- **Deprecated `wf7`** is mounted-only
  (`/webhook/wf7-segment-create`, `-design-sequence`, `-enroll`,
  `-dispatch-due` — `services/wf_batch_routes.js:80`,`:89`,`:98`,`:107`,
  zero tests) and uses a **different run model**: `email_segments` (`:23`),
  `email_sequences` (`:46`), `email_enrollments` (`:57`).
- **⚠️ Latent double-writer:** _both_ engines write **`email_sequences`**
  (email-lifecycle `:75`, wf7 `:46`). Deprecating wf7 also removes the second
  writer to a shared table — do this before the UI relies on that table.
- **Binding rule:** Email screen reads `email_sequences` + `email_sequence_runs`
  (canonical). Do **not** read `email_enrollments`/`email_segments` or call
  `wf7-*` routes.
- **Wiring gap (Phase 2):** add a canonical read/enroll/trigger route on
  `email-lifecycle` (the cron only _dispatches due_ runs).

### 4. The "CRO / SEO trio" → `cro` + `ai-seo` canonical; `wf6` deprecated

These three customer-facing audit services collide in the UI as overlapping
"audit your site" screens. Resolution:

- **CRO → `services/cro` (canonical, no twin).** Distinct concern (conversion
  rate optimization of a landing page). Mounted
  (`croService.registerRoutes`, `server.js:9659`), tested (`cro.test.js`),
  writes `cro_audits` (`services/cro/engine.js:38`). Its own screen.
- **AI-SEO → `services/ai-seo` (canonical).** AI-search citability + `llms.txt`
  - JSON-LD `schema_blocks` + page rewrites. Mounted at `/api/ai-seo` with
    rate-limit + cost-guard + `requireValidUserId` (`server.js:682`/`:715`/`:735`,
    `aiSeo.registerRoutes` `:9656`), tested (`ai-seo.test.js`,
    `routes-launch-research-ai-seo.test.js`), writes `ai_seo_audits` +
    `ai_seo_artifacts` (`services/ai-seo/engine.js:50`, `:96`).
- **`services/wf6` (Local + Digital Presence) → DEPRECATED as the SEO twin.**
  It generates JSON-LD/`schema_markup_generated` (`services/wf6/index.js:64`)
  and an AI-search-readiness/`presence_audits` audit (`:45`) — **the same
  schema + readiness work ai-seo already does**, but mounted only via the batch
  routes (`/webhook/wf6-run-audit`, `-generate-schema`, `-latest-audit` —
  `services/wf_batch_routes.js:49`,`:58`,`:76`) with a shallow contract test
  (`wf-batch-contract.test.js`).
- **Binding rule:** the SEO screen binds to **`ai-seo`** (`/api/ai-seo`).
  Never expose a second SEO screen on `wf6-*`.
- **🚩 Product decision for you (not a UI duplication):** wf6 has a _unique_
  capability ai-seo lacks — **Google Business Profile / local-presence** (live
  GBP snapshot via `services/wf6/gbpSnapshot.js`, `local_rank`, NAP
  consistency). Options: **(a)** fold "Local Presence" into ai-seo as an extra
  dimension, or **(b)** keep it as a separate, clearly-scoped "Local Presence"
  feature. Either way it is **not** a second AI-SEO screen. Flagging for your
  call before Phase 3 builds the SEO surface.

### 5. AI-search citation monitoring → `citation-tracker` (canonical, _not_ a twin of ai-seo)

- `citation-tracker` is firing (`services/inngest/functions.js:644`, cron
  `0 6 * * *` at `:650`), tested (`citation-tracker.test.js`), writes
  `ai_citations` + `ai_citation_prompts`
  (`services/citation-tracker/index.js:310`, `:277`). Only `index.js` — no
  HTTP surface.
- **It complements, not duplicates, ai-seo:** ai-seo **optimizes** (makes a
  site citable); citation-tracker **measures** (are we actually cited, share of
  voice, gaps). These are _different screens_ — citation tracking belongs in
  Intelligence/monitoring, not on the AI-SEO optimization screen.
- **Wiring gap (Phase 2):** add a read route to surface `ai_citations` /
  share-of-voice; the engine itself only runs the daily sweep.

---

## Critical asymmetry — read before Phase 2/3 wiring

The duplication is **not symmetric**, and this changes the wiring work:

1. **The firing canonicals have no HTTP surface.** `competitor-watch`,
   `email-lifecycle`, and `citation-tracker` are _cron-only_ (`index.js`, no
   `registerRoutes.js`). The on-demand read/trigger endpoints currently exist
   **only on the deprecated twins** (`wf5-*`, `wf7-*`). "Bind to canonical,
   never the twin" therefore requires **building a thin canonical route (or
   `manual.*` event) first** — see each capability's _wiring gap_. The temptation
   to bind the UI to `wf5-latest`/`wf7-*` "just to ship" re-entrenches the path
   we are deprecating; don't.
2. **`email_sequences` has two writers** (email-lifecycle + wf7). Deprecating
   wf7 removes the second writer; do it before the Email screen trusts that table.
3. **Twins write different tables than canonicals** (`competitor_signals` vs
   `competitor_briefs`; `email_sequence_runs` vs `email_enrollments`). The
   canonical pick _is_ the data-model pick — Phase 3 reads the canonical tables.
4. **`ad-optimizer` is the only clean case** (cron + routes + manual event +
   strong tests). Use it as the template for the routes/events to add to the
   other canonicals.

---

## Deprecation plan for the twins (Phase 2, code — not done in Phase 1)

Mark, don't delete — engines stay until the UI is migrated and any data is
backfilled:

- Add an `@deprecated` header comment to `services/wf3`, `services/wf5`,
  `services/wf7`, and the `wf6` schema/AI-readiness paths, pointing at the
  canonical.
- Have the `wf3-*` / `wf5-*` / `wf7-*` / `wf6-*` routes log a
  one-shot deprecation warning (mirror the existing
  `tests/deprecated-webhooks.test.js` pattern) so any remaining caller is
  visible in logs.
- Do **not** drop the tables (`competitor_briefs`, `email_enrollments`,
  `email_segments`, `presence_audits`, `schema_markup_generated`) in this pass —
  schedule a drop migration only after confirming zero reads/writes in prod.

---

## Standalone capabilities (no twin — listed so Phase 3 knows they're singletons)

These have exactly one implementation and are **not** part of any duplicate
decision; bind directly:

- `services/forecasting` — ROAS/spend forecast (`forecasting.registerRoutes`,
  `server.js:9668`; `forecasting.test.js`).
- `services/voc` — voice-of-customer (`vocService.registerRoutes`,
  `server.js:9671`; `voc*.test.js`).
- `services/wf13` — weekly brief (firing cron `0 7 * * 0` + read routes).
- `services/wf10` — Higgsfield studio (`wf10-studio.test.js`).
- `services/wf15` — AI Brain (advisory; 30 tools inert — see below).
- `services/wf9` + `services/wf11` — unified inbox / SLA (no tests → Phase 3
  prerequisite: smoke test).
- `services/wf4` — reviews (no tests; publish is inert — see below).

### Advisory-only surfaces (carry these honesty constraints into Phase 3)

- **WF15 AI Brain:** 30 tools are declared but **none execute** — advisory chat
  only, no action buttons.
- **WF9 inbox:** `wf9-draft-reply` generates a suggestion; **no send path** —
  offer Copy, never Send.
- **WF4 reviews:** "publish" stores `approved_pending_publish` / returns
  `posted:false` — label "approved — not yet live," never "published."
- **Backends with no behavioural tests — WF2, WF4, WF7, WF9 — get a basic smoke
  test before any screen is wired to them** (per the goal).

---

## What Phase 1 deliberately did **not** do

- No code changes (Phase 1 is decision-only). Deprecation headers/warnings and
  the new canonical routes are Phase 2.
- No frontend build / Vercel preview: Phase 1 produces only this document in the
  **backend** repo. The dashboard lives in `maroa-ai-marketing-automator`;
  builds + previews begin with the Phase 2/3 frontend work there.

**STOP — awaiting review of this file before Phase 2.**
