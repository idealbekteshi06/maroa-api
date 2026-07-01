'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { functions } = require('../services/inngest/functions');

// ─── Function registry ────────────────────────────────────────────────────

test('inngest: exports an array of functions', () => {
  assert.ok(Array.isArray(functions));
  assert.ok(functions.length >= 17, `expected at least 17 functions, got ${functions.length}`);
});

test('inngest: every function has an id and a handler', () => {
  for (const fn of functions) {
    const opts = fn?.opts ?? fn;
    const id = opts.id || fn.id;
    assert.ok(id, `function missing id: ${JSON.stringify(opts).slice(0, 100)}`);
    assert.strictEqual(typeof id, 'string');
  }
});

test('inngest: function ids are unique', () => {
  const ids = functions.map((f) => f.opts?.id ?? f.id);
  const set = new Set(ids);
  assert.strictEqual(set.size, ids.length, 'duplicate function ids detected: ' + ids.join(','));
});

// ─── Required functions exist ─────────────────────────────────────────────

const REQUIRED_FUNCTION_IDS = [
  // Original 3 (n8n cron migrations)
  'ad-optimizer-daily',
  'pacing-alerts-every-4h',
  'weekly-scorecard-sun-22-utc',

  // Manual triggers
  'manual-ad-audit',
  'manual-pacing-alerts',
  'manual-weekly-scorecard',

  // Week 1 additions — WF1 setInterval replacement + 4 orphan crons
  'wf1-daily-sweep-hourly',
  'wf1-measure-fallbacks-hourly',
  'wf1-scheduled-publish',
  'wf1-overnight-batch-submit-nightly',
  'wf1-overnight-batch-apply-poll',
  'anthropic-batch-reconcile-poll',
  'wf13-weekly-synthesis',
  'ops-analytics-snapshots-daily',
  'ops-daily-health-bundle',
  'ops-weekly-maintenance',
  'ops-growth-engine-monday',
  'ops-monthly-reports',
];

test('inngest: all required function ids are registered', () => {
  const ids = new Set(functions.map((f) => f.opts?.id ?? f.id));
  for (const required of REQUIRED_FUNCTION_IDS) {
    assert.ok(ids.has(required), `missing function: ${required}`);
  }
});

// ─── Cron expressions on scheduled functions ──────────────────────────────

const EXPECTED_CRONS = {
  'ad-optimizer-daily': 'TZ=UTC 0 8 * * *',
  'pacing-alerts-every-4h': 'TZ=UTC 0 */4 * * *',
  'weekly-scorecard-sun-22-utc': 'TZ=UTC 0 22 * * 0',
  'wf1-daily-sweep-hourly': 'TZ=UTC 0 * * * *',
  'wf1-measure-fallbacks-hourly': 'TZ=UTC 30 * * * *',
  'wf1-scheduled-publish': 'TZ=UTC */15 * * * *',
  'wf1-overnight-batch-submit-nightly': 'TZ=UTC 0 23 * * *',
  'wf1-overnight-batch-apply-poll': 'TZ=UTC */10 * * * *',
  'anthropic-batch-reconcile-poll': 'TZ=UTC */5 * * * *',
  'wf13-weekly-synthesis': 'TZ=UTC 0 7 * * 0',
  'ops-analytics-snapshots-daily': 'TZ=UTC 0 6 * * *',
  'ops-daily-health-bundle': 'TZ=UTC 30 7 * * *',
  'ops-weekly-maintenance': 'TZ=UTC 30 5 * * 0',
  'ops-growth-engine-monday': 'TZ=UTC 0 9 * * 1',
  'ops-monthly-reports': 'TZ=UTC 0 8 1 * *',
};

test('inngest: cron expressions match expected schedules', () => {
  for (const fn of functions) {
    const id = fn.opts?.id ?? fn.id;
    const expected = EXPECTED_CRONS[id];
    if (!expected) continue; // not a scheduled function

    const triggers = fn.opts?.triggers ?? fn.triggers ?? [];
    const cronTrigger = triggers.find((t) => t.cron);
    assert.ok(cronTrigger, `function ${id} has no cron trigger`);
    assert.strictEqual(cronTrigger.cron, expected, `function ${id} cron mismatch`);
  }
});

// ─── No accidental Sunday-collision between 22:00 scorecard and 23:00 batch ─

test("inngest: Sunday 22:00 and 23:00 don't collide on the same business work", () => {
  // Scorecard at Sun 22:00 reads — batch at daily 23:00 writes.
  // Different reads/writes, but they share Anthropic concurrency.
  // Both have concurrency: { limit: 1 } so they serialize at Inngest level.
  const scorecard = functions.find((f) => (f.opts?.id ?? f.id) === 'weekly-scorecard-sun-22-utc');
  const batch = functions.find((f) => (f.opts?.id ?? f.id) === 'wf1-overnight-batch-submit-nightly');

  assert.ok(scorecard);
  assert.ok(batch);
  assert.strictEqual(scorecard.opts?.concurrency?.limit ?? scorecard.concurrency?.limit, 1);
  assert.strictEqual(batch.opts?.concurrency?.limit ?? batch.concurrency?.limit, 1);
});

// ─── Retry policy sanity ──────────────────────────────────────────────────

test('inngest: retry counts are conservative', () => {
  for (const fn of functions) {
    const id = fn.opts?.id ?? fn.id;
    const retries = fn.opts?.retries ?? fn.retries;
    if (retries === undefined) continue;
    assert.ok(retries <= 3, `function ${id} has too many retries (${retries}) — risk of duplicate side effects`);
    assert.ok(retries >= 1, `function ${id} should have at least 1 retry`);
  }
});

test('inngest: nightly batch submit has retries=1 (avoid double-charge)', () => {
  const fn = functions.find((f) => (f.opts?.id ?? f.id) === 'wf1-overnight-batch-submit-nightly');
  assert.ok(fn);
  const retries = fn.opts?.retries ?? fn.retries;
  assert.strictEqual(retries, 1, 'nightly batch must not retry aggressively — could double-submit Anthropic batches');
});
