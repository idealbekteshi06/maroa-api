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
    opts.triggers?.[0]?.event
    || (opts.triggers?.[0]?.cron ? `cron:${opts.triggers[0].cron}` : 'unknown');
  return { ...opts, onFailure: dlqHandler({ functionId: opts.id, eventName }) };
}

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
    onFailure: dlqHandler({ functionId: 'content-publish-feedback-24h', eventName: 'maroa/content.publish.feedback-24h' }),
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
    return await step.run('run', async () =>
      callInternal('/webhook/ad-optimizer-daily-audit', { dryRun, limit })
    );
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
    return await step.run('run', async () =>
      callInternal('/webhook/weekly-scorecard-all', { dryRun })
    );
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
    const result = await step.run('process-due', async () =>
      callInternal('/webhook/email-lifecycle-process-due', {})
    );
    return {
      ok: true,
      due: result?.due ?? 0,
      sent: result?.sent ?? 0,
      failed: result?.failed ?? 0,
      completed: result?.completed ?? 0,
    };
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
    const result = await step.run('resume', async () =>
      callInternal('/webhook/cold-start-resume', { businessId })
    );
    return {
      ok: !!result?.ok,
      status: result?.status ?? null,
      current_phase: result?.current_phase ?? null,
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

const functions = [
  // Domain crons (originally migrated from n8n)
  adOptimizerDaily,
  pacingAlertsRun,
  weeklyScorecardAll,

  // WF1 (content) — replaces in-process setInterval + wires orphan endpoints
  wf1DailySweepHourly,
  wf1MeasureFallbacksHourly,
  wf1OvernightBatchSubmitNightly,
  wf1OvernightBatchApplyPoll,

  // Anthropic generic batch reconcile (non-WF1 batches)
  anthropicBatchReconcilePoll,

  // WF13 weekly brief synthesis
  wf13WeeklySynthesis,

  // Cold-start onboarding orchestrator (event-driven, not cron)
  coldStartRun,
  coldStartResume,

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

  // Autopilot Brain (Week 12 — top-level orchestrator)
  autopilotBrainDaily,

  // Durable replacement for setTimeout(24h) in publish path
  contentPublishFeedback24h,

  // Manual triggers (for dashboard testing)
  manualAdAudit,
  manualPacingRun,
  manualScorecardRun,
];

module.exports = { functions, callInternal };
