'use strict';

/**
 * services/inngest/functions.js
 * ----------------------------------------------------------------------------
 * Inngest function registry. Each function replaces a former n8n workflow.
 *
 * Currently mapped:
 *   - adOptimizerDaily   → daily 08:00 UTC → /webhook/ad-optimizer-daily-audit
 *   - pacingAlertsRun    → every 4 hours → /webhook/pacing-alerts-evaluate-all
 *   - weeklyScorecardAll → Sundays 22:00 UTC → /webhook/weekly-scorecard-all
 *
 * Each function is wrapped in step.run() so Inngest persists state per step:
 * if a downstream service returns 5xx or throws, only that step retries — the
 * rest of the workflow does not re-execute. Default retry policy is 4 retries
 * with exponential backoff.
 *
 * Implementation pattern: we POST to our own existing /webhook/* endpoints
 * over localhost. This keeps zero coupling between the Inngest layer and the
 * engine code in services/{ad-optimizer,pacing-alerts,weekly-scorecard}/. We
 * may inline the engine calls in a later refactor; for now this is the
 * lowest-risk migration path off of n8n Cloud.
 * ----------------------------------------------------------------------------
 */

const { inngest } = require('./client');

const PORT = process.env.PORT || 3000;
const INTERNAL_BASE =
  process.env.INTERNAL_API_BASE ||
  process.env.MAROA_API_INTERNAL_URL ||
  `http://127.0.0.1:${PORT}`;
const INTERNAL_SECRET = process.env.N8N_WEBHOOK_SECRET || '';

async function callInternal(path, body) {
  const res = await fetch(`${INTERNAL_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(INTERNAL_SECRET ? { 'x-webhook-secret': INTERNAL_SECRET } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    const err = new Error(
      `internal ${path} ${res.status}: ${json?.error?.message || json?.error || text.slice(0, 200)}`
    );
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// ─── Daily ad optimizer ────────────────────────────────────────────────────
// Replaces the n8n cron that ran daily at 08:00 UTC.
const adOptimizerDaily = inngest.createFunction(
  {
    id: 'ad-optimizer-daily',
    name: 'Ad optimizer · daily audit',
    retries: 3,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 8 * * *' }],
  },
  async ({ step }) => {
    const result = await step.run('run-audit-all-active', async () =>
      callInternal('/webhook/ad-optimizer-daily-audit', { dryRun: false, limit: 500 })
    );
    return { ok: true, audited: result?.audited ?? null, decisions: result?.decisions ?? null };
  }
);

// ─── Pacing alerts (every 4 hours) ─────────────────────────────────────────
const pacingAlertsRun = inngest.createFunction(
  {
    id: 'pacing-alerts-every-4h',
    name: 'Pacing alerts · evaluate all',
    retries: 3,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 */4 * * *' }],
  },
  async ({ step }) => {
    const result = await step.run('evaluate-all-active-campaigns', async () =>
      callInternal('/webhook/pacing-alerts-evaluate-all', { dryRun: false, limit: 500 })
    );
    return { ok: true, evaluated: result?.evaluated ?? null, fired: result?.fired ?? null };
  }
);

// ─── Weekly scorecard (Sunday 22:00 UTC) ───────────────────────────────────
const weeklyScorecardAll = inngest.createFunction(
  {
    id: 'weekly-scorecard-sun-22-utc',
    name: 'Weekly scorecard · generate for all',
    retries: 3,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 22 * * 0' }],
  },
  async ({ step }) => {
    const result = await step.run('generate-for-all-businesses', async () =>
      callInternal('/webhook/weekly-scorecard-all', { dryRun: false })
    );
    return { ok: true, generated: result?.generated ?? null, sent: result?.sent ?? null };
  }
);

// ─── Manual trigger handlers (for testing from Inngest dashboard) ──────────
// Send event "maroa/manual.ad-audit" to trigger an ad-optimizer run on demand.
const manualAdAudit = inngest.createFunction(
  {
    id: 'manual-ad-audit',
    name: 'Manual · ad-optimizer audit',
    retries: 1,
    triggers: [{ event: 'maroa/manual.ad-audit' }],
  },
  async ({ event, step }) => {
    const dryRun = !!event?.data?.dryRun;
    const limit = Number(event?.data?.limit || 50);
    return await step.run('run', async () =>
      callInternal('/webhook/ad-optimizer-daily-audit', { dryRun, limit })
    );
  }
);

const manualPacingRun = inngest.createFunction(
  {
    id: 'manual-pacing-alerts',
    name: 'Manual · pacing alerts',
    retries: 1,
    triggers: [{ event: 'maroa/manual.pacing-alerts' }],
  },
  async ({ event, step }) => {
    const dryRun = !!event?.data?.dryRun;
    return await step.run('run', async () =>
      callInternal('/webhook/pacing-alerts-evaluate-all', { dryRun, limit: 500 })
    );
  }
);

const manualScorecardRun = inngest.createFunction(
  {
    id: 'manual-weekly-scorecard',
    name: 'Manual · weekly scorecard',
    retries: 1,
    triggers: [{ event: 'maroa/manual.weekly-scorecard' }],
  },
  async ({ event, step }) => {
    const dryRun = !!event?.data?.dryRun;
    return await step.run('run', async () =>
      callInternal('/webhook/weekly-scorecard-all', { dryRun })
    );
  }
);

const functions = [
  adOptimizerDaily,
  pacingAlertsRun,
  weeklyScorecardAll,
  manualAdAudit,
  manualPacingRun,
  manualScorecardRun,
];

module.exports = { functions, callInternal };
