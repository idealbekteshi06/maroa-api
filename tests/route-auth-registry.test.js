'use strict';

/**
 * Route auth registry — server.js, routes/*.js, and services registerRoutes modules.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const PUBLIC_ROUTES = new Set([
  '/',
  '/healthz',
  '/readyz',
  '/health',
  '/status',
  '/docs/openapi.yml',
  '/debug',
  '/api/billing/plans',
  '/api/waitlist/register',
  '/api/waitlist/count',
  '/api/data-deletion-status',
  '/linkedin-oauth-start',
  '/tiktok-oauth-start',
  '/twitter-oauth-start',
]);

/** Magic-link flows — token in path, no JWT (see routes/workspaces.js). */
function isTokenPublicApi(p) {
  if (/^\/api\/invites\/[^/]+\/accept$/.test(p)) return true;
  if (/^\/api\/approvals\/[^/]+$/.test(p)) return true;
  if (/^\/api\/approvals\/[^/]+\/(approve|reject)$/.test(p)) return true;
  // Hosted lead-capture form target: HMAC-signed per-business token in the
  // path, honeypot + IP throttle in the handler (routes/lead-capture.js).
  if (/^\/public\/lead-capture\/:token$/.test(p)) return true;
  return false;
}

const SIGNED_WEBHOOK_ROUTES = new Set([
  '/webhook/paddle-webhook',
  '/webhook/stripe-webhook',
  '/webhook/meta-deauthorize',
  '/webhook/meta-data-deletion-callback',
  '/webhook/data-deletion-request',
  // Meta Lead Ads intake: X-Hub-Signature-256 HMAC over raw bytes; registered
  // before the /webhook auth gate because Meta cannot carry our JWT/secret.
  '/webhook/meta-leads',
]);

const ADMIN_ROUTES_RE = /requireAdminSecret/;
const METRICS_AUTH_RE = /requireMetricsAuth/;

function collectSourceFiles() {
  const files = [path.join(ROOT, 'server.js')];
  const routesDir = path.join(ROOT, 'routes');
  for (const name of fs.readdirSync(routesDir)) {
    if (name.endsWith('.js')) files.push(path.join(routesDir, name));
  }
  const servicesDir = path.join(ROOT, 'services');
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name === 'registerRoutes.js') files.push(full);
    }
  };
  walk(servicesDir);
  return files;
}

function extractRoutesFromFile(filePath, src) {
  const rel = path.relative(ROOT, filePath);
  const routes = [];
  const lines = src.split('\n');
  const re = /^\s*app\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/;
  lines.forEach((line, i) => {
    const m = re.exec(line);
    if (m) {
      routes.push({
        file: rel,
        lineNumber: i + 1,
        method: m[1].toUpperCase(),
        path: m[2],
        full: line,
      });
    }
  });
  return routes;
}

function classify(route, serverSrc) {
  const { path: p, full } = route;

  if (PUBLIC_ROUTES.has(p)) return 'public';
  if (isTokenPublicApi(p)) return 'public';
  if (SIGNED_WEBHOOK_ROUTES.has(p)) return 'signed-webhook';
  if (ADMIN_ROUTES_RE.test(full)) return 'admin';
  if (METRICS_AUTH_RE.test(full)) return 'metrics-auth';
  if (/require(?:Any|Valid)UserId/.test(full)) return 'jwt';

  if (p.startsWith('/api/')) {
    const segments = p.split('/').filter(Boolean);
    for (let depth = segments.length; depth >= 2; depth--) {
      const prefix = '/' + segments.slice(0, depth).join('/');
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`app\\.use\\(\\s*['"\`]${escaped}['"\`]\\s*,\\s*require(?:Any|Valid)UserId`);
      if (re.test(serverSrc)) return 'jwt';
    }
    if (p.startsWith('/api/waitlist/')) return 'public';
    return 'unclassified-api';
  }

  if (p.startsWith('/webhook/')) return 'webhook';

  return 'unclassified';
}

test('route-auth-registry: server.js has global /webhook auth + business owner gate', () => {
  assert.ok(/app\.use\(\s*['"`]\/webhook['"`]\s*,\s*requireAuthOrWebhookSecret/.test(SERVER_SRC));
  assert.ok(/assertBusinessOwnerMiddleware/.test(SERVER_SRC));
});

test('route-auth-registry: every route in server.js + routes/*.js classifies', () => {
  const files = collectSourceFiles();
  const allRoutes = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    allRoutes.push(...extractRoutesFromFile(f, src));
  }
  assert.ok(allRoutes.length > 80, `expected many routes, got ${allRoutes.length}`);

  const unclassified = [];
  for (const r of allRoutes) {
    const tier = classify(r, SERVER_SRC);
    if (tier.startsWith('unclassified')) {
      unclassified.push(`${r.file}:${r.lineNumber} ${r.method} ${r.path} (${tier})`);
    }
  }
  assert.strictEqual(
    unclassified.length,
    0,
    `\n${unclassified.length} unclassified routes:\n  ${unclassified.slice(0, 25).join('\n  ')}`
  );
});

test('route-auth-registry: meta-oauth-exchange and test-email are not public', () => {
  assert.ok(!PUBLIC_ROUTES.has('/meta-oauth-exchange'));
  assert.ok(!PUBLIC_ROUTES.has('/test-email'));
  assert.ok(!PUBLIC_ROUTES.has('/metrics'));
});
