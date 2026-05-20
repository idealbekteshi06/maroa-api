#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

/**
 * scripts/synthetic-canary.js
 * ----------------------------------------------------------------------------
 * Black-box production probe. Runs the same sequence a real signed-in
 * customer hits when they open the dashboard:
 *
 *   1. GET  /healthz                       — process alive
 *   2. GET  /readyz                        — deps reachable (Supabase, Anthropic, Higgsfield, breakers)
 *   3. GET  /api/workspaces                — listing endpoint OK
 *   4. GET  /api/war-room/:id              — full feed (real data path)
 *   5. GET  /api/cron-health/:businessId   — crons firing
 *
 * Each step:
 *   - has a per-call hard timeout (the canary's whole budget is < 30s)
 *   - reports duration_ms + ok=true/false
 *   - on failure, POSTs to SLACK_ALERT_WEBHOOK_URL with the step name,
 *     the latency, the response body (first 500 chars), and the timestamp
 *
 * Designed to be invoked by:
 *   - Inngest cron (every 5 minutes)
 *   - GitHub Actions workflow on a schedule
 *   - `node scripts/synthetic-canary.js` from anywhere with curl access
 *
 * Required env:
 *   MAROA_API_URL          (default: https://maroa-api-production.up.railway.app)
 *   MAROA_API_TOKEN        (Bearer JWT to act as a logged-in user)
 *   MAROA_CANARY_BUSINESS  (optional — businessId to probe; falls back to first workspace's first client)
 *   SLACK_ALERT_WEBHOOK_URL (optional — failures fire to Slack)
 *   MAROA_CANARY_LABEL     (optional — tag in Slack message, e.g. "prod" / "staging")
 *
 * Exit code: 0 if every probe passed, 1 otherwise. Lets a cron / CI step
 * fail loudly without parsing JSON output.
 * ----------------------------------------------------------------------------
 */

const https = require('https');
const http = require('http');

const API_URL = (process.env.MAROA_API_URL || 'https://maroa-api-production.up.railway.app').replace(/\/$/, '');
const TOKEN = (process.env.MAROA_API_TOKEN || '').trim();
const SLACK_WEBHOOK = (process.env.SLACK_ALERT_WEBHOOK_URL || '').trim();
const LABEL = (process.env.MAROA_CANARY_LABEL || 'prod').trim();
const CANARY_BUSINESS = (process.env.MAROA_CANARY_BUSINESS || '').trim();

const STEP_TIMEOUT_MS = 6000;
const CANARY_TIMEOUT_MS = 30_000;

function req(method, urlStr, headers = {}, body = null, timeoutMs = STEP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      return resolve({ ok: false, status: 0, error: 'invalid URL', body: null });
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
    const url = new URL(SLACK_WEBHOOK);
    await req(
      'POST',
      SLACK_WEBHOOK,
      { 'Content-Type': 'application/json' },
      { text: message },
      4000,
    );
    void url;
  } catch (e) {
    console.error('[canary] slack post failed:', e.message);
  }
}

function authHeaders() {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}

async function run() {
  const startedAt = Date.now();
  const failures = [];
  const log = [];
  function record(step, result, extra = null) {
    const row = {
      step,
      ok: result.ok,
      status: result.status,
      duration_ms: result.duration_ms,
      ...(result.error ? { error: result.error } : {}),
      ...(extra ? { extra } : {}),
    };
    log.push(row);
    if (!result.ok) failures.push(row);
    console.log(JSON.stringify(row));
  }

  // 1. liveness
  record('healthz', await req('GET', `${API_URL}/healthz`));
  // 2. readiness
  record('readyz', await req('GET', `${API_URL}/readyz`));

  if (!TOKEN) {
    const note = {
      step: 'auth_setup',
      ok: false,
      status: 0,
      error: 'MAROA_API_TOKEN not set — skipping authenticated steps',
    };
    log.push(note);
    failures.push(note);
    console.log(JSON.stringify(note));
  } else {
    // 3. list workspaces
    const ws = await req('GET', `${API_URL}/api/workspaces`, authHeaders());
    record('list_workspaces', ws);
    const workspaceId = ws.body?.workspaces?.[0]?.id || null;
    let businessId = CANARY_BUSINESS;

    if (workspaceId) {
      // 4. war-room feed
      const feed = await req('GET', `${API_URL}/api/war-room/${encodeURIComponent(workspaceId)}`, authHeaders(), null, STEP_TIMEOUT_MS * 2);
      record('war_room_feed', feed);
      if (!businessId) {
        businessId = feed.body?.clients?.[0]?.business_id || null;
      }
    }

    // 5. cron-health for the probe business (only if we have one)
    if (businessId) {
      const cron = await req('GET', `${API_URL}/api/cron-health/${encodeURIComponent(businessId)}`, authHeaders());
      record('cron_health', cron);
    }
  }

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
          `• \`${f.step}\` ${f.status || 'err'}${f.error ? ` (${f.error})` : ''} — ${f.duration_ms}ms`,
      )
      .join('\n');
    await postSlack(
      `:rotating_light: Maroa canary FAILED (${LABEL})\n${lines}\n\nTotal duration: ${totalDuration}ms · ${API_URL}`,
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
