# FULL_SYSTEM_AUDIT.md

> **Audit date:** 2026-06-08 · **Updated:** 2026-06-14 (Generate-Now root cause
> **CONFIRMED** against the live Vite code — see Part 1). · **Launch target:** June 20.

---

## 0. Scope & verification limits (read this first — it changes how to read everything below)

This audit was requested across **two** repos. I can only access **one** of them
from this session. I am stating that up front rather than papering over it,
because the honesty of the rest depends on it.

| What                                                                        | Access                                                                                                                                                                                                          | Consequence                                                                                                                                                                               |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`maroa-api`** (backend)                                                   | ✅ full source, this repo                                                                                                                                                                                       | Backend findings below are **code-verified** (with `file:line`).                                                                                                                          |
| **`maroa-ai-marketing-automator`** (LIVE Vite frontend)                     | ⚠️ **read-only via GitHub global code-search** — `search_code` returns code _fragments_ (the repo is public); `get_file_contents` + all writes are **denied** (session scope = `maroa-api`); not cloned locally | Enough to **confirm the Generate-Now root cause** by reading the real handlers (Part 1). **Cannot** enumerate every screen (Part 2), read exact line numbers, or **write/build** the fix. |
| **Live running system** (`maroa-api-production.up.railway.app`, `maroa.ai`) | ❌ **egress blocked** — a direct `curl` from this session returns `403 host_not_allowed` from the sandbox proxy (not the backend)                                                                               | I could **not** probe real request/response shapes against prod. Findings are from source at the current `main`.                                                                          |

**Two consequences you need to know before launch:**

1. **The recent "Wave 1" dashboard-wiring work — commit `44da828` and PR #25 —
   was done in `maroa-api/frontend` (the Next.js app).** You have confirmed that
   app is **ABANDONED**; the live product is the Vite repo. **Therefore those
   changes do NOT fix the live "Generate Now."** Any prior report implying the
   dashboard P0s were "done" was true only for the dead Next.js app. This is the
   single most important correction in this document.
2. **The Generate-Now root cause is now CONFIRMED** (Part 1) by reading the live
   Vite code via GitHub code-search — a `.maybeSingle()` bug in `AuthContext.tsx`.
   _Applying_ the fix + building still need a session scoped to
   **`maroa-ai-marketing-automator`** (writes are denied here). Items needing the
   full repo or live runtime remain tagged **[UNVERIFIED]**.

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
The reported symptom is _"nothing happens, no draft, **no error shown**."_ A
backend that returns 400/401/404/422/429/500 cannot by itself produce a _silent_
result. **So the defect is on the frontend** — the request is either not sent,
sent wrong, or its error is swallowed.

### Frontend side — root cause — ✅ CONFIRMED (read from the live Vite code via GitHub code-search)

I read the live handler chain directly from `maroa-ai-marketing-automator`
(public repo, commit `f4c6404`) via GitHub global code-search. The bug is in
**business selection**, not the generate call.

**`src/contexts/AuthContext.tsx`** resolves the signed-in user's business with:

```ts
const { data, error } = await externalSupabase
  .from('businesses')
  .select('id, onboarding_complete')
  .eq('user_id', userId)
  .maybeSingle(); // ← ROOT CAUSE
// ...
if (data) {
  setBusinessId(data.id);
  setOnboardingComplete(data.onboarding_complete ?? null);
}
```

Supabase `.maybeSingle()` **throws when more than one row matches.** The reported
account has **two** `businesses` rows (`onboarding_complete:true` `fea4aae5-…` and
`:false` `7a9c3057-…`). So `.maybeSingle()` errors → `data` is `null` →
`setBusinessId()` never runs → **`businessId` stays `null` app-wide.**

**`src/components/dashboard/DashboardContent.tsx`** then bails on its
`if (!businessId …) return;` guards — including the Generate-Now handler that
would call `generateContentNow(businessId, …)`. So **no `POST /api/content/generate`
is ever fired, and nothing is shown** — exactly the network-tab symptom. (The API
layer is fine: `src/lib/apiClient.ts` `generateContentNow()` attaches the auth
header and throws on non-2xx — it is simply never reached.)

**Secondary effect:** when `.maybeSingle()` errors, AuthContext falls into its
"no business → `.insert([...])`" branch, which can **create duplicate businesses**
on load — the likely reason this account has two.

**The fix (in the Vite repo — cannot be applied or built from this session):**

1. `src/contexts/AuthContext.tsx` — drop `.maybeSingle()`; select all, prefer the
   onboarded business, and only insert when the result is genuinely empty:
   ```ts
   const { data, error } = await externalSupabase
     .from('businesses')
     .select('id, onboarding_complete')
     .eq('user_id', userId)
     .order('onboarding_complete', { ascending: false }) // onboarded first
     .order('created_at', { ascending: true });
   const biz = (data ?? []).find((b) => b.onboarding_complete) ?? (data ?? [])[0] ?? null;
   if (biz) {
     setBusinessId(biz.id);
     setOnboardingComplete(biz.onboarding_complete ?? null);
   } else if (!error && (data ?? []).length === 0) {
     /* existing insert-new-business branch */
   }
   ```
2. `src/components/dashboard/DashboardContent.tsx` — never fail silently:
   `if (!businessId) { toast.error("Still finishing setup — refresh, or finish onboarding."); return; }`,
   and surface `err.message` in the generate handler's `catch`.

---

## PART 2 — Frontend↔Backend wiring map

**[UNVERIFIED — needs Vite repo]** I cannot enumerate what the live Vite screens
actually call. What I **can** give is the **verified backend endpoint inventory**
— the targets a correct frontend _should_ hit — so the mapping is half-done and
ready to complete against the Vite repo.

| Capability                       | Backend endpoint (exists in `maroa-api`)                                    | Backend status                                              |
| -------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Instant content / "Generate Now" | `POST /api/content/generate` (`server.js:4681`)                             | **WORKS** (real Claude gen + save)                          |
| Connection status                | `GET /api/business/:id/integrations` (`server.js:4837`)                     | **WORKS** (live Meta token probe)                           |
| Connect Meta/Google              | `GET /webhook/oauth/{meta,google}/start` (`services/oauth/*`)               | **WORKS** (real OAuth; LinkedIn/TikTok start routes absent) |
| Plans                            | `GET /api/billing/plans` (`server.js:4616`, public)                         | **WORKS** (static catalog `lib/planCatalog.js`)             |
| Email lifecycle                  | `GET /api/business/:id/email-lifecycle` + `-process-due/-enroll/-bootstrap` | **WORKS** (canonical engine)                                |
| Competitor intel                 | `/webhook/competitor-watch-scan` / `-briefing` (creative-engine routes)     | **WORKS if PR #23 merged** — verify on `main`               |
| Ad optimization                  | `ad-optimizer` routes + `manual.ad-audit`                                   | **WORKS but dry-run** (see Part 3)                          |
| AI Brain (WF15)                  | `/webhook/wf15-*`                                                           | **PARTIAL** — chat real, tools inert (Part 3)               |
| Inbox (WF9/WF11)                 | `/webhook/wf9-*`, `/webhook/wf11-*`                                         | **READ ok; no send path** (Part 3)                          |
| Reviews (WF4)                    | `/webhook/wf4-*`                                                            | **publish is inert** (Part 3)                               |
| Studio (WF10)                    | `/webhook/wf10-*`                                                           | real media gen (needs Higgsfield keys)                      |
| CRO / AI-SEO / Forecasting / VoC | `croService` / `/api/ai-seo` / `forecasting` / `voc` routes                 | **WORKS** (on-demand)                                       |

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
  - `engine.js` gate all live Meta writes behind `META_AD_LAUNCH_LIVE=true`
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

What happens **server-side** at each step (what the user _sees_ needs the Vite repo):

1. **Signup** → Supabase magic-link auth. Backend creates/links a `businesses`
   row in the onboarding path (`sbPost('businesses', …)` `server.js:3273`).
   **Gap risk:** if the user reaches the dashboard _before_ that insert,
   `business_id` is null → Generate Now / any `/api/business/:id/*` call 400/404s.
2. **Onboarding** → profile save + (per backend) a cold-start orchestration can
   fire. Real.
3. **First dashboard** → if it shows KPIs/queue, confirm they're live reads vs
   placeholder — **[UNVERIFIED]** in the Vite app. (The dead Next.js app used mock
   data here; the Vite app must be checked.)
4. **Quick Actions** → backend endpoints exist (Part 2). But: **Generate Now is
   reported broken (Part 1)**; ad actions are **dry-run**; inbox can't send;
   reviews can't publish. So the promise _"Your AI is handling everything"_ is, on
   the backend, **"your AI drafts and recommends; humans approve, and several
   actions are advisory or gated."** That gap is real and a launch-messaging risk.

---

## PART 5 — Launch-blocker list (launch June 20)

### P0 — breaks the core promise / blocks launch

1. **"Generate Now" does nothing on the live Vite app — ROOT CAUSE CONFIRMED.**
   `.maybeSingle()` in `src/contexts/AuthContext.tsx` throws for the 2-business
   test account → `businessId` is `null` → `DashboardContent.tsx`'s `!businessId`
   guard bails → no request fired, silently. **Fix (full code in Part 1):** in
   AuthContext, drop `.maybeSingle()` → select-all + prefer-onboarded; in
   DashboardContent, show a visible error instead of a silent return. **Must be
   applied in the Vite repo** (writes denied from this session); the backend
   `POST /api/content/generate` is already correct. Also fixes the duplicate-
   business creation side effect.
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

- The _full_ Vite frontend — I read the auth + generate handlers via code-search
  and confirmed Part 1, but could not read every screen/file, exact line numbers,
  or the deploy's env-var values.
- The live deployment's real request/response behavior (egress blocked).
- Whether `META_AD_LAUNCH_LIVE` (and the other `LIVE_FLAGS`) are `true` in Railway prod.
- Whether PR #23's canonical competitor/email routes are merged into the running build.

**To unblock:** grant this session access to `maroa-ai-marketing-automator` (or
run a parallel audit there), and/or allowlist `maroa-api-production.up.railway.app`
for egress so I can probe real responses. I will then complete Parts 2 & 4 and
confirm the Generate-Now root cause with `file:line` in the Vite repo.
