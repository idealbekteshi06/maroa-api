'use strict';

// WF1 publish scheduler — honors content_assets.posting_time_local.
// Covers the DST-correct time math, the schedule-vs-publish-now policy, the
// atomic claim (no double-publish), retry/give-up, and stale-claim recovery.

const test = require('node:test');
const assert = require('node:assert/strict');

const createScheduler = require('../services/wf1/scheduler');
const { computeScheduledAt, decidePublishTiming, tzOffsetMs } = createScheduler;

// ─── tzOffsetMs: known offsets incl. DST ─────────────────────────────────────

test('tzOffsetMs: New York is -5h in winter (EST), -4h in summer (EDT)', () => {
  // 2026-01-15 12:00 UTC → EST (-5h)
  const winter = tzOffsetMs(new Date('2026-01-15T12:00:00Z'), 'America/New_York');
  assert.equal(winter, -5 * 3600000);
  // 2026-07-15 12:00 UTC → EDT (-4h)
  const summer = tzOffsetMs(new Date('2026-07-15T12:00:00Z'), 'America/New_York');
  assert.equal(summer, -4 * 3600000);
});

test('tzOffsetMs: UTC zone is always zero', () => {
  assert.equal(tzOffsetMs(new Date('2026-03-29T01:30:00Z'), 'UTC'), 0);
});

// ─── computeScheduledAt: the wall-clock → UTC mapping ───────────────────────

test('computeScheduledAt: 14:30 in New York winter → 19:30 UTC', () => {
  const now = new Date('2026-01-15T09:00:00Z'); // same local day
  const at = computeScheduledAt({ postingTimeLocal: '14:30', timeZone: 'America/New_York', now });
  assert.equal(at.toISOString(), '2026-01-15T19:30:00.000Z');
});

test('computeScheduledAt: 14:30 in New York summer → 18:30 UTC (DST shift)', () => {
  const now = new Date('2026-07-15T09:00:00Z');
  const at = computeScheduledAt({ postingTimeLocal: '14:30', timeZone: 'America/New_York', now });
  assert.equal(at.toISOString(), '2026-07-15T18:30:00.000Z');
});

test('computeScheduledAt: spring-forward day resolves to a valid instant (09:00 EDT)', () => {
  // US spring-forward 2026 is 2026-03-08. A 09:00 slot is well clear of the
  // 02:00-03:00 gap and should land in EDT (-4h) → 13:00 UTC.
  const now = new Date('2026-03-08T07:00:00Z');
  const at = computeScheduledAt({ postingTimeLocal: '09:00', timeZone: 'America/New_York', now });
  assert.equal(at.toISOString(), '2026-03-08T13:00:00.000Z');
});

test('computeScheduledAt: fall-back day, 09:00 resolves to EST (-5h) → 14:00 UTC', () => {
  // US fall-back 2026 is 2026-11-01. After the transition the day is EST.
  const now = new Date('2026-11-01T08:00:00Z');
  const at = computeScheduledAt({ postingTimeLocal: '09:00', timeZone: 'America/New_York', now });
  assert.equal(at.toISOString(), '2026-11-01T14:00:00.000Z');
});

test('computeScheduledAt: invalid inputs → null (caller publishes now)', () => {
  const now = new Date('2026-01-15T09:00:00Z');
  assert.equal(computeScheduledAt({ postingTimeLocal: null, timeZone: 'UTC', now }), null);
  assert.equal(computeScheduledAt({ postingTimeLocal: 'noon', timeZone: 'UTC', now }), null);
  assert.equal(computeScheduledAt({ postingTimeLocal: '25:00', timeZone: 'UTC', now }), null);
  assert.equal(computeScheduledAt({ postingTimeLocal: '10:75', timeZone: 'UTC', now }), null);
});

test('computeScheduledAt: bad timezone falls back to default, never throws', () => {
  const now = new Date('2026-01-15T09:00:00Z');
  const at = computeScheduledAt({ postingTimeLocal: '12:00', timeZone: 'Not/AZone', now });
  assert.ok(at instanceof Date && !Number.isNaN(at.getTime()));
});

// ─── decidePublishTiming policy ─────────────────────────────────────────────

test('decidePublishTiming: future-beyond-grace → schedule', () => {
  const now = new Date('2026-01-15T09:00:00Z');
  const scheduledAt = new Date('2026-01-15T14:00:00Z');
  assert.deepEqual(decidePublishTiming({ scheduledAt, now }), { action: 'schedule', scheduledAt });
});

test('decidePublishTiming: slot already passed → publish now', () => {
  const now = new Date('2026-01-15T14:00:00Z');
  const scheduledAt = new Date('2026-01-15T09:00:00Z');
  assert.equal(decidePublishTiming({ scheduledAt, now }).action, 'publish_now');
});

test('decidePublishTiming: within grace window → publish now', () => {
  const now = new Date('2026-01-15T09:00:00Z');
  const scheduledAt = new Date('2026-01-15T09:05:00Z'); // 5 min < 10 grace
  assert.equal(decidePublishTiming({ scheduledAt, now }).action, 'publish_now');
});

test('decidePublishTiming: no slot → publish now', () => {
  assert.equal(decidePublishTiming({ scheduledAt: null }).action, 'publish_now');
});

// ─── publishOrSchedule: integration with fakes ──────────────────────────────

function fakeDeps(overrides = {}) {
  const published = [];
  const patches = [];
  const posts = [];
  const db = {
    content_assets: { a1: { id: 'a1', posting_time_local: '23:00' } },
    business_profiles: { b1: { user_id: 'b1', timezone: 'UTC' } },
  };
  const deps = {
    sbGet: async (table, q) => {
      if (table === 'content_assets') return [db.content_assets.a1];
      if (table === 'business_profiles') return [db.business_profiles.b1];
      return [];
    },
    sbPost: async (table, row) => {
      posts.push({ table, row });
      return [row];
    },
    sbPatch: async (table, filter, patch) => {
      patches.push({ table, filter, patch });
      return true;
    },
    sbPatchReturning: async (table, filter, patch) => {
      patches.push({ table, filter, patch, returning: true });
      // Simulate CAS success by default.
      return [{ id: 'a1', ...patch }];
    },
    publisher: {
      publishAsset: async ({ assetId }) => {
        published.push(assetId);
        return { ok: true, postId: 'post_' + assetId };
      },
    },
    logger: null,
    ...overrides,
  };
  return { deps, published, patches, posts, db };
}

test('publishOrSchedule: future slot → parks as scheduled, does not publish', async () => {
  const { deps, published, patches } = fakeDeps();
  const scheduler = createScheduler(deps);
  // now = 09:00 UTC, slot 23:00 UTC same day → schedule.
  const r = await scheduler.publishOrSchedule({
    assetId: 'a1',
    businessId: 'b1',
    now: new Date('2026-01-15T09:00:00Z'),
  });
  assert.equal(r.scheduled, true);
  assert.equal(published.length, 0, 'must not publish a future-slot asset');
  const sched = patches.find((p) => p.patch.status === 'scheduled');
  assert.ok(sched, 'asset must be marked scheduled');
  assert.equal(sched.patch.scheduled_at, '2026-01-15T23:00:00.000Z');
});

test('publishOrSchedule: passed slot → publishes immediately', async () => {
  const { deps, published } = fakeDeps();
  // now = 23:30 UTC, slot 23:00 → already passed → publish now.
  const s = createScheduler(deps);
  const out = await s.publishOrSchedule({ assetId: 'a1', businessId: 'b1', now: new Date('2026-01-15T23:30:00Z') });
  assert.equal(out.ok, true);
  assert.equal(published[0], 'a1');
});

test('publishOrSchedule: no posting time → publishes immediately', async () => {
  const { deps, published } = fakeDeps({
    sbGet: async (table) => {
      if (table === 'content_assets') return [{ id: 'a1', posting_time_local: null }];
      if (table === 'business_profiles') return [{ timezone: 'UTC' }];
      return [];
    },
  });
  const s = createScheduler(deps);
  await s.publishOrSchedule({ assetId: 'a1', businessId: 'b1', now: new Date('2026-01-15T09:00:00Z') });
  assert.equal(published[0], 'a1');
});

// ─── sweepDuePublishes: claim, publish, retry, give-up ──────────────────────

function sweepDeps({ casWins = true, publishOk = true, attempts = 0 } = {}) {
  const calls = { published: [], patches: [], posts: [] };
  const due = [{ id: 'a1', business_id: 'b1', publish_attempts: attempts }];
  const deps = {
    sbGet: async (table, q) => {
      if (table === 'content_assets' && q.includes('status=eq.scheduled')) return due;
      if (table === 'content_assets' && q.includes('status=eq.publishing')) return [];
      return [];
    },
    sbPost: async (table, row) => {
      calls.posts.push({ table, row });
      return [row];
    },
    sbPatch: async (table, filter, patch) => {
      calls.patches.push({ filter, patch });
      return true;
    },
    sbPatchReturning: async (table, filter, patch) => {
      calls.patches.push({ filter, patch, returning: true });
      return casWins ? [{ id: 'a1', ...patch }] : []; // [] = lost the claim
    },
    publisher: {
      publishAsset: async ({ assetId }) => {
        calls.published.push(assetId);
        return publishOk ? { ok: true, postId: 'p1' } : { ok: false, error: 'platform 500' };
      },
    },
    logger: null,
  };
  return { deps, calls };
}

test('sweepDuePublishes: claims and publishes a due asset', async () => {
  const { deps, calls } = sweepDeps();
  const r = await createScheduler(deps).sweepDuePublishes({ now: new Date('2026-01-15T23:05:00Z') });
  assert.equal(calls.published.length, 1);
  assert.equal(r.results[0].action, 'published');
  const claim = calls.patches.find((p) => p.returning);
  assert.match(claim.filter, /status=eq\.scheduled/, 'claim must be status-guarded (CAS)');
  assert.equal(claim.patch.status, 'publishing');
});

test('sweepDuePublishes: lost claim → does NOT publish (no double-post)', async () => {
  const { deps, calls } = sweepDeps({ casWins: false });
  const r = await createScheduler(deps).sweepDuePublishes({ now: new Date('2026-01-15T23:05:00Z') });
  assert.equal(calls.published.length, 0, 'lost claim must not publish');
  assert.equal(r.results[0].action, 'lost_claim');
});

test('sweepDuePublishes: publish failure under max → reschedules with backoff', async () => {
  const { deps, calls } = sweepDeps({ publishOk: false, attempts: 1 });
  const r = await createScheduler(deps).sweepDuePublishes({ now: new Date('2026-01-15T23:05:00Z') });
  assert.equal(r.results[0].action, 'retry_scheduled');
  assert.equal(r.results[0].attempts, 2);
  const reschedule = calls.patches.find((p) => p.patch.status === 'scheduled' && p.patch.scheduled_at);
  assert.ok(reschedule, 'failed publish must be rescheduled, not dropped');
});

test('sweepDuePublishes: publish failure at max attempts → gives up with event', async () => {
  const { deps, calls } = sweepDeps({ publishOk: false, attempts: 4 }); // +1 = 5 = MAX
  const r = await createScheduler(deps).sweepDuePublishes({ now: new Date('2026-01-15T23:05:00Z') });
  assert.equal(r.results[0].action, 'gave_up');
  const gaveUp = calls.posts.find((p) => p.row.kind === 'wf1.scheduled_publish.gave_up');
  assert.ok(gaveUp, 'give-up must emit an event — never silently stuck');
});
