#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

/**
 * scripts/synthetic-canary.js
 * ----------------------------------------------------------------------------
 * Black-box production probe — public endpoints only (no auth).
 *
 *   1. GET /healthz              — 200, process alive
 *   2. GET /readyz               — 200, body.status === "ready"
 *   3. GET /api/billing/plans    — 200, plans catalog present
 *
 * Designed for GitHub Actions schedule, Inngest cron, or:
 *   MAROA_API_URL=https://maroa-api-production.up.railway.app node scripts/synthetic-canary.js
 *
 * Optional env:
 *   MAROA_API_URL | CANARY_URL | PRODUCTION_URL — API base (first non-empty wins)
 *   SLACK_ALERT_WEBHOOK_URL — Slack on failure
 *   MAROA_CANARY_LABEL — tag in alerts (default: prod)
 *
 * Exit 0 if all probes pass, 1 otherwise.
 * ----------------------------------------------------------------------------
 */

const https = require('https');
const http = require('http');

function firstEnv(...keys) {
  for (const k of keys) {
    const v = String(process.env[k] || '').trim();
    if (v) return v;
  }
  return '';
}

const API_URL = (
  firstEnv('MAROA_API_URL', 'CANARY_URL', 'PRODUCTION_URL') ||
  'https://maroa-api-production.up.railway.app'
).replace(/\/$/, '');
const SLACK_WEBHOOK = (process.env.SLACK_ALERT_WEBHOOK_URL || '').trim();
const LABEL = (process.env.MAROA_CANARY_LABEL || 'prod').trim();

const STEP_TIMEOUT_MS = 6000;
const CANARY_TIMEOUT_MS = 30_000;

function req(method, urlStr, headers = {}, body = null, timeoutMs = STEP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      return resolve({ ok: false, status: 0, error: 'invalid URL', body: null, duration_ms: 0 });
    }
    const lib = url.protocol === 'https:' ? https : http;
    const start = Date.now();
    const r = lib.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + (url.search || ''),
        headers: { Accept: 'application/json', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          const duration = Date.now() - start;
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({
            ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
            status: res.statusCode || 0,
            duration_ms: duration,
            body: parsed,
          });
        });
      },
    );
    r.setTimeout(timeoutMs, () => {
      r.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    r.on('error', (e) => {
      resolve({
        ok: false,
        status: 0,
        duration_ms: Date.now() - start,
        error: e.message,
        body: null,
      });
    });
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

async function postSlack(message) {
  if (!SLACK_WEBHOOK) return;
  try {
    await req('POST', SLACK_WEBHOOK, { 'Content-Type': 'application/json' }, { text: message }, 4000);
  } catch (e) {
    console.error('[canary] slack post failed:', e.message);
  }
}

async function run() {
  const startedAt = Date.now();
  const failures = [];
  const log = [];

  function record(step, ok, result, extra = null) {
    const row = {
      step,
      ok,
      status: result.status,
      duration_ms: result.duration_ms,
      ...(result.error ? { error: result.error } : {}),
      ...(extra ? { extra } : {}),
    };
    log.push(row);
    if (!ok) failures.push(row);
    console.log(JSON.stringify(row));
  }

  // 1. Liveness
  const healthz = await req('GET', `${API_URL}/healthz`);
  record(
    'healthz',
    healthz.ok && healthz.status === 200,
    healthz,
    healthz.body?.status ? { body_status: healthz.body.status } : null,
  );

  // 2. Readiness — must be HTTP 200 and status: ready (not 401, not 503)
  const readyz = await req('GET', `${API_URL}/readyz`);
  const readyzOk = readyz.ok && readyz.status === 200 && readyz.body?.status === 'ready';
  record('readyz', readyzOk, readyz, {
    body_status: readyz.body?.status ?? null,
    hard_failures: readyz.body?.hard_failures ?? null,
  });

  // 3. Public billing catalog ({ plans: { starter, growth, agency } } or array)
  const plans = await req('GET', `${API_URL}/api/billing/plans`);
  const catalog = plans.body?.plans;
  const planCount = Array.isArray(catalog)
    ? catalog.length
    : catalog && typeof catalog === 'object'
      ? Object.keys(catalog).length
      : 0;
  const plansOk = plans.ok && plans.status === 200 && planCount > 0;
  record('billing_plans', plansOk, plans, { plan_count: planCount });

  const totalDuration = Date.now() - startedAt;
  const summary = {
    label: LABEL,
    api_url: API_URL,
    total_duration_ms: totalDuration,
    steps: log.length,
    failures: failures.length,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify({ summary }));

  if (failures.length > 0) {
    const lines = failures
      .slice(0, 6)
      .map(
        (f) =>
          `• \`${f.step}\` HTTP ${f.status || 'err'}${f.error ? ` (${f.error})` : ''} — ${f.duration_ms}ms`,
      )
      .join('\n');
    await postSlack(
      `:rotating_light: Maroa canary FAILED (${LABEL})\n${lines}\n\nTotal: ${totalDuration}ms · ${API_URL}`,
    );
    process.exit(1);
  }

  if (totalDuration > CANARY_TIMEOUT_MS) {
    await postSlack(
      `:warning: Maroa canary slow (${LABEL}) — ${totalDuration}ms exceeded soft budget of ${CANARY_TIMEOUT_MS}ms`,
    );
  }
  process.exit(0);
}

run().catch((e) => {
  console.error('[canary] unhandled:', e.message);
  postSlack(`:rotating_light: Maroa canary CRASHED (${LABEL}) — ${e.message}`).finally(() => process.exit(1));
});
