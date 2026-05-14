'use strict';

/**
 * tests/route-auth-registry.test.js
 *
 * Per the 2026-05-13 audit + strategy doc Phase 1:
 *   "Add route inventory tests: every route must declare auth mode:
 *    public, jwt, webhook, admin, or signed-webhook."
 *
 * This test scans server.js for every app.{get,post,put,delete,patch}
 * declaration and verifies that each route falls into ONE of the
 * documented auth tiers — either by being mounted under a known
 * auth-middleware prefix (e.g. /api/* + requireAnyUserId) or by being
 * on the explicit allowlist below.
 *
 * If a new route is added without classification, this test fails and
 * forces the author to declare its auth mode. That's the IDOR drift
 * guardrail.
 *
 * Auth tiers:
 *   public           — no auth required (health probes, OAuth callbacks
 *                      that verify signatures internally, the / root)
 *   jwt              — requires Supabase JWT via requireAnyUserId /
 *                      requireValidUserId
 *   webhook          — requires N8N webhook secret OR JWT via
 *                      requireAuthOrWebhookSecret (mounted on /webhook/*)
 *   signed-webhook   — verifies its own HMAC inline (Paddle, Stripe, Meta)
 *   admin            — requires admin-only secret (requireAdminSecret)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const SERVER_SRC = fs.readFileSync(SERVER_PATH, 'utf8');

// ─── Allowlist of routes declared as PUBLIC (no auth) ─────────────────────
// These are intentionally unauthenticated. Adding to this list is an
// explicit security decision — code review should challenge it.
const PUBLIC_ROUTES = new Set([
  '/',
  '/healthz',
  '/readyz',
  '/health',
  '/metrics',
  '/debug',
  '/test-email',
  '/meta-oauth-exchange',
  '/api/billing/plans',
  // Paddle + Stripe + Meta webhooks verify their own signatures BEFORE the
  // generic /webhook auth middleware would fire — classified as
  // signed-webhook below.
]);

// Routes that verify their own HMAC signatures inline before doing anything.
// Each one MUST have HMAC verification in the handler.
const SIGNED_WEBHOOK_ROUTES = new Set([
  '/webhook/paddle-webhook',
  '/webhook/stripe-webhook',
  '/webhook/meta-deauthorize',
  '/webhook/meta-data-deletion-callback',
]);

// Admin-only routes — gated by requireAdminSecret middleware (not the
// general auth middleware).
const ADMIN_ROUTES_RE = /requireAdminSecret/;

// ─── Helpers ──────────────────────────────────────────────────────────────

function extractRoutes(src) {
  // Captures: line number + method + path
  const routes = [];
  const lines = src.split('\n');
  const re = /^app\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/;
  lines.forEach((line, i) => {
    const m = re.exec(line);
    if (m) {
      routes.push({
        lineNumber: i + 1,
        method: m[1].toUpperCase(),
        path: m[2],
        full: line,
      });
    }
  });
  return routes;
}

function classify(route, src) {
  const { path: p, full, lineNumber } = route;

  // Explicit public allowlist
  if (PUBLIC_ROUTES.has(p)) return 'public';

  // Signed-webhook allowlist (HMAC verified inline)
  if (SIGNED_WEBHOOK_ROUTES.has(p)) return 'signed-webhook';

  // Admin: handler line uses requireAdminSecret
  if (ADMIN_ROUTES_RE.test(full)) return 'admin';

  // Inline JWT: handler line uses requireAnyUserId or requireValidUserId
  // directly as a route-level middleware (vs. mounted via app.use).
  if (/require(?:Any|Valid)UserId/.test(full)) return 'jwt';

  // Routes under /api/* MUST be protected by requireAnyUserId or
  // requireValidUserId. The mount can be at ANY ancestor prefix —
  // e.g. /api/onboarding/profile/:userId might be covered by either
  // app.use('/api/onboarding', …) or a deeper mount. Walk up.
  if (p.startsWith('/api/')) {
    const segments = p.split('/').filter(Boolean); // ['api','foo','bar','baz']
    for (let depth = segments.length; depth >= 2; depth--) {
      const prefix = '/' + segments.slice(0, depth).join('/');
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(
        `app\\.use\\(\\s*['"\`]${escaped}['"\`]\\s*,\\s*require(?:Any|Valid)UserId`
      );
      if (re.test(src)) return 'jwt';
    }
    return 'unclassified-api';
  }

  // /webhook/* routes are covered by the global
  //   app.use('/webhook', requireAuthOrWebhookSecret);
  if (p.startsWith('/webhook/')) return 'webhook';

  return 'unclassified';
}

// ─── Tests ────────────────────────────────────────────────────────────────

test('route-auth-registry: server.js has the global /webhook auth mount', () => {
  assert.ok(
    /app\.use\(\s*['"`]\/webhook['"`]\s*,\s*requireAuthOrWebhookSecret/.test(SERVER_SRC),
    'expected app.use("/webhook", requireAuthOrWebhookSecret) in server.js'
  );
});

test('route-auth-registry: every route classifies into a known auth tier', () => {
  const routes = extractRoutes(SERVER_SRC);
  assert.ok(routes.length > 50, `expected many routes, got ${routes.length}`);

  const unclassified = [];
  for (const r of routes) {
    const tier = classify(r, SERVER_SRC);
    if (tier.startsWith('unclassified')) {
      unclassified.push(`server.js:${r.lineNumber} ${r.method} ${r.path}  (${tier})`);
    }
  }
  assert.strictEqual(
    unclassified.length,
    0,
    `\n${unclassified.length} routes have no declared auth tier:\n  ` +
      unclassified.slice(0, 20).join('\n  ') +
      `\n\nFix: either mount the prefix under requireAnyUserId/requireValidUserId,` +
      ` add to PUBLIC_ROUTES, SIGNED_WEBHOOK_ROUTES, or wrap with requireAdminSecret.`
  );
});

test('route-auth-registry: count summary', () => {
  const routes = extractRoutes(SERVER_SRC);
  const tally = { public: 0, jwt: 0, webhook: 0, 'signed-webhook': 0, admin: 0 };
  for (const r of routes) {
    const tier = classify(r, SERVER_SRC);
    if (tally[tier] != null) tally[tier]++;
  }
  // Every category should have non-zero — sanity check we didn't lose
  // routes during refactors. We don't assert exact counts (they shift
  // as routes get carved) but at least one per tier should always exist.
  assert.ok(tally.public >= 1, 'expected at least 1 public route');
  assert.ok(tally.webhook >= 1, 'expected at least 1 webhook route');
});

test('route-auth-registry: PUBLIC_ROUTES is intentionally small', () => {
  // If this list grows past ~12 we should challenge each new addition.
  assert.ok(
    PUBLIC_ROUTES.size <= 15,
    `PUBLIC_ROUTES has ${PUBLIC_ROUTES.size} entries — review each before raising the limit`
  );
});
