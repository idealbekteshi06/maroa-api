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

## What we acknowledged but did NOT fix yet

The review also flagged two issues that remain as documented
tradeoffs rather than bugs:

### 7. Token budget race condition

The `checkTokenBudgetForBusiness` function in `server.js` does a
check-then-act: it reads the daily call count from `orchestration_logs`
and decides allow/deny, but the log write happens async after the
call succeeds. Under high concurrency, N parallel requests all see
the same pre-call count and all proceed.

**Why deferred:** The right fix is either a per-business Postgres
advisory lock (adds DB roundtrip) or a Redis-backed counter (adds a
new dep). The current `costGuard` middleware (`lib/costGuard.js`)
already provides hard $-cap enforcement via the
`llm_cost_logs` table, so this race is mostly cosmetic — a brief
spike past the call-count limit still gets stopped by the dollar cap
on the next request.

Production data will tell us whether this is worth a Phase 8 fix.

### 8. Idempotency soft-fail magnifies Supabase outages

When `lib/webhookEvents.markProcessed` can't reach the
`webhook_events` table, it soft-allows the handler to proceed. The
review correctly points out that during an outage, webhook providers
retry aggressively, and every retry will re-run the handler.

**Why deferred:** The alternative (fail-closed) means dropping
`subscription.activated` events during an outage, which is worse for
the customer than processing once and possibly twice. The right fix
is a small in-process LRU of recently-seen event_ids (5-min TTL) that
short-circuits before hitting Supabase — that gives us idempotency
even when the DB is unreachable. Phase 8 work.

### 9. Loopback HTTP exhaustion in Inngest job runner

Inngest jobs currently invoke local engine functions via
`fetch('http://127.0.0.1:3000/webhook/...')`. At high concurrency this
exhausts ephemeral ports.

**Why deferred:** Already documented in PUNCHLIST as Phase 5 work
(invoke engine functions directly). Not yet hit in practice; will be
addressed when traffic warrants.

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
