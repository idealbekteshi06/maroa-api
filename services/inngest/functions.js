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
const { dlqHandler } = require('./dlqRecorder');

// Auto-attach DLQ recorder to every function unless caller already specified
// one. Keeps the function definitions clean while guaranteeing every
// terminal failure lands in inngest_dlq for replay + observability.
function withDLQ(opts) {
  if (opts.onFailure) return opts;
  const eventName =
    opts.triggers?.[0]?.event || (opts.triggers?.[0]?.cron ? `cron:${opts.triggers[0].cron}` : 'unknown');
  return { ...opts, onFailure: dlqHandler({ functionId: opts.id, eventName }) };
}

const PORT = process.env.PORT || 3000;
const INTERNAL_BASE = process.env.INTERNAL_API_BASE || process.env.MAROA_API_INTERNAL_URL || `http://127.0.0.1:${PORT}`;
const INTERNAL_SECRET = process.env.N8N_WEBHOOK_SECRET || '';

// ─── keep-alive HTTP agent for loopback calls ────────────────────────────
// Fixes ADR-0004 item #9 (Antigravity adversarial review): without
// connection pooling, each Inngest invocation opened a fresh TCP socket
// to localhost:3000. Under nightly cron load (hundreds of jobs) this
// exhausts ephemeral ports → ECONNRESET. With keep-alive we re-use up
// to 50 pooled sockets per destination.
const http = require('http');
const _loopbackAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60_000,
});

function _loopbackPost(urlString, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const bodyStr = JSON.stringify(body || {});
    const req = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port) || 80,
        path: u.pathname + u.search,
        method: 'POST',
        agent: _loopbackAgent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          ...(INTERNAL_SECRET ? { 'x-webhook-secret': INTERNAL_SECRET } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json;
          try {
            json = data ? JSON.parse(data) : {};
          } catch {
            json = { raw: data.slice(0, 500) };
          }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ ok: true, status: res.statusCode, json });
          resolve({ ok: false, status: res.statusCode, json, text: data });
        });
      }
    );
    req.setTimeout(60_000, () => req.destroy(new Error(`loopback request timeout: ${u.pathname}`)));
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// In-process dispatcher — eliminates HTTP loopback when routes are
// registered. Falls back to HTTP for unregistered routes (backwards
// compatible during incremental migration). See lib/internalDispatcher.js.
const _internalDispatcher = require('../../lib/internalDispatcher');

async function callInternal(path, body) {
  const url = `${INTERNAL_BASE}${path}`;
  const isLoopback = url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:');

  // ─── Try in-process dispatch first (loopback case only) ─────────────────
  // Same-process Inngest invocations skip HTTP entirely — no TCP, no JSON
  // round-trip, no port exhaustion. Routes opt in by calling
  // internalDispatcher.register() at boot. Handler throws propagate naturally
  // (matching the HTTP 5xx → throw contract that Inngest retries handle).
  if (isLoopback) {
    const inProcess = await _internalDispatcher.dispatch(path, body);
    if (!inProcess?._notRegistered) {
      return inProcess;
    }
    // _notRegistered → fall through to HTTP loopback below
  }

  // Loopback path uses pooled keep-alive agent; non-loopback (staging
  // override etc.) falls through to fetch which is fine at lower volumes.
  if (isLoopback) {
    const r = await _loopbackPost(url, body);
    if (!r.ok) {
      const err = new Error(
        `internal ${path} ${r.status}: ${r.json?.error?.message || r.json?.error || (r.text || '').slice(0, 200)}`
      );
      err.status = r.status;
      err.body = r.json;
      throw err;
    }
    return r.json;
  }

  const res = await fetch(url, {
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
    onFailure: dlqHandler({ functionId: 'ad-optimizer-daily', eventName: 'cron' }),
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
  withDLQ({
    id: 'pacing-alerts-every-4h',
    name: 'Pacing alerts · evaluate all',
    retries: 3,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 */4 * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('evaluate-all-active-campaigns', async () =>
      callInternal('/webhook/pacing-alerts-evaluate-all', { dryRun: false, limit: 500 })
    );
    return { ok: true, evaluated: result?.evaluated ?? null, fired: result?.fired ?? null };
  }
);

// ─── Weekly scorecard (Sunday 22:00 UTC) ───────────────────────────────────
const weeklyScorecardAll = inngest.createFunction(
  withDLQ({
    id: 'weekly-scorecard-sun-22-utc',
    name: 'Weekly scorecard · generate for all',
    retries: 3,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 22 * * 0' }],
  }),
  async ({ step }) => {
    const result = await step.run('generate-for-all-businesses', async () =>
      callInternal('/webhook/weekly-scorecard-all', { dryRun: false })
    );
    return { ok: true, generated: result?.generated ?? null, sent: result?.sent ?? null };
  }
);

// ─── Content publish · 24h performance feedback ───────────────────────────
// Replaces the in-process setTimeout(24h) that lived in server.js. The
// previous in-memory timer was lost on every Railway redeploy — feedback
// only fired for posts that happened to survive a full 24h of uptime, so
// most posts silently never got scored.
//
// Now: server.js emits `maroa/content.publish.feedback-24h` on publish.
// This durable function sleeps 24h (Inngest persists the timer), then
// POSTs to the existing internal feedback endpoint with contentId +
// businessId. Survives redeploys, retries on failure, observable in the
// Inngest dashboard.
const contentPublishFeedback24h = inngest.createFunction(
  {
    id: 'content-publish-feedback-24h',
    name: 'Content publish · 24h performance feedback',
    retries: 3,
    // One feedback check per (business, content). Concurrency keyed on
    // contentId so multiple posts from same business can run in parallel.
    concurrency: { limit: 1, key: 'event.data.contentId' },
    onFailure: dlqHandler({
      functionId: 'content-publish-feedback-24h',
      eventName: 'maroa/content.publish.feedback-24h',
    }),
    triggers: [{ event: 'maroa/content.publish.feedback-24h' }],
  },
  async ({ event, step }) => {
    const { contentId, businessId } = event?.data || {};
    if (!contentId || !businessId) {
      return { ok: false, reason: 'missing contentId or businessId' };
    }
    await step.sleep('wait-24h', '24h');
    const result = await step.run('fetch-and-score', async () =>
      callInternal('/webhook/wf-content-performance-feedback', { contentId, businessId })
    );
    return { ok: true, contentId, businessId, ...result };
  }
);

// ─── Manual trigger handlers (for testing from Inngest dashboard) ──────────
// Send event "maroa/manual.ad-audit" to trigger an ad-optimizer run on demand.
const manualAdAudit = inngest.createFunction(
  withDLQ({
    id: 'manual-ad-audit',
    name: 'Manual · ad-optimizer audit',
    retries: 1,
    // Per-business concurrency — two different customers can trigger manual
    // audits in parallel, but a single customer can't double-fire.
    concurrency: { limit: 1, key: 'event.data.businessId' },
    triggers: [{ event: 'maroa/manual.ad-audit' }],
  }),
  async ({ event, step }) => {
    const dryRun = !!event?.data?.dryRun;
    const limit = Number(event?.data?.limit || 50);
    return await step.run('run', async () => callInternal('/webhook/ad-optimizer-daily-audit', { dryRun, limit }));
  }
);

const manualPacingRun = inngest.createFunction(
  withDLQ({
    id: 'manual-pacing-alerts',
    name: 'Manual · pacing alerts',
    retries: 1,
    concurrency: { limit: 1, key: 'event.data.businessId' },
    triggers: [{ event: 'maroa/manual.pacing-alerts' }],
  }),
  async ({ event, step }) => {
    const dryRun = !!event?.data?.dryRun;
    return await step.run('run', async () =>
      callInternal('/webhook/pacing-alerts-evaluate-all', { dryRun, limit: 500 })
    );
  }
);

const manualScorecardRun = inngest.createFunction(
  withDLQ({
    id: 'manual-weekly-scorecard',
    name: 'Manual · weekly scorecard',
    retries: 1,
    concurrency: { limit: 1, key: 'event.data.businessId' },
    triggers: [{ event: 'maroa/manual.weekly-scorecard' }],
  }),
  async ({ event, step }) => {
    const dryRun = !!event?.data?.dryRun;
    return await step.run('run', async () => callInternal('/webhook/weekly-scorecard-all', { dryRun }));
  }
);

// Send event "maroa/manual.competitor-watch" to run a per-business competitor
// War Room scan on demand (canonical engine — not the deprecated wf5 twin).
const manualCompetitorWatch = inngest.createFunction(
  withDLQ({
    id: 'manual-competitor-watch',
    name: 'Manual · competitor War Room scan',
    retries: 1,
    concurrency: { limit: 1, key: 'event.data.businessId' },
    triggers: [{ event: 'maroa/manual.competitor-watch' }],
  }),
  async ({ event, step }) => {
    const businessId = event?.data?.businessId;
    if (!businessId) return { ok: false, reason: 'missing businessId' };
    return await step.run('scan', async () => callInternal('/webhook/competitor-watch-scan', { businessId }));
  }
);

// Send event "maroa/manual.email-lifecycle" to process due email-sequence runs
// on demand (canonical engine — not the deprecated wf7 twin).
const manualEmailLifecycle = inngest.createFunction(
  withDLQ({
    id: 'manual-email-lifecycle',
    name: 'Manual · email lifecycle process',
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ event: 'maroa/manual.email-lifecycle' }],
  }),
  async ({ step }) => {
    return await step.run('process-due', async () => callInternal('/webhook/email-lifecycle-process-due', {}));
  }
);

// ─── WF1 daily content sweep (hourly) ─────────────────────────────────────
// Replaces the in-process setInterval that used to live in server.js. The
// underlying engine (services/wf1/dailyRun) iterates each business and only
// fires when local clock hits 06:xx — so an hourly cron is correct.
const wf1DailySweepHourly = inngest.createFunction(
  withDLQ({
    id: 'wf1-daily-sweep-hourly',
    name: 'WF1 · daily content sweep',
    retries: 3,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 * * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('sweep-all-businesses', async () =>
      callInternal('/webhook/wf1-run-daily', { force: false })
    );
    return { ok: true, processed: result?.processed ?? null };
  }
);

// ─── WF1 measurement + hybrid fallbacks (hourly, staggered :30) ───────────
// Runs at minute 30 of every hour so it doesn't collide with the sweep at :00.
const wf1MeasureFallbacksHourly = inngest.createFunction(
  withDLQ({
    id: 'wf1-measure-fallbacks-hourly',
    name: 'WF1 · measurement + hybrid fallbacks',
    retries: 3,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 30 * * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('measure-and-fallback', async () =>
      callInternal('/webhook/wf1-measure-performance', { limit: 25 })
    );
    return {
      ok: true,
      measured: result?.measurement?.measured ?? null,
      fallbacks: result?.hybridFallbacks?.processed ?? null,
    };
  }
);

// Drains content_assets parked for their posting_time_local slot. Every 15 min.
// concurrency:1 + the atomic scheduled→publishing claim inside the sweep mean a
// slow run that overlaps the next tick, or a step retry, can never double-post.
const wf1ScheduledPublish = inngest.createFunction(
  withDLQ({
    id: 'wf1-scheduled-publish',
    name: 'WF1 · scheduled publishing (posting_time_local)',
    retries: 3,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC */15 * * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('publish-due', async () =>
      callInternal('/webhook/wf1-scheduled-publish', { limit: 25 })
    );
    return {
      ok: true,
      due: result?.due ?? null,
      processed: result?.processed ?? null,
      reclaimed: result?.reclaimed ?? null,
    };
  }
);

// Keeps LinkedIn/Twitter/TikTok OAuth alive: refresh tokens were stored at
// connect time and never used, so access tokens rotted (2h-60d) and connected
// platforms died silently. Daily 04:00 UTC; rejected refresh tokens flip
// <platform>_connected=false and emit oauth.reconnect_required.
const oauthTokenRefreshDaily = inngest.createFunction(
  withDLQ({
    id: 'oauth-token-refresh-daily',
    name: 'OAuth · LinkedIn/Twitter/TikTok token refresh',
    retries: 3,
    triggers: [{ cron: 'TZ=UTC 0 4 * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('refresh-all', async () =>
      callInternal('/webhook/oauth-token-refresh', { limit: 200 })
    );
    return {
      ok: true,
      businesses: result?.businesses ?? null,
      refreshed: result?.refreshed ?? null,
      reconnectRequired: result?.reconnectRequired ?? null,
    };
  }
);

// ─── WF1 overnight batch submit (nightly 23:00 UTC) ───────────────────────
// Consolidates every active business's WF1 strategic-decision call into ONE
// Anthropic Message Batch — 50% Sonnet cost cut on overnight bulk content.
// Single-fire — retries: 1 to avoid double-submission.
const wf1OvernightBatchSubmitNightly = inngest.createFunction(
  withDLQ({
    id: 'wf1-overnight-batch-submit-nightly',
    name: 'WF1 · overnight batch submit',
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 23 * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('submit-overnight-batch', async () =>
      callInternal('/webhook/wf1-overnight-batch-submit', { dryRun: false })
    );
    return {
      ok: true,
      anthropicBatchId: result?.anthropicBatchId ?? null,
      submitted: result?.submitted ?? null,
    };
  }
);

// ─── WF1 overnight batch poll + apply (every 10 min) ──────────────────────
// Scans anthropic_batches for in-flight wf1_overnight batches and applies any
// that have reached `ended`. Safe to run more often than necessary; idempotent.
const wf1OvernightBatchApplyPoll = inngest.createFunction(
  withDLQ({
    id: 'wf1-overnight-batch-apply-poll',
    name: 'WF1 · overnight batch apply (poll)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC */10 * * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('apply-all-inflight', async () =>
      callInternal('/webhook/wf1-overnight-batch-apply-all', {})
    );
    return {
      ok: true,
      scanned: result?.scanned ?? 0,
      applied: result?.applied ?? 0,
      errors: result?.errors ?? 0,
    };
  }
);

// ─── Anthropic non-WF1 batch reconcile (every 5 min) ──────────────────────
// Reconciles in-flight Anthropic batches that aren't owned by WF1 (those go
// through their own apply path above). Generic poll for all other batch users.
const anthropicBatchReconcilePoll = inngest.createFunction(
  withDLQ({
    id: 'anthropic-batch-reconcile-poll',
    name: 'Anthropic · non-WF1 batch reconcile (poll)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC */5 * * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('reconcile-all-inflight', async () =>
      callInternal('/webhook/anthropic-batch-reconcile-all', {})
    );
    return {
      ok: true,
      scanned: result?.scanned ?? 0,
      reconciled: result?.reconciled ?? 0,
      errors: result?.errors ?? 0,
    };
  }
);

// ─── Daily Creative Engine (every day at 09:00 UTC, after ad audit) ──────
// Generates 3-5 new ad variants per business and queues them for testing.
// Plan-tier-gated: free=0, growth=3, agency=5 variants per day.
const creativeEngineDaily = inngest.createFunction(
  withDLQ({
    id: 'creative-engine-daily',
    name: 'Creative Engine · daily variant generation',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 9 * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('generate-all-businesses', async () =>
      callInternal('/webhook/creative-engine-generate-all', {})
    );
    return { ok: true, generated: result?.generated ?? 0, businesses: result?.businesses ?? 0 };
  }
);

// ─── Creative Engine evaluator (every 6 hours) ───────────────────────────
// Looks at variants in status='testing' that have been live for ≥72h and
// promotes/kills based on z-score CTR vs cohort baseline.
const creativeEngineEvaluate = inngest.createFunction(
  withDLQ({
    id: 'creative-engine-evaluate-6h',
    name: 'Creative Engine · evaluate testing variants',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 */6 * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('evaluate-all', async () =>
      callInternal('/webhook/creative-engine-evaluate-all', {})
    );
    return {
      ok: true,
      evaluated: result?.evaluated ?? 0,
      promoted: result?.promoted ?? 0,
      killed: result?.killed ?? 0,
    };
  }
);

// ─── Measurement Health probe (daily at 07:00 UTC, before ad audit) ──────
// Runs Meta EMQ + dedup + Google EC + TikTok Events API health checks across
// all active businesses. If a business's measurement is broken, the daily
// ad audit at 08:00 UTC will skip scaling decisions for that platform.
const measurementHealthProbe = inngest.createFunction(
  withDLQ({
    id: 'measurement-health-probe-daily',
    name: 'Measurement Health · daily probe',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 7 * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('probe-all-businesses', async () =>
      callInternal('/webhook/measurement-health-probe-all', {})
    );
    return {
      ok: true,
      probed: result?.probed ?? 0,
      healthy: result?.healthy ?? 0,
      degraded: result?.degraded ?? 0,
      broken: result?.broken ?? 0,
    };
  }
);

// ─── Ops maintenance — curated legacy n8n replacements ───────────────────
// Daily crisis sweep (all paid), snapshots (growth+), weekly strategy bundle,
// Monday growth lever, monthly report. See docs/INNGEST_ORCHESTRATION.md.
const opsAnalyticsSnapshotsDaily = inngest.createFunction(
  withDLQ({
    id: 'ops-analytics-snapshots-daily',
    name: 'Ops · daily analytics snapshots (growth+)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 6 * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('snapshots-all', async () =>
      callInternal('/webhook/ops-analytics-snapshots-all', {})
    );
    return { ok: true, businesses: result?.businesses ?? 0, succeeded: result?.succeeded ?? 0 };
  }
);

const opsDailyHealthBundle = inngest.createFunction(
  withDLQ({
    id: 'ops-daily-health-bundle',
    name: 'Ops · daily crisis health sweep (paid)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 30 7 * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('crisis-check-all', async () => callInternal('/webhook/ops-daily-health-all', {}));
    return {
      ok: true,
      businesses: result?.businesses ?? 0,
      crises: result?.crises ?? 0,
      succeeded: result?.succeeded ?? 0,
    };
  }
);

const opsWeeklyMaintenance = inngest.createFunction(
  withDLQ({
    id: 'ops-weekly-maintenance',
    name: 'Ops · weekly brand memory + strategy (growth+)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 30 5 * * 0' }],
  }),
  async ({ step }) => {
    const result = await step.run('weekly-bundle', async () => callInternal('/webhook/ops-weekly-maintenance-all', {}));
    return { ok: true, businesses: result?.businesses ?? 0, succeeded: result?.succeeded ?? 0 };
  }
);

const opsGrowthEngineMonday = inngest.createFunction(
  withDLQ({
    id: 'ops-growth-engine-monday',
    name: 'Ops · Monday growth lever (growth+)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 9 * * 1' }],
  }),
  async ({ step }) => {
    const result = await step.run('growth-all', async () => callInternal('/webhook/ops-growth-engine-all', {}));
    return { ok: true, businesses: result?.businesses ?? 0, succeeded: result?.succeeded ?? 0 };
  }
);

const opsMonthlyReports = inngest.createFunction(
  withDLQ({
    id: 'ops-monthly-reports',
    name: 'Ops · monthly analytics report email (growth+)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 8 1 * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('reports-all', async () => callInternal('/webhook/ops-monthly-reports-all', {}));
    return { ok: true, businesses: result?.businesses ?? 0, succeeded: result?.succeeded ?? 0 };
  }
);

// ─── Autopilot Brain (daily at 08:00 UTC, after measurement-health probe) ─
// Top-level orchestrator. Pulls signals from all 11 capability pillars,
// resolves cross-domain conflicts, narrates the daily brief, sends the
// email. Runs at 08:00 UTC AFTER measurement-health-probe-daily at 07:00
// so it has fresh trust verdicts to gate scaling decisions on.
const autopilotBrainDaily = inngest.createFunction(
  withDLQ({
    id: 'autopilot-brain-daily',
    name: 'Autopilot Brain · daily orchestration + customer brief',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 8 * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('run-all-businesses', async () =>
      callInternal('/webhook/autopilot-brain-run-all', {})
    );
    return {
      ok: true,
      ran: result?.ran ?? 0,
      conflicts_resolved: result?.conflicts_resolved ?? 0,
    };
  }
);

// ─── Email lifecycle processor (every 15 min) ────────────────────────────
// Walks email_sequence_runs where next_send_at <= now and dispatches
// the next email step. Idempotent — already-sent steps are tracked in send_log.
const emailLifecycleProcess = inngest.createFunction(
  withDLQ({
    id: 'email-lifecycle-process-15m',
    name: 'Email Lifecycle · process due runs',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC */15 * * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('process-due', async () => callInternal('/webhook/email-lifecycle-process-due', {}));
    return {
      ok: true,
      due: result?.due ?? 0,
      sent: result?.sent ?? 0,
      failed: result?.failed ?? 0,
      completed: result?.completed ?? 0,
    };
  }
);

// ─── WF11 — SLA breach sweep ───────────────────────────────────────────────
const wf11SlaCheckEvery15m = inngest.createFunction(
  withDLQ({
    id: 'wf11-sla-check-15m',
    name: 'WF11 Smart Routing · SLA breach check',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC */15 * * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('sla-check-all', async () => callInternal('/webhook/wf11-sla-check-all', {}));
    return { ok: true, breached: result?.breached ?? 0 };
  }
);

// ─── WF2 — weekly calibration rollup ─────────────────────────────────────────
const wf2WeeklyCalibration = inngest.createFunction(
  withDLQ({
    id: 'wf2-weekly-calibration',
    name: 'WF2 Lead Scoring · weekly calibration',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 3 * * 0' }],
  }),
  async ({ step }) => {
    const result = await step.run('calibration-all', async () => callInternal('/webhook/wf2-calibration-run-all', {}));
    return { ok: true, processed: result?.processed ?? 0 };
  }
);

// ─── AI Search Citation Tracker (daily at 06:00 UTC) ────────────────────
// Runs the prompt seed library against ChatGPT / Perplexity / Google AI
// Overviews / Claude for every Growth+ business. Cost: ~$3-5/business/mo.
const citationTrackerDaily = inngest.createFunction(
  withDLQ({
    id: 'citation-tracker-daily',
    name: 'Citation Tracker · daily AI search runs',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 6 * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('run-all-businesses', async () =>
      callInternal('/webhook/citation-tracker-run-all', {})
    );
    return {
      ok: true,
      ran: result?.ran ?? 0,
      cited: result?.cited ?? 0,
      cost_usd: result?.cost_usd ?? 0,
    };
  }
);

// ─── Competitor War Room (every 4h) ──────────────────────────────────────
// Scans Meta Ad Library + Google Auction Insights for top-5 competitors per
// business. Reacts to new ad launches / spend shifts / keyword overlap.
const competitorWatchRun = inngest.createFunction(
  withDLQ({
    id: 'competitor-watch-every-4h',
    name: 'Competitor War Room · scan every 4h',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 */4 * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('scan-all-businesses', async () =>
      callInternal('/webhook/competitor-watch-scan-all', {})
    );
    return {
      ok: true,
      scanned: result?.scanned ?? 0,
      alerts: result?.alerts ?? 0,
      critical: result?.critical ?? 0,
    };
  }
);

// ─── Cold-start onboarding orchestrator ──────────────────────────────────
// Triggered by `maroa/cold-start.run` event when a new business signs up.
// Listens for `maroa/cold-start.resume` to wake from awaiting_input states
// (e.g. after the customer uploads photos or approves a concept).
//
// We don't run phases inside this function — instead we POST to the resume
// endpoint, which has full DI of brand-voice/creative-director/higgsfield/
// ad-optimizer. Keeps the Inngest layer thin and consistent with our other
// crons. Each step.run() is durable so a flap doesn't lose progress.
const coldStartRun = inngest.createFunction(
  withDLQ({
    id: 'cold-start-run',
    name: 'Cold-start · onboarding orchestrator',
    retries: 3,
    concurrency: { limit: 1, key: 'event.data.businessId' },
    triggers: [{ event: 'maroa/cold-start.run' }],
  }),
  async ({ event, step }) => {
    const businessId = event?.data?.businessId;
    if (!businessId) return { ok: false, reason: 'missing businessId' };

    // Drive phases until awaiting_input or terminal state. Resume events
    // are handled by a sibling function that calls the same endpoint.
    const result = await step.run('resume-until-stop', async () =>
      callInternal('/webhook/cold-start-resume', { businessId })
    );
    return {
      ok: !!result?.ok,
      status: result?.status ?? null,
      current_phase: result?.current_phase ?? null,
      last_error: result?.last_error ?? null,
    };
  }
);

const coldStartResume = inngest.createFunction(
  withDLQ({
    id: 'cold-start-resume',
    name: 'Cold-start · resume after customer action',
    retries: 3,
    concurrency: { limit: 1, key: 'event.data.businessId' },
    triggers: [{ event: 'maroa/cold-start.resume' }],
  }),
  async ({ event, step }) => {
    const businessId = event?.data?.businessId;
    if (!businessId) return { ok: false, reason: 'missing businessId' };
    const result = await step.run('resume', async () => callInternal('/webhook/cold-start-resume', { businessId }));
    return {
      ok: !!result?.ok,
      status: result?.status ?? null,
      current_phase: result?.current_phase ?? null,
    };
  }
);

// ─── Cold-start stale-run sweep (daily 11:00 UTC) ─────────────────────────
// Gap G-1: a cold-start run can wedge forever in awaiting_input when the
// customer never uploads photos / approves a concept. Nothing previously
// timed these out, so a paying customer could silently get nothing. This
// sweep reminds (once at 72h) and fails cleanly (at 7d) so the run stops
// counting as in-progress. Dispatches in-process via internalDispatcher
// (registered in services/cold-start/registerRoutes.js) — same wiring as the
// cold-start resume handler — falling back to HTTP loopback if unregistered.
const coldStartSweepDaily = inngest.createFunction(
  withDLQ({
    id: 'cold-start-sweep-daily',
    name: 'Cold-start · stale-run sweep',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 11 * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('sweep-stale-runs', async () => callInternal('/webhook/cold-start-sweep', {}));
    return {
      ok: true,
      scanned: result?.scanned ?? 0,
      reminded: result?.reminded ?? 0,
      expired: result?.expired ?? 0,
    };
  }
);

// ─── WF13 weekly synthesis (Sunday 07:00 UTC) ─────────────────────────────
// Generates the weekly brief for every active business. Runs early Sunday so
// briefs are ready when the customer-facing weekly scorecard fires at 22:00.
const wf13WeeklySynthesis = inngest.createFunction(
  withDLQ({
    id: 'wf13-weekly-synthesis',
    name: 'WF13 · weekly synthesis',
    retries: 3,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 7 * * 0' }],
  }),
  async ({ step }) => {
    const result = await step.run('synthesize-all-businesses', async () =>
      callInternal('/webhook/wf13-run-weekly', { force: false })
    );
    return {
      ok: true,
      processed: result?.processed ?? null,
    };
  }
);

// ─── Wave 59 S5: Quarterly taxonomy refresh ──────────────────────────────
// Every 90 days (Mon 09:00 UTC). Claude proposes adds/removes/merges for
// lib/taxonomy/industries.js + expert_sources.js. Posts the diff to Slack
// via alertRouter. NEVER auto-applies — humans review + open a PR.
//
// We don't have a `/webhook/taxonomy-refresh-run` endpoint yet because this
// service is server-side-only. Future webhook route can wire it for manual
// ─── Higgsfield · daily credit check ──────────────────────────────────────
// Tries to refresh each business's Higgsfield balance (via the soon-to-be-
// wired getBalance() helper) and emails the owner when credits drop under
// the 200-credit floor — a 100-credit *hard* floor in the WF1 engine blocks
// generation outright. Cron at 07:00 UTC so the alert lands before WF1's
// per-business local-06:00 sweep starts firing in the Americas.
const checkHiggsfieldCredits = inngest.createFunction(
  withDLQ({
    id: 'higgsfield-credits-daily-7utc',
    name: 'Higgsfield · daily credit check',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 7 * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('check-all', async () => callInternal('/webhook/check-higgsfield-credits', {}));
    return { ok: true, scanned: result?.scanned ?? 0, alerted: result?.alerted ?? 0 };
  }
);

// ─── Higgsfield · Soul ID training poll ───────────────────────────────────
// Event-driven (fired by POST /api/higgsfield/train-soul). The finalize
// endpoint blocks on the existing waitForSoulIdTraining poller and then
// stamps businesses.higgsfield_soul_id. Inngest retries handle transient
// failures; the step-runtime budget covers the typical few-minute training.
const higgsfieldSoulTrainPoll = inngest.createFunction(
  withDLQ({
    id: 'higgsfield-soul-train-poll',
    name: 'Higgsfield · Soul ID training poll',
    retries: 3,
    concurrency: { limit: 5 },
    triggers: [{ event: 'higgsfield/soul-train.poll' }],
  }),
  async ({ event, step }) => {
    const { businessId, characterId } = event.data || {};
    if (!businessId || !characterId) return { ok: false, reason: 'missing args' };
    const r = await step.run('wait-and-persist', async () =>
      callInternal('/webhook/higgsfield-soul-train-finalize', { businessId, characterId })
    );
    return r;
  }
);

// trigger. For now the Inngest step calls into the service directly via
// the internal dispatcher (Wave 56 pattern).
const taxonomyRefreshQuarterly = inngest.createFunction(
  withDLQ({
    id: 'taxonomy-refresh-quarterly',
    name: 'Taxonomy refresh · quarterly AI review',
    retries: 1,
    concurrency: { limit: 1 },
    // Every 90 days at Mon 09:00 UTC. Approximation: first Monday of
    // Jan/Apr/Jul/Oct. (Inngest doesn't natively support "every 90 days"
    // — this firing pattern is close enough.)
    triggers: [{ cron: 'TZ=UTC 0 9 1-7 1,4,7,10 1' }],
  }),
  async ({ step }) => {
    const result = await step.run('refresh', async () => callInternal('/webhook/taxonomy-refresh-run', {}));
    return {
      ok: true,
      industries_changes:
        (result?.industries_diff?.additions?.length || 0) +
        (result?.industries_diff?.removals?.length || 0) +
        (result?.industries_diff?.merges?.length || 0),
      expert_sources_changes:
        (result?.expert_sources_diff?.additions?.length || 0) + (result?.expert_sources_diff?.removals?.length || 0),
    };
  }
);

// ─── OAuth token refresh (hourly) ─────────────────────────────────────────
// Rebuild of lost feature #2. Proactively refreshes short-lived LinkedIn /
// Twitter-X / TikTok access tokens before they expire (Twitter ~2h, TikTok
// ~24h) so connections don't silently die. Only accounts within the refresh
// lead window (or with unknown expiry) are touched. See services/oauth/tokenRefresh.js.
const oauthTokenRefreshHourly = inngest.createFunction(
  withDLQ({
    id: 'oauth-token-refresh-hourly',
    name: 'OAuth · refresh expiring social tokens',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC 0 * * * *' }],
  }),
  async ({ step }) => {
    const result = await step.run('refresh-all-due', async () => callInternal('/webhook/oauth-token-refresh-all', {}));
    return {
      ok: true,
      due: result?.due ?? 0,
      refreshed: result?.refreshed ?? 0,
      failed: result?.failed ?? 0,
    };
  }
);

// ─── Publish scheduler (every 15 min) ─────────────────────────────────────
// Rebuild of lost feature #3. Publishes content whose scheduled slot has
// arrived — content_assets at posting_time_local (business-local tz) and
// generated_content at scheduled_for — idempotent via the published_at gate.
// See services/publish-scheduler/index.js.
const publishSchedulerEvery15m = inngest.createFunction(
  withDLQ({
    id: 'publish-scheduler-15m',
    name: 'Publish scheduler · publish due content',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=UTC */15 * * * *' }],
  }),
  async ({ step }) => {
    const r = await step.run('publish-due', async () => callInternal('/webhook/publish-scheduler-run', {}));
    return {
      ok: true,
      assets_published: r?.assets_published ?? 0,
      scheduled_triggered: r?.scheduled_triggered ?? 0,
    };
  }
);

const functions = [
  // Domain crons (originally migrated from n8n)
  adOptimizerDaily,
  pacingAlertsRun,
  weeklyScorecardAll,

  // WF1 (content) — replaces in-process setInterval + wires orphan endpoints
  wf1DailySweepHourly,
  wf1MeasureFallbacksHourly,
  wf1ScheduledPublish,
  oauthTokenRefreshDaily,
  wf1OvernightBatchSubmitNightly,
  wf1OvernightBatchApplyPoll,

  // Anthropic generic batch reconcile (non-WF1 batches)
  anthropicBatchReconcilePoll,

  // WF13 weekly brief synthesis
  wf13WeeklySynthesis,

  // Cold-start onboarding orchestrator (event-driven, not cron)
  coldStartRun,
  coldStartResume,
  coldStartSweepDaily,

  // Multi-platform ads + Daily Creative Engine + Measurement Health (Week 5-7)
  measurementHealthProbe,
  creativeEngineDaily,
  creativeEngineEvaluate,

  // Competitor War Room (Week 8)
  competitorWatchRun,

  // Citation Tracker (Week 9)
  citationTrackerDaily,

  // Email Lifecycle (Week 10)
  emailLifecycleProcess,

  // WF11 — inbox SLA breach sweep (every 15 min)
  wf11SlaCheckEvery15m,

  // WF2 — weekly calibration snapshot (Sunday 03:00 UTC)
  wf2WeeklyCalibration,

  // Autopilot Brain (Week 12 — top-level orchestrator)
  autopilotBrainDaily,

  // Ops maintenance (curated n8n legacy replacement)
  opsAnalyticsSnapshotsDaily,
  opsDailyHealthBundle,
  opsWeeklyMaintenance,
  opsGrowthEngineMonday,
  opsMonthlyReports,

  // Durable replacement for setTimeout(24h) in publish path
  contentPublishFeedback24h,

  // Manual triggers (for dashboard testing)
  manualAdAudit,
  manualPacingRun,
  manualScorecardRun,

  // Manual triggers for the canonical engines that lacked an on-demand surface
  // (competitor-watch / email-lifecycle) — see CANONICAL_WORKFLOWS.md.
  manualCompetitorWatch,
  manualEmailLifecycle,

  // Wave 59 S5: quarterly AI-assisted taxonomy refresh (proposes via Slack only)
  taxonomyRefreshQuarterly,

  // Higgsfield expansion — credit guard + Soul ID training poll
  checkHiggsfieldCredits,
  higgsfieldSoulTrainPoll,

  // OAuth token refresh (hourly) — keep LinkedIn/X/TikTok connections alive
  oauthTokenRefreshHourly,

  // Publish scheduler (every 15 min) — publish content at its scheduled slot
  publishSchedulerEvery15m,
];

module.exports = { functions, callInternal };
