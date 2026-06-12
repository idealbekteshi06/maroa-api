# Maroa.ai Product Assessment — 2026-06-12

**Method:** code-verified, not docs-verified. Every claim below was checked against the
code that actually executes (file:line cited), against the registered Inngest functions,
and where relevant against live production probes performed 2026-06-11. Where the
CLAUDE.md / README claims diverge from the code, the code won.

**Measured against the vision:** _sign up → one onboarding form → connect accounts →
the software runs ALL marketing autonomously ("connect and forget")._

**One-line verdict:** the decision layer is real and unusually good; the product breaks
its promise in the last mile — data capture into the loops, execution out of the loops,
and the glue between onboarding and the engines. Most of what's missing is wiring
(S/M effort), not new systems.

---

## 1. CURRENT STATE MAP — the customer journey as the code executes it

### Stage 1: Signup → business row — ⚠️ PARTIAL (two divergent paths, flags inconsistent)

- The frontend (`AuthContext.tsx:34-90`, Lovable repo) creates the `businesses` row
  directly via Supabase on first login (`is_active: true`, **no** `autopilot_enabled`),
  then fires `/webhook/new-user-signup`.
- `/webhook/new-user-signup` (server.js:3291-3451) sets `autopilot_enabled: true` **only
  in its INSERT branch** (server.js:3369). In the real flow the row already exists, so it
  takes the UPDATE branch and `autopilot_enabled` is never set. That flag gates the
  legacy approve→publish path (server.js:4208, 4236) — so that path silently no-ops for
  every normally-created account.
- Legacy data landmine: `businesses.user_id` was retrofitted with **no backfill
  migration** (only writers are post-audit code). Pre-audit rows have `user_id = NULL`,
  which (a) makes `assertBusinessOwner` 403 them, and (b) makes `AuthContext`'s
  `user_id=eq.` lookup miss → it creates a **duplicate empty business row**
  (AuthContext.tsx:53-77). Verified live: the RLS migration (091) is applied in prod and
  its satellite-table policies also key on `b.user_id = auth.uid()` — a NULL-user_id
  account sees empty dashboards everywhere.

### Stage 2: Onboarding form → profile — ⚠️ PARTIAL (rich form, most answers dropped)

- The frontend wizard collects **~83 questions** (Onboarding.tsx:185-250): USP, tagline,
  locations, operation model, languages, audience age/gender, pain points, products,
  current offer, budget, ads experience, tone keywords, never-use words, business hours,
  seasonality, up to 5 competitors + "they do better / we do better".
- The backend `/api/onboarding/save` (routes/onboarding.js:94-163) persists **~11
  fields** (business_name, industry, location, target_audience, marketing_goal,
  brand_tone, voice_seed, website_url…). Everything else — products, pains, USP,
  competitors, never-words, hours, seasonality — **is silently dropped**. The
  `onboarding_data: {...form}` blob sent to `/webhook/new-user-signup` is not persisted
  either (only named fields at server.js:3340-3351 survive).
- What DOES work well: website enrichment (lib/websiteEnricher.js:112-168 → Claude
  summary → `businesses.website_summary`, consumed by WF1 brand context), brand-voice
  extraction from the site (server.js:3403-3419 → `brand_voice_locked`), the spark/"first
  draft" moment (routes/onboarding.js:257-308 via loopback `/api/content/generate`), and
  immediate post-onboarding fires of `/webhook/instant-content` + `/api/ideas/generate`
  (Onboarding.tsx:243-250).

### Stage 3: Account connections — ⚠️ PARTIAL (2 complete, 3 token-rot, 2 operator-only, 2 missing)

| Platform                          | Flow                                                                                                                                       | Verdict                 | Evidence                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- | ---------------------------------------------------------------- |
| Meta (FB+IG+ads)                  | start→callback→long-lived token (60d) → encrypted → used by publishers + ads + insights; health probe                                      | **COMPLETE**            | services/oauth/meta.js:238-410                                   |
| Google Ads                        | offline refresh-token flow, fresh access token per call                                                                                    | **COMPLETE**            | services/oauth/google.js:185-266; google-ads-api/index.js:50-119 |
| LinkedIn                          | OAuth + publisher work; refresh token stored but **never refreshed** → silent death in 30-90d                                              | PARTIAL                 | routes/linkedin-publishing.js:68-160                             |
| Twitter/X                         | correct PKCE; same refresh-rot                                                                                                             | PARTIAL                 | routes/twitter-publishing.js:30-133                              |
| TikTok                            | correct PKCE; same refresh-rot                                                                                                             | PARTIAL                 | routes/tiktok-publishing.js:30-139                               |
| Ayrshare (Pinterest/YouTube path) | global API key + per-business `ayrshare_profile_key` set **manually by operator**; UI lists it as connectable but there is no connect flow | PARTIAL (operator-only) | services/social-multi/index.js:75-105                            |
| Resend (email)                    | global key; `resend_from_email` per business has no collection flow                                                                        | PARTIAL (operator-only) | services/integrations/index.js:102-112                           |
| WhatsApp/Twilio                   | nothing in the codebase                                                                                                                    | MISSING                 | —                                                                |
| Google Business Profile           | no OAuth; reviews come from pull-scrapers (Google Places/Trustpilot/Yelp), GBP posting API is dead (Google killed it 2024)                 | MISSING (OAuth)         | services/voc-scraper/sources/\*                                  |

Token storage itself is solid: AES-256-GCM `*_enc` columns, plaintext dropped
(migration 073), decrypt-at-boundary everywhere (lib/oauthCrypto.js).

**Meta App Review dependency:** the requested scopes (`ads_management`,
`pages_manage_posts`, `instagram_content_publish`, `business_management` —
services/oauth/meta.js:60-70) all require App Review. Until that's granted, Meta
connect+publish+ads work only for app-role test users. This is a hard external gate on
the entire vision for real customers.

### Stage 4: Autonomous marketing loops — mixed (see §5 table)

- **Content (WF1):** genuinely closest to the vision. Hourly sweep
  (functions.js:336-350) → per-business at local 06:00 → strategy (Opus) → per-concept
  generation with grounding + critic → Higgsfield image/video with Soul ID, credit
  guard, logo overlay → quality gate → **autonomy-mode routing**
  (dailyRun.js:84-125): default `hybrid` (migration 024: `wf1_autonomy_mode` DEFAULT
  'hybrid') auto-publishes ≥95 immediately and 90-94 after a 4h SLA via the
  half-hourly fallback sweep; `approve_everything` never auto-publishes. Real
  publishers exist for FB, IG feed/reel, LinkedIn, TikTok, Twitter (wf1/publish.js:20-264);
  IG story + YouTube Shorts throw "not implemented"; the gbp_post publisher calls an API
  Google discontinued.
- **The missing scheduler:** `posting_time_local` is computed and stored
  (engine.js:706) and **nothing ever reads it to publish** — the only consumers are the
  write and a dashboard display (registerRoutes.js:123). Approved content publishes
  immediately, not at the optimal time the system itself calculated.
- **Ads:** decisions are real (daily audit pulls live Meta insights, anti-thrash,
  learning-phase aware — ad-optimizer/engine.js:351-625) but execution is **dry-run by
  default** (`META_AD_LAUNCH_LIVE`, engine.js:263-319; Google actuator status-only behind
  `GOOGLE_ADS_LIVE`). There is **no import of existing campaigns** from a customer's ad
  account — only Maroa-created campaigns are managed. Campaign creation is manual
  (`/webhook/meta-campaign-create`) or via cold-start, which fires **only on first paid
  upgrade** (server.js:8457-8487), never for free signups. wf14 budget reallocation
  computes but returns `awaiting_approval` forever (wf14/index.js:86) — no actuator.
- **Email:** the engine is real (6 canonical sequences auto-created, 15-min dispatch
  cron, Resend sends) but **starved**: contacts arrive only via manual
  `/webhook/contact-create` / CSV import (routes/crm.js:59-191). No form capture, no
  purchase/cart webhooks, no Meta Lead Ads intake → for a "connect and forget" customer
  the contacts table stays empty forever. The dual-writer issue persists
  (canonical `email_sequences` vs routes/email-lifecycle.js's blast path).
- **Leads (WF2):** scoring/routing logic real; **zero inbound sources** (no Meta Lead
  Ads webhook, no form embeds). Auto-reply drafts exist but sending requires a manual
  POST. Weekly calibration reads but never adjusts anything.
- **Reviews (WF4):** drafting real; **publishing is an honest stub**
  (`posted:false, reason: platform_publish_not_implemented`, wf4/index.js:115-148); no
  scheduled review sync (voc-scraper has no cron); review data only appears if something
  manually triggers a pull.
- **SEO/CRO/citation/competitor/forecast/VoC:** run autonomously on their crons and
  produce reports/artifacts; they are read-only outputs (that's fine — they inform the
  brain).
- **Autopilot brain:** registered and firing daily (functions.js:600-610, 946). It
  collects signals from 11 pillars, resolves cross-domain conflicts and narrates a
  brief; it orchestrates and explains more than it executes — execution still lives (or
  doesn't) in each loop above.
- **Billing:** complete loop. Paddle checkout → webhook → plan lands; cancel sets
  `is_active=false` (server.js:8489-8503 — the audit fixed the old leak); first paid
  upgrade auto-triggers cold-start.

### Stage 5: Production health TODAY (live-probed 2026-06-11)

- **Dashboard quick actions hang in prod** until PR #28 (`fix/prod-connection-error`)
  merges: stale Upstash creds + an unguarded `await checkRateLimit()` → request never
  answers → "Connection error" toast. Fix is pushed and CI-green; **not merged/deployed**.
- Even after merge, **rate limiting runs degraded** until `UPSTASH_REDIS_REST_URL/TOKEN`
  are fixed on Railway (runbook updated).
- **SSE status stream is dead for all browsers** (EventSource can't send the JWT; the
  audit removed `?token=`). A stream-ticket fix exists **uncommitted** in the working
  tree (lib/streamTicket.js, routes/stream-ticket.js + middleware changes).
- CORS, JWT auth, ownership gating, readiness probes: all verified healthy in prod.

---

## 2. STRENGTHS (verified, not flattered)

1. **The closed-loop creative system is real engineering, not prompt-spaghetti.**
   Grounding (wins/losses/VoC/cohort/brand), n-best rerank, adversarial critic, quality
   gate, virality prediction, per-business brand context with website enrichment — all
   actually wired into WF1's hot path (engine.js:391-781), with prompt caching and cost
   tracking. This is the moat code.
2. **The autonomy-mode design is exactly right for the vision.** `full_autopilot /
hybrid / approve_everything` with quality thresholds and an SLA fallback sweep
   (dailyRun.js:84-125, functions.js:354-372) is the correct trust gradient — it just
   needs to be surfaced and defaulted properly.
3. **Meta + Google integrations are genuinely complete** — OAuth, encrypted tokens,
   refresh handling, live insights, real publish/actuate calls, health probes.
4. **Ops/runtime discipline is far above seed-stage norm:** 35 registered Inngest
   functions, circuit breakers + retry-with-jitter + per-service timeouts on external
   HTTP, two-phase webhook dedup, idempotency middleware, real `/readyz` (probes
   Anthropic/Higgsfield/DLQ/breakers), Prometheus + Sentry + correlation-ID logs,
   cost guard + per-plan caps, RLS tenant isolation (091), atomic RPCs (092).
5. **Test culture with teeth:** 1,866 passing tests, CI gates on lint+format+audit+
   migrations+prompt-regression, and a mutation-score ratchet (Stryker break=54,
   measured 58.49% on the money/security libs) that can only move up.
6. **Billing → entitlement → shutdown loop is closed.** Paid upgrade triggers
   cold-start; cancellation actually stops the cost-incurring crons.
7. **Honest internal accounting.** The codebase marks its own stubs (`@deprecated`
   twins, `posted:false` reasons, dry-run gates, CANONICAL_WORKFLOWS.md). Very little
   silent fakery — the dashboards' biggest lie is omission, not fabrication.

---

## 3. WEAKNESSES & GAPS (what blocks "connect and forget")

### (a) Broken code (works wrong today)

1. **Prod quick actions hang** until PR #28 merges + Railway Upstash env fixed (§1.5).
2. **SSE status stream 401s for every browser**; fix uncommitted in tree.
3. **`autopilot_enabled` is never set in the real signup flow** (INSERT-only,
   server.js:3369) → legacy approve→publish path no-ops; misleading flag for anything
   else that reads it.
4. **Legacy `user_id=NULL` rows**: 403'd by the owner gate, invisible to RLS-091
   policies, and AuthContext creates duplicate businesses for them. Needs a one-line
   backfill migration (`UPDATE businesses SET user_id = id WHERE user_id IS NULL`) that
   was never written.
5. **gbp_post publisher targets a dead API** (Google killed localPosts 2024) — will
   throw for any GBP-platform concept.
6. **Two Meta Graph versions in the publish paths** (v21.0 in social-multi vs v19.0 in
   wf1/publish.js:29) — version-deprecation time bomb.

### (b) Missing features (don't exist)

1. **No publish scheduler** — `posting_time_local` written, never consumed. The system
   computes optimal times and then ignores them.
2. **No inbound data capture**: no form-embed endpoint, no Meta Lead Ads webhook, no
   purchase/cart webhooks → email + leads loops run on an empty tank.
3. **No campaign import/sync** from existing ad accounts — Maroa only manages what it
   created.
4. **No review-sync cron** and **no review-reply publishing** (GBP/FB APIs).
5. **No token-refresh job** for LinkedIn/Twitter/TikTok (refresh tokens stored, unused).
6. **No retry for failed publishes** and no scheduler-level circuit breaking; a transient
   Meta error permanently drops the post (publish.js:250-263).
7. **Creative-engine output has no consumer** — daily ad variants land `status='queued'`
   and nothing attaches them to campaigns or tests them.
8. **Onboarding's rich answers have no storage** (83 questions → ~11 columns).

### (c) Works but needs human input where the vision says it shouldn't

1. **Ad execution behind `META_AD_LAUNCH_LIVE` / `GOOGLE_ADS_LIVE`** — deliberate
   ship-safe gates, but for paid customers this should default on (or flip per-business).
2. **Cold-start only fires on paid upgrade** — free/trial-equivalent users never get the
   competitor detection / soul training / first-campaign orchestration; also cold-start
   pauses at `await_concept_approval` by design.
3. **Hybrid mode's 4h SLA and thresholds are hardcoded** (no per-business knob surfaced;
   no onboarding question sets `wf1_autonomy_mode` — everyone silently gets `hybrid`).
4. **wf14 budget reallocation** computes then waits for an approval no UI grants.
5. **Ayrshare/Resend are operator-provisioned** — fine for 10 customers, but it's manual
   work per signup and the UI implies self-serve.

### (d) Stubbed / dry-run / external-dependency-gated

1. **Meta App Review** — all the publish/ads scopes need it; until granted, the entire
   Meta surface works only for test users. The single biggest external gate.
2. **Higgsfield is the sole media provider, no fallback** (engine comment: "no
   Replicate, no Flux"). Credits <100 → silent skip → asset created without media →
   IG/TikTok publish later fails. `HIGGSFIELD_PATH_*`/keys are not boot-validated.
3. **Review-reply publishing** — honest stub (`approved_pending_publish`).
4. **24h feedback measures Meta only** (server.js:11471-11530), and crudely (last-5-posts
   aggregate, not per-asset). LinkedIn/TikTok/Twitter posts never feed the learning loop.

---

## 4. THE ONBOARDING FORM

**Surprise finding: the form itself is excellent — the backend throws most of it away.**

The wizard already asks for nearly everything the vision needs (83 questions including
USP, products, pains, audience demographics, budget, ads experience, tone keywords,
never-use words, hours, seasonality, 5 competitors with strengths/weaknesses). Then:

- `/api/onboarding/save` persists ~11 generic fields; no `business_profiles` writer
  exists in that route; the `onboarding_data` blob is dropped (server.js:11025 even
  returns it as `null`).
- Consequence: WF1's grounding uses brand_tone + website_summary + voice_seed, but
  knows nothing about products, offers, pains, hours, seasonality, or the competitors
  the customer hand-typed — the competitor-watch service has to rediscover competitors
  via SerpAPI that the customer already named.

**Missing questions for true autonomy (small additions):**

1. **Autonomy preference** → set `wf1_autonomy_mode` (full_autopilot / hybrid /
   approve_everything) + SLA window. The column exists, defaulted, never asked.
2. **Ad budget consent**: "May Maroa launch and adjust ads up to $X/day without
   asking?" → drives `META_AD_LAUNCH_LIVE`-per-business and cold-start's campaign launch.
3. **Quiet hours / topics to avoid** (the crisis-pause guardrail exists; give it input).
4. **Review-reply policy** (auto-reply tone, star-threshold for human escalation).
5. **Where leads come from today** (forms? DMs? phone?) → which capture integrations to
   surface first.

**Fix shape:** persist the full wizard payload (JSONB `onboarding_profile` or the
existing `business_profiles` table), feed it into `buildBrandContext`/grounding, and
seed `competitors` into competitor-watch. The data is already being collected and
already being typed by the customer — this is pure plumbing (M).

---

## 5. AUTONOMY AUDIT — the honest table

Scale: **AUTO** = runs + executes externally with zero human input ·
**AUTO-GATED** = autonomous logic, blocked by a flag/threshold/approval ·
**MANUAL-FED** = engine real, but a human must supply inputs or click ·
**INERT** = produces output nothing consumes · **STUB** = visible surface, no real effect.

| Function                                             | Input data                       | Decision                  | External execution                                                  | Today's rating            | One-line truth                                                                              |
| ---------------------------------------------------- | -------------------------------- | ------------------------- | ------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| Content generation (WF1)                             | AUTO (own context + website)     | AUTO (real, grounded)     | —                                                                   | **AUTO**                  | Generates daily, per-business, unattended                                                   |
| Content publishing                                   | AUTO                             | AUTO (quality routing)    | REAL for FB/IG/LinkedIn/TikTok/X **if connected**                   | **AUTO-GATED**            | ≥95 publishes itself; 90-94 after 4h; below → human click. Stories/Shorts/GBP can't publish |
| Optimal-time scheduling                              | computed                         | computed                  | **nothing reads it**                                                | **INERT**                 | posting_time_local is decoration                                                            |
| Content learning loop                                | Meta only                        | real                      | —                                                                   | **PARTIAL**               | Non-Meta posts never teach the system                                                       |
| Ad decisions (optimizer)                             | LIVE Meta insights               | AUTO (daily, anti-thrash) | —                                                                   | **AUTO**                  | Best engine in the codebase                                                                 |
| Ad execution                                         | —                                | —                         | dry-run unless `META_AD_LAUNCH_LIVE`; Google status-only; no TikTok | **AUTO-GATED**            | Writes intent to DB, touches no ad account by default                                       |
| Ad campaign creation                                 | manual route or cold-start(paid) | real                      | gated                                                               | **MANUAL-FED**            | Nothing creates campaigns for a free signup                                                 |
| Existing-campaign import                             | —                                | —                         | —                                                                   | **MISSING**               | Maroa can't see campaigns it didn't create                                                  |
| Creative variants (daily engine)                     | AUTO                             | AUTO                      | none — `queued` forever                                             | **INERT**                 | Output has no consumer                                                                      |
| Email sequences                                      | engine AUTO                      | AUTO                      | Resend sends REAL                                                   | **MANUAL-FED**            | No contacts ever arrive on their own                                                        |
| Lead scoring/routing                                 | —                                | real                      | reply-send is manual                                                | **MANUAL-FED → STUB-ish** | No lead source exists; calibration cron spins on empty                                      |
| Reviews monitoring                                   | pull-scrapers, **no cron**       | real classify/draft       | reply publish = `posted:false` stub                                 | **STUB** (end-to-end)     | Drafts for reviews that only appear if someone triggers a pull; replies never post          |
| SEO / citations / CRO / VoC / competitor / forecasts | AUTO (crons)                     | AUTO                      | n/a (reports)                                                       | **AUTO**                  | Real autonomous analysis output                                                             |
| Autopilot brain                                      | AUTO (11 signal pillars)         | AUTO (conflict rules)     | narrates; delegates execution                                       | **AUTO (advisory)**       | Brain works; several limbs missing                                                          |
| Weekly scorecard / pacing alerts                     | AUTO                             | AUTO                      | email REAL                                                          | **AUTO**                  | Fires unattended                                                                            |
| Billing → entitlements                               | Paddle webhooks                  | real                      | real (incl. is_active=false on cancel)                              | **AUTO**                  | Closed loop                                                                                 |

**Aggregate vs the vision:** for a connected Meta customer with Higgsfield credits,
roughly the top quality-band of daily content flows end-to-end untouched and the rest
waits ≤4h or for a click; ads think but don't act; email/leads/reviews are engines
without fuel lines. Honest overall: **~30-35% of the promised autonomy is live today**,
but — crucially — most of the remaining 65% is missing _connections_, not missing
_systems_.

---

## 6. ROADMAP — make the vision real for the first 10 paying customers

Effort: **S** ≤1 day · **M** 2-4 days · **L** 1-2+ weeks. Ordered within each tier.

### MUST-HAVE BEFORE LAUNCH (the "it actually works when they sign up" tier)

| #   | Item                                                                                                                                                                                                                                                                 | Why                                                                                                      | Effort                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1   | **Merge PR #28 + fix Railway `UPSTASH_*` env**                                                                                                                                                                                                                       | Dashboard's primary buttons hang in prod right now                                                       | **S**                          |
| 2   | **Backfill migration 093: `UPDATE businesses SET user_id = id WHERE user_id IS NULL`** (+ commit the stream-ticket SSE work sitting in the tree)                                                                                                                     | Legacy accounts are 403'd/duplicated; live status bar dead                                               | **S**                          |
| 3   | **Meta App Review submission** (ads_management, pages_manage_posts, instagram_content_publish, business_management) with screencasts                                                                                                                                 | Hard external gate on everything Meta for real users; weeks of lead time — start NOW                     | **M** (effort) + external wait |
| 4   | **Wire signup → automation properly:** set `autopilot_enabled` in the UPDATE path too; fire cold-start (concept-approval phase included) for every completed onboarding, not just paid upgrades; ask the autonomy question in onboarding → write `wf1_autonomy_mode` | The vision's "from that point it runs" moment currently depends on which code path created the row       | **M**                          |
| 5   | **Persist the full onboarding payload + feed grounding** (JSONB profile; seed competitors into competitor-watch)                                                                                                                                                     | The customer already typed the gold; the AI never sees it                                                | **M**                          |
| 6   | **Publish scheduler:** 15-min Inngest sweep over approved/auto-approved assets with `posting_time_local <= now(local)`; publish via existing `publishAsset()`; add one retry pass for `failed`                                                                       | Converts "publishes whenever approved" into "publishes at the right time"; uses entirely existing pieces | **M**                          |
| 7   | **Higgsfield boot validation + text-only degradation rule** (skip IG/TikTok concepts when media can't be made, prefer FB/LinkedIn text posts that day, alert operator)                                                                                               | Today low credits silently produce unpublishable assets                                                  | **S/M**                        |
| 8   | **Token-refresh cron for LinkedIn/Twitter/TikTok** (+ surface "reconnect needed" in integrations health)                                                                                                                                                             | Connections silently rot in 30-90 days — fatal for "forget"                                              | **M**                          |

### IMPORTANT WITHIN FIRST MONTH (the "money loops get fuel and hands" tier)

| #   | Item                                                                                                                                                                                    | Why                                                                    | Effort  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------- |
| 9   | **Flip ad actuators live per-business** (consent question from onboarding → `ads_live` column overriding env gates; keep caps + anti-thrash)                                            | Decisions already good; let them act for consenting paid customers     | **S/M** |
| 10  | **Campaign import/sync** (pull existing campaigns + adsets into `ad_campaigns` on Meta connect; nightly sync)                                                                           | Most SMBs already run something; day-1 value + optimizer scope         | **M**   |
| 11  | **Lead/contact capture v1:** hosted form endpoint + embeddable snippet + **Meta Lead Ads webhook** → contacts + auto-enroll welcome sequence + hot-lead auto-notify                     | Fuels BOTH email and leads loops — highest leverage single integration | **M/L** |
| 12  | **Reviews loop closure:** scheduled Places/Yelp/Trustpilot pull (daily), and reply-publishing via GBP Business Profile API where available (else "copy & open" deep-link UX as interim) | Turns the best-looking stub into a real differentiator                 | **M/L** |
| 13  | **Cross-platform feedback:** per-asset insight fetch by `platform_post_id` for LinkedIn/TikTok/X + per-asset (not last-5-aggregate) Meta metrics                                        | The learning loop currently learns from one platform, crudely          | **M**   |
| 14  | **Creative-engine consumer:** attach top queued variant as a small-budget A/B inside the optimizer's daily run (it already computes promote/kill)                                       | Stops generating into the void                                         | **M**   |
| 15  | **wf14 budget reallocation actuator** behind the same consent flag, capped                                                                                                              | Completes the ads brain                                                | **S/M** |
| 16  | **Email single-writer cleanup + per-customer from-address flow** (collect + verify domain or use branded subdomain)                                                                     | Deliverability + the dual-schema trap                                  | **M**   |

### LATER (after first 10 customers are running)

- IG Stories + YouTube Shorts publishers; replace dead GBP posting path. (**M**)
- Ayrshare self-serve linking flow or drop it from the UI. (**S/M**)
- Onboarding-driven quiet-hours/topic guardrails; per-business SLA window UI. (**S**)
- Failed-publish retry policy w/ breaker + dead-letter surfacing to the brain brief. (**M**)
- WhatsApp/Twilio channel (net-new). (**L**)
- Behavioral tests for WF2/WF7/WF9 + raise the mutation ratchet past 54 (planGate/businessMemory/webhookEvents now covered; serviceTimeouts 21.6% and idempotency 34.3% are next-weakest). (**M, ongoing**)
- Unify Meta Graph version; boot-time env validation for all media/social providers. (**S**)
- Autopilot brain: from narrator to executor — let it trigger the (now-live) actuators it already reasons about. (**M/L**)

### Sequencing logic

Items 1-2 are _today_ (prod is bleeding). Item 3 starts immediately because the wait is
external. Items 4-8 make the core promise true for content — the loop that's 90% built.
Items 9-16 then give the ads/email/leads/reviews loops their missing inputs and hands.
Nothing in the must-have tier is **L** — the gap between this codebase and its vision is
weeks of focused wiring, not a rebuild.
