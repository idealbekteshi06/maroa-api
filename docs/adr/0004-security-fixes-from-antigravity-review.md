# ADR-0004: Security fixes from the 2026-05-11 Antigravity adversarial review

**Date:** 2026-05-11 · **Status:** Accepted

## Context

After shipping Phase 1-6 + Phase 7 hardening (~15k lines across 50+
files, 656 tests passing), we ran an adversarial AI review via Google
Antigravity. The review found 9 real issues — 4 critical security bugs
we'd missed plus 5 reliability/architecture concerns. This ADR records
how we addressed each one.

The review was unfiltered "try to break this code" mode, not
flattering pattern-matching. It paid off: catching the IDOR alone
prevented a complete authorization bypass that would have let any
Free-tier user access Agency features by guessing UUIDs.

## What we fixed

### 1. IDOR in `middleware/planGate.js` — CRITICAL

**Bug:** The middleware validated `business_id` format and looked up
the business's plan, but **never verified that the authenticated user
actually owned that business_id**. Result: a Free-tier customer
could pass any Agency-customer UUID and get Agency features.

**Fix:** Added JWT extraction (via `req.user.id` from
`requireAuthOrWebhookSecret`) + cross-check against
`businesses.user_id`. New `getBusinessPlanAndOwner()` returns both
plan and owner so we can compare in one query. Webhook-secret-authed
requests (internal cron) skip the ownership check.

Logs `IDOR attempt blocked — user X requested feature Y on business Z
owned by W` so attempted attacks surface in Sentry.

### 2. Information disclosure in OAuth `/health` endpoints — CRITICAL

**Bug:** `/webhook/oauth/meta/health` and `/webhook/oauth/google/health`
returned `ad_account_id`, `facebook_page_id`, `instagram_account_id`,
`google_customer_id`, `google_oauth_email`, and connection timestamps
for any `?businessId=<uuid>` — **with zero authentication**. Anyone
who could enumerate UUIDs could harvest Meta + Google IDs for every
customer.

**Fix:** Applied the same auth model as the OAuth `/start` endpoints
(see ADR-0002): require JWT (`Bearer` header OR `?token=` query),
verify the JWT user owns `businessId`, then run the original probe.

### 3. Crypto downgrade attack in `lib/oauthCrypto.readToken` — CRITICAL

**Bug:** The read helper caught `decrypt()` errors and silently fell
back to reading the legacy plaintext column. If an attacker had DB
write access (e.g. compromised service-role key, SQL injection
elsewhere), they could overwrite `*_enc` with garbage to force a
decrypt error, then write their own attacker-controlled token into
the legacy plaintext column. The app would happily accept it.

**Fix:** Distinguish "pre-backfill state" (`*_enc` is NULL — legitimate
legacy fallback) from "tampered state" (`*_enc` IS set but decrypt
throws — propagate the error to caller). The latter case now throws
`decrypt failed` instead of silently downgrading.

Updated `tests/oauth-crypto.test.js` to lock in the new behavior:
corrupted blob now triggers an assertion error rather than silent
fallback.

### 4. Memory DoS in `middleware/planLimits.js` — IMPORTANT

**Bug:** To check monthly usage, the middleware fetched the entire
result set (`SELECT id FROM usage_logs WHERE ... created_at >= ...`)
and called `.length` on it. At 15k rows/month per agency user, this
allocated and parsed a 15k-element JSON array on every paid-tier API
call.

**Fix:** Switched to `HEAD /rest/v1/usage_logs?...` with
`Prefer: count=exact`. PostgREST returns the count in the
`Content-Range` header without sending any rows. Memory is now O(1)
regardless of usage volume.

Added `parseContentRangeCount()` helper that parses
`Content-Range: 0-9/47` format → `47`.

### 5. Unbounded memory growth in `lib/abuseDetector.js` — IMPORTANT

**Bug:** The abuse detector kept a `Map` keyed by `req.ip` with no
size cap. An attacker spoofing many `X-Forwarded-For` values (or
distributed sources) could force the Map to grow until OOM crash.

**Fix:** Added `MAX_IPS = 10_000` cap. When adding a new IP that would
exceed the cap, evict the IP with the oldest recent-activity
timestamp (approximate LRU via `mostRecentTs()` scan). The eviction
is O(n=10000) but only happens when the cap is full, which is rare in
practice.

### 6. Graceful shutdown hung on keep-alive connections — IMPORTANT

**Bug:** `server.close()` waits for ALL existing connections to close
before invoking its callback. Browsers + load balancers keep
persistent connections open, so this hung for the full 30-second
deadman window on every deployment. Our "graceful" shutdown was
effectively a hard-kill.

**Fix:** Tracked every open socket via `server.on('connection')`.
During shutdown, after stopping new connection acceptance, we call
`socket.end()` on each tracked socket (graceful close) + set a 5-second
timer that hard-`socket.destroy()` anything still open. Typical
shutdown now completes in <2s instead of 30s.

## What we initially deferred — and then fixed anyway

The three items below were originally documented as Phase 8 tradeoffs.
After re-reading the review with fresh eyes the same evening, we
decided each had a low-risk fix worth shipping. All three are now
fixed; the original deferred reasoning is preserved for posterity.

### 7. Token budget race condition — FIXED

**Original concern:** `checkTokenBudgetForBusiness` did a check-then-
act: read daily call count from `orchestration_logs`, decide allow/
deny, log async after the call. Under concurrency N parallel requests
all saw the same pre-call count and all proceeded.

**Fix shipped:** `lib/budgetCounter.js` — atomic INCR via Upstash
Redis. Each (businessId, UTC date) gets a counter key. Per call we
INCR (returns new value atomically), check vs limit, DECR if over.
TTL of 25h auto-cleans counters. When Redis isn't configured we fall
back to the legacy racy check (with `mode='legacy'` flag in the
return value so callers can log it).

The `costGuard` $-cap remains as a secondary belt-and-suspenders
check in case Upstash is misconfigured.

### 8. Idempotency soft-fail during Supabase outages — FIXED

**Original concern:** When `webhookEvents.markProcessed` couldn't
reach the `webhook_events` table, it soft-allowed the handler. Webhook
providers retry aggressively during outages → handler runs N times.

**Fix shipped:** `lib/webhookEvents.js` now checks an in-process LRU
(1000 entries, 5-min TTL) BEFORE the Supabase call. The LRU marks
events as seen immediately, so even if the Supabase write fails,
subsequent retries within 5 minutes short-circuit cleanly.

Caveat: each Railway instance has its own LRU. Multi-instance
deployments still benefit because providers retry within seconds and
typically hit the same instance (sticky load balancing + same TCP
connection). For full cross-instance dedup we'd need Redis (an option
left open in the comment).

### 9. Loopback HTTP exhaustion in Inngest — FIXED

**Original concern:** Inngest functions called local engines via
`fetch('http://127.0.0.1:3000/...')`. Each call opened a fresh TCP
socket → port exhaustion under nightly cron load.

**Fix shipped:** `services/inngest/functions.js` now uses a pooled
keep-alive `http.Agent` for all loopback calls. `_loopbackPost`
routes loopback URLs through the agent (maxSockets:50,
maxFreeSockets:10, keepAlive:true). Non-loopback URLs fall through to
regular fetch.

Result: connection reuse instead of per-call socket creation. Same
throughput, no port exhaustion. The longer-term refactor (invoke
engine functions directly without HTTP) is still documented in
PUNCHLIST but no longer urgent.

## Consequences

**Positive:**

- 6 real security/reliability bugs closed in production within hours
  of being found.
- The 3 deferred items are now in a written tradeoff record, not
  unspoken assumptions.
- Confidence that adversarial AI review catches things human review
  doesn't — worth budgeting for again after any major branch.

**Negative:**

- The IDOR fix subtly changes the planGate contract: routes that were
  webhook-secret-only now skip the user ownership check correctly,
  but any route that was JWT-auth + had `planGate` mounted now
  requires the user to actually own the business. There may be edge
  cases (admin tools, support workflows) where this breaks workflows.
  Monitor Sentry for "IDOR attempt blocked" log lines that are
  actually legitimate users.

## Operational notes

- **Test all paid-tier endpoints** after this commit lands: confirm
  the user can still access their own business's data on every
  endpoint that uses `planGate`.
- The OAuth `/health` endpoints now require JWT — if the frontend
  dashboard was polling them unauthenticated, those polls will start
  returning 401.
- Migration 060 (drop legacy plaintext OAuth columns) becomes
  important now: the crypto downgrade fix means rows where `_enc` is
  set must decrypt cleanly. Run `scripts/encrypt-oauth-tokens.js`
  backfill + verify before dropping plaintext.
