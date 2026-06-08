# FULL_SYSTEM_AUDIT.md

> **Audit date:** 2026-06-08 · **Auditor scope:** this session can read the
> **`maroa-api` backend repo only.** · **Launch target:** June 20.

---

## 0. Scope & verification limits (read this first — it changes how to read everything below)

This audit was requested across **two** repos. I can only access **one** of them
from this session. I am stating that up front rather than papering over it,
because the honesty of the rest depends on it.

| What | Access | Consequence |
| --- | --- | --- |
| **`maroa-api`** (backend) | ✅ full source, this repo | Backend findings below are **code-verified** (with `file:line`). |
| **`maroa-ai-marketing-automator`** (LIVE Vite frontend) | ❌ **not accessible** — not in this session's GitHub scope, no repo-add tooling available, not cloned locally (`/home/user` contains only `maroa-api`) | **Parts 2 & 4, and the frontend half of Part 1, CANNOT be verified here.** I do not guess frontend code. |
| **Live running system** (`maroa-api-production.up.railway.app`, `maroa.ai`) | ❌ **egress blocked** — a direct `curl` from this session returns `403 host_not_allowed` from the sandbox proxy (not the backend) | I could **not** probe real request/response shapes against prod. Findings are from source at the current `main`. |

**Two consequences you need to know before launch:**

1. **The recent "Wave 1" dashboard-wiring work — commit `44da828` and PR #25 —
   was done in `maroa-api/frontend` (the Next.js app).** You have confirmed that
   app is **ABANDONED**; the live product is the Vite repo. **Therefore those
   changes do NOT fix the live "Generate Now."** Any prior report implying the
   dashboard P0s were "done" was true only for the dead Next.js app. This is the
   single most important correction in this document.
2. To actually close Parts 2 & 4 and confirm the Generate-Now root cause, run an
   audit in a session scoped to **`maroa-ai-marketing-automator`**, or add that
   repo to this session. Everything I *can't* verify is tagged **[UNVERIFIED —
   needs Vite repo]**.

---

## PART 1 — The broken core loop: "Generate Now" does nothing

### Backend side — VERIFIED (code)

`POST /api/content/generate` (`server.js:4681`) is **real and functional**:

- **Auth required.** `app.use('/api/content', requireAnyUserId)` (`server.js:808`)
  — the request must carry a valid Supabase JWT (or user id). No auth → **401**.
- **`business_id` required.** `server.js:4685` → missing → **400 `VALIDATION_ERROR`**.
- **Business must exist.** `server.js:4700` → unknown id → **404 `BUSINESS_NOT_FOUND`**
  ("Finish onboarding first").
- **Rate-limited** (`gen:<id>`, `server.js:4688`) → **429 `RATE_LIMITED`**.
- **Compliance gate** can return **422 `COMPLIANCE_HARD_BLOCK`** (`server.js:4740`).
- **Success** → `200 { ok:true, content:{...} }` (`server.js:4749`), synchronous,
  after a real Claude generation + image fetch + DB save (`generateInstantContent`,
  `server.js:3339`).

**CORS is ruled OUT as a cause.** `lib/corsAllow.js` allowlists
`https://maroa.ai`, `https://www.maroa.ai`,
`https://maroa-ai-marketing-automator.lovable.app`,
`https://maroa-ai-marketing-automator.vercel.app`, and `http://localhost:5173`
(Vite dev). A request from the live origin is not CORS-blocked.

**Key inference:** every backend failure path returns an **explicit HTTP error**.
The reported symptom is *"nothing happens, no draft, **no error shown**."* A
backend that returns 400/401/404/422/429/500 cannot by itself produce a *silent*
result. **So the defect is on the frontend** — the request is either not sent,
sent wrong, or its error is swallowed.

### Frontend side — root cause — **[UNVERIFIED — needs Vite repo]**

I cannot read the Vite handler, so I am ranking hypotheses by likelihood given
the backend contract + the exact symptom ("silent, no error"). Each lists the
**precise thing to check** in `maroa-ai-marketing-automator`.

1. **Most likely — fresh user has no `business_id`, and the click handler bails
   silently.** A brand-new account has no `businesses` row until onboarding runs
   the insert (`server.js:3273`). If the Vite handler does
   `if (!businessId) return;` with **no** toast/redirect, the click does exactly
   nothing — matching the symptom perfectly. **Check:** the Generate-Now `onClick`
   in the Vite repo — does it guard on a missing/empty `businessId` and return
   without surfacing anything? Where does it source `businessId`?
2. **`VITE_API_URL` unset / wrong in the live deploy.** Vite inlines `import.meta.env.VITE_*`
   at **build time**. If the production build lacks `VITE_API_URL`, calls go to a
   relative `/api/content/generate` on `maroa.ai` (no backend there) → 404 HTML →
   JSON parse throws → if caught silently, nothing renders. **Check:** the API
   base-URL constant + the deploy's env vars (Lovable/Vercel project settings).
3. **Missing auth header.** If the fetch doesn't attach the Supabase
   `access_token`, backend returns **401**; if the handler swallows non-2xx,
   nothing shows. **Check:** does the API client attach `Authorization: Bearer`?
4. **Silent catch.** A `try/catch` that logs to console but renders no toast/error
   state would hide all of the above. **Check:** the catch block on the generate call.

> **I am not claiming which of these it is** — that requires the Vite source.
> But #1 and #2 are the highest-probability given a *silent* failure for a
> *fresh* user, and both are quick to confirm with the repo open.

---

## PART 2 — Frontend↔Backend wiring map

**[UNVERIFIED — needs Vite repo]** I cannot enumerate what the live Vite screens
actually call. What I **can** give is the **verified backend endpoint inventory**
— the targets a correct frontend *should* hit — so the mapping is half-done and
ready to complete against the Vite repo.

| Capability | Backend endpoint (exists in `maroa-api`) | Backend status |
| --- | --- | --- |
| Instant content / "Generate Now" | `POST /api/content/generate` (`server.js:4681`) | **WORKS** (real Claude gen + save) |
| Connection status | `GET /api/business/:id/integrations` (`server.js:4837`) | **WORKS** (live Meta token probe) |
| Connect Meta/Google | `GET /webhook/oauth/{meta,google}/start` (`services/oauth/*`) | **WORKS** (real OAuth; LinkedIn/TikTok start routes absent) |
| Plans | `GET /api/billing/plans` (`server.js:4616`, public) | **WORKS** (static catalog `lib/planCatalog.js`) |
| Email lifecycle | `GET /api/business/:id/email-lifecycle` + `-process-due/-enroll/-bootstrap` | **WORKS** (canonical engine) |
| Competitor intel | `/webhook/competitor-watch-scan` / `-briefing` (creative-engine routes) | **WORKS if PR #23 merged** — verify on `main` |
| Ad optimization | `ad-optimizer` routes + `manual.ad-audit` | **WORKS but dry-run** (see Part 3) |
| AI Brain (WF15) | `/webhook/wf15-*` | **PARTIAL** — chat real, tools inert (Part 3) |
| Inbox (WF9/WF11) | `/webhook/wf9-*`, `/webhook/wf11-*` | **READ ok; no send path** (Part 3) |
| Reviews (WF4) | `/webhook/wf4-*` | **publish is inert** (Part 3) |
| Studio (WF10) | `/webhook/wf10-*` | real media gen (needs Higgsfield keys) |
| CRO / AI-SEO / Forecasting / VoC | `croService` / `/api/ai-seo` / `forecasting` / `voc` routes | **WORKS** (on-demand) |

**To finish Part 2:** open the Vite repo, grep its API client for each path above,
and tag each screen WIRED-AND-WORKING / CALLS-BUT-BROKEN / NOT-WIRED / NO-BACKEND.

---

## PART 3 — Backend reality check (VERIFIED, code)

**Canonical engines** (per `CANONICAL_WORKFLOWS.md`, in-repo): ad-optimizer,
competitor-watch, email-lifecycle, ai-seo, cro. Deprecated twins `wf3/wf5/wf6/wf7`
are `@deprecated` and should not be bound. **The frontend mapping (canonical vs
twin) can't be confirmed without the Vite repo** — but the backend canonical set
is correct and the twins are marked.

**Things that are real:** content generation, integrations health probe, billing
catalog, email-lifecycle engine, CRO/AI-SEO/forecasting/VoC, OAuth (Meta/Google),
WF15 chat (conversational text), WF9 triage/draft, review classification/drafting.

**Things gated, stubbed, or inert — do NOT present as fully working:**

- **Ad execution is DRY-RUN by default.** `services/ad-optimizer/launcher.js:145`
  + `engine.js` gate all live Meta writes behind `META_AD_LAUNCH_LIVE=true`
  (`lib/env.js:226` `LIVE_FLAGS = META_AD_LAUNCH_LIVE, META_PUBLISH_LIVE,
  GOOGLE_ADS_LIVE, TIKTOK_ADS_LIVE`). It **decides and logs** scale/pause/budget
  but does **not** change real campaigns unless the flag is set. **Whether it's
  set in prod is UNVERIFIABLE from this session** (can't read Railway env / can't
  probe). Treat as "advisory until confirmed live."
- **WF15 AI Brain: 30 tools are declared but none execute.** Chat is advisory;
  there is no tool-execution path. Don't ship "the AI does it for you" framing.
- **WF9 inbox: no send path.** `wf9-draft-reply` produces a suggestion; nothing
  sends it. Copy-only.
- **WF4 reviews: "publish" is inert** — stores `approved_pending_publish` /
  returns `posted:false`. Never claims live posting.
- **Higgsfield credit balance is a stub** (`getBalance()`; migration 089 comment)
  → credit guard only works when an operator seeds `HIGGSFIELD_DEFAULT_CREDITS`.
- **Citation-tracker needs external keys** (DataForSEO / Perplexity); engine
  adapters return `null` (no-op) when keys are absent.
- **RESERVED / not wired:** `video_clips`, `businesses.higgsfield_element_ids`,
  `businesses.higgsfield_product_id` (migration 089 `COMMENT`s). No UI should imply these work.
- **`email_sequences` had 3 writers** (canonical + `routes/email-lifecycle.js` +
  wf7). Consolidated by migration 090 / PR #24 (now on `main`) — verify applied.

---

## PART 4 — The client's-eye journey

**[PARTIAL — backend behavior VERIFIED; the live Vite UX is UNVERIFIED]**

What happens **server-side** at each step (what the user *sees* needs the Vite repo):

1. **Signup** → Supabase magic-link auth. Backend creates/links a `businesses`
   row in the onboarding path (`sbPost('businesses', …)` `server.js:3273`).
   **Gap risk:** if the user reaches the dashboard *before* that insert,
   `business_id` is null → Generate Now / any `/api/business/:id/*` call 400/404s.
2. **Onboarding** → profile save + (per backend) a cold-start orchestration can
   fire. Real.
3. **First dashboard** → if it shows KPIs/queue, confirm they're live reads vs
   placeholder — **[UNVERIFIED]** in the Vite app. (The dead Next.js app used mock
   data here; the Vite app must be checked.)
4. **Quick Actions** → backend endpoints exist (Part 2). But: **Generate Now is
   reported broken (Part 1)**; ad actions are **dry-run**; inbox can't send;
   reviews can't publish. So the promise *"Your AI is handling everything"* is, on
   the backend, **"your AI drafts and recommends; humans approve, and several
   actions are advisory or gated."** That gap is real and a launch-messaging risk.

---

## PART 5 — Launch-blocker list (launch June 20)

### P0 — breaks the core promise / blocks launch

1. **"Generate Now" does nothing on the live Vite app.** Root cause is
   frontend-side (Part 1) — **[confirm in Vite repo]**. Most likely: missing
   `business_id` with a silent guard, or unset `VITE_API_URL`, or missing auth
   header, or a silent catch. **Fix:** (a) ensure `VITE_API_URL` is set in the
   live build → `https://maroa-api-production.up.railway.app`; (b) attach the
   Supabase `Authorization: Bearer` token; (c) guard `businessId` with a *visible*
   state ("finish onboarding") not a silent return; (d) on any non-2xx, render the
   backend error + on 200 render `content`. The backend already returns everything
   needed — this is purely surfacing it.
2. **Audit the LIVE frontend at all.** Until someone audits `maroa-ai-marketing-automator`,
   you are launching on a frontend nobody in this thread has verified end-to-end.
   This is itself a P0 process gap. **Fix:** run Parts 2 & 4 in a session scoped to that repo.
3. **Don't let abandoned-frontend work mask live gaps.** PR #25 / `44da828` are on
   the dead Next.js app. **Fix:** close/ignore them for launch purposes; do not
   count them as live fixes.

### P1 — visible but degraded

- **Fresh-user empty states** — if the dashboard renders mock/placeholder data
  (as the dead app did), a new user sees fake numbers. **[Verify in Vite repo.]**
- **Ad optimizer dry-run** — if `META_AD_LAUNCH_LIVE` is unset in prod, "ads are
  running" is untrue; the UI must say "recommendations" not "live changes."
- **Advisory-only surfaces** (WF15 tools, WF9 send, WF4 publish) presented as
  fully autonomous would over-promise.

### P2 — polish

- LinkedIn/TikTok "connect" have no backend OAuth start route → must be "coming soon."
- Citation-tracker / Higgsfield credits need keys to be non-no-op.

---

## What I could NOT verify (explicit, per your instruction)

- Any Vite frontend code (handlers, env usage, API client, screens, mock data).
- The live deployment's real request/response behavior (egress blocked).
- Whether `META_AD_LAUNCH_LIVE` (and the other `LIVE_FLAGS`) are `true` in Railway prod.
- Whether PR #23's canonical competitor/email routes are merged into the running build.

**To unblock:** grant this session access to `maroa-ai-marketing-automator` (or
run a parallel audit there), and/or allowlist `maroa-api-production.up.railway.app`
for egress so I can probe real responses. I will then complete Parts 2 & 4 and
confirm the Generate-Now root cause with `file:line` in the Vite repo.
