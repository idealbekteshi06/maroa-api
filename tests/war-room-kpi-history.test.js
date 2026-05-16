'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildKpiHistory, weekDeltaPct, trendDir, _internals } = require('../lib/warRoomKpiHistory');

const FIXED_NOW = Date.parse('2026-05-16T12:00:00Z');
const DAY_MS = 86400000;

// Tiny fake sbGet that returns canned rows per (table, filter) combo.
function makeFakeSb(tables) {
  return async function sbGet(table, _filter) {
    if (Object.prototype.hasOwnProperty.call(tables, table)) {
      const v = tables[table];
      if (v === 'THROW') throw new Error('simulated read failure');
      return v;
    }
    return [];
  };
}

// ── unit: weekDeltaPct ─────────────────────────────────────────────────────

test('weekDeltaPct: 0 prior + 0 current → 0', () => {
  assert.equal(weekDeltaPct([0, 0, 0, 0, 0, 0, 0]), 0);
});

test('weekDeltaPct: 0 prior + positive current → 100', () => {
  assert.equal(weekDeltaPct([0, 0, 0, 0, 0, 0, 5]), 100);
});

test('weekDeltaPct: doubled value → +100%', () => {
  assert.equal(weekDeltaPct([10, 12, 14, 16, 18, 19, 20]), 100);
});

test('weekDeltaPct: halved → -50%', () => {
  assert.equal(weekDeltaPct([100, 90, 80, 70, 60, 55, 50]), -50);
});

// ── unit: trendDir ─────────────────────────────────────────────────────────

test('trendDir: rounding band — 1% drift reads as flat', () => {
  assert.equal(trendDir([100, 100, 100, 100, 100, 100, 101]), 'flat');
});

test('trendDir: 5% rise reads as up', () => {
  assert.equal(trendDir([100, 100, 100, 100, 100, 105, 105]), 'up');
});

test('trendDir: 5% drop reads as down', () => {
  assert.equal(trendDir([100, 100, 100, 100, 100, 96, 95]), 'down');
});

// ── unit: dayEnds ──────────────────────────────────────────────────────────

test('dayEnds: returns 7 timestamps, last is end of today UTC', () => {
  const ends = _internals.dayEnds(FIXED_NOW);
  assert.equal(ends.length, 7);
  // Each consecutive pair separated by exactly one day
  for (let i = 1; i < ends.length; i++) {
    assert.equal(ends[i] - ends[i - 1], DAY_MS);
  }
  // Last bucket ends at 23:59:59.999 UTC on FIXED_NOW
  const last = new Date(ends[6]);
  assert.equal(last.getUTCHours(), 23);
  assert.equal(last.getUTCMinutes(), 59);
});

// ── unit: cumulativeFromCreatedAt ──────────────────────────────────────────

test('cumulative: items created across the window accrete day-by-day', () => {
  const ends = _internals.dayEnds(FIXED_NOW);
  // One row each, created on each day's noon — so day i should have i+1 rows.
  const rows = ends.map((end, i) => ({
    created_at: new Date(end - DAY_MS / 2 - (6 - i) * 0).toISOString(),
    _i: i,
  }));
  // Actually simpler: rows created at each day's start
  const startEachDay = ends.map((e) => e - DAY_MS / 2);
  const cum = _internals.cumulativeFromCreatedAt(
    startEachDay.map((t) => ({ t })),
    (r) => r.t,
    ends,
  );
  assert.deepEqual(cum, [1, 2, 3, 4, 5, 6, 7]);
  // Suppress unused var lint
  void rows;
});

test('cumulative: rows outside window do not leak in', () => {
  const ends = _internals.dayEnds(FIXED_NOW);
  const ancient = ends[0] - 30 * DAY_MS; // a month before the window
  const cum = _internals.cumulativeFromCreatedAt(
    [{ t: ancient }],
    (r) => r.t,
    ends,
  );
  // Row predates window so it counts for every bucket
  assert.deepEqual(cum, [1, 1, 1, 1, 1, 1, 1]);
});

// ── unit: perDayFromCreatedAt ──────────────────────────────────────────────

test('perDay: one row per day → series of 1s', () => {
  const ends = _internals.dayEnds(FIXED_NOW);
  const rows = ends.map((e) => ({ t: e - DAY_MS / 2 }));
  const perDay = _internals.perDayFromCreatedAt(rows, (r) => r.t, ends);
  assert.deepEqual(perDay, [1, 1, 1, 1, 1, 1, 1]);
});

// ── integration: buildKpiHistory happy path ───────────────────────────────

test('buildKpiHistory: real-ish data flows through end-to-end', async () => {
  const ends = _internals.dayEnds(FIXED_NOW);
  const noonOf = (i) => new Date(ends[i] - DAY_MS / 2).toISOString();

  const sbGet = makeFakeSb({
    // 7 creatives, one per day
    creative_assets: ends.map((_, i) => ({ id: `cr-${i}`, business_id: 'b1', created_at: noonOf(i) })),
    // 1 experiment that started 5 days ago and is still running
    experiments: [{ id: 'x1', status: 'running', started_at: noonOf(2), ended_at: null }],
    // 2 pending approvals across the week
    client_approvals: [
      { id: 'a1', status: 'pending', created_at: noonOf(3), expires_at: noonOf(6) },
      { id: 'a2', status: 'pending', created_at: noonOf(5), expires_at: new Date(ends[6] + 2 * DAY_MS).toISOString() },
    ],
    // 3 refusals
    decision_logs: [
      { id: 'r1', created_at: noonOf(4) },
      { id: 'r2', created_at: noonOf(5) },
      { id: 'r3', created_at: noonOf(5) },
    ],
    // 2 clients added during the week
    workspace_clients: [
      { business_id: 'b1', added_at: noonOf(0) },
      { business_id: 'b2', added_at: noonOf(3) },
    ],
  });

  const h = await buildKpiHistory({
    sbGet,
    businessIds: ['b1', 'b2'],
    currentSummary: {
      clients_total: 2,
      creatives_total: 7,
      experiments_running: 1,
      pending_approvals: 1, // a1 expired at noonOf(6), so at end-of-day 6 only a2 is still pending
    },
    now: FIXED_NOW,
  });

  assert.deepEqual(h.creatives_total, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(h.active_clients, [1, 1, 1, 2, 2, 2, 2]);
  // x1 started on day 2; still running every day after
  assert.deepEqual(h.experiments_running, [0, 0, 1, 1, 1, 1, 1]);
  // a1 created day 3 expires day 6 → present days 3,4,5; a2 created day 5 expires after window → present 5,6
  assert.deepEqual(h.pending_approvals, [0, 0, 0, 1, 1, 2, 1]);
  assert.deepEqual(h.refusals_7d, [0, 0, 0, 0, 1, 2, 0]);

  // delta_pct should be present for every series
  assert.ok('delta_pct' in h);
  assert.ok('trend' in h);
});

// ── integration: degrades gracefully when a source table errors ──────────

test('buildKpiHistory: per-table failure → flat fallback for that metric only', async () => {
  const sbGet = makeFakeSb({
    creative_assets: 'THROW',
    experiments: [],
    client_approvals: [],
    decision_logs: [],
    workspace_clients: [],
  });
  const h = await buildKpiHistory({
    sbGet,
    businessIds: ['b1'],
    currentSummary: { clients_total: 0, creatives_total: 3, experiments_running: 0, pending_approvals: 0 },
    now: FIXED_NOW,
  });
  // creatives_total fell back to flat at current value
  assert.deepEqual(h.creatives_total, [3, 3, 3, 3, 3, 3, 3]);
  assert.equal(h.delta_pct.creatives_total, 0);
  assert.equal(h.trend.creatives_total, 'flat');
  // Other metrics computed normally
  assert.equal(h.experiments_running.length, 7);
});

// ── integration: empty workspace ──────────────────────────────────────────

test('buildKpiHistory: no business ids → flat series everywhere, no sb calls', async () => {
  let calls = 0;
  const sbGet = async () => {
    calls++;
    return [];
  };
  const h = await buildKpiHistory({
    sbGet,
    businessIds: [],
    currentSummary: { clients_total: 0, creatives_total: 0, experiments_running: 0, pending_approvals: 0 },
    now: FIXED_NOW,
  });
  assert.equal(calls, 0);
  assert.deepEqual(h.creatives_total, [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(h.trend.creatives_total, 'flat');
});

// ── integration: last point pinned to current summary ─────────────────────

test('buildKpiHistory: most-recent point pinned to currentSummary even if rows drifted', async () => {
  const sbGet = makeFakeSb({
    creative_assets: [{ id: 'cr-1', business_id: 'b1', created_at: new Date(FIXED_NOW - DAY_MS).toISOString() }],
    experiments: [],
    client_approvals: [],
    decision_logs: [],
    workspace_clients: [],
  });
  const h = await buildKpiHistory({
    sbGet,
    businessIds: ['b1'],
    currentSummary: { clients_total: 0, creatives_total: 99, experiments_running: 0, pending_approvals: 0 },
    now: FIXED_NOW,
  });
  // Row count says 1, but summary says 99 — pin to 99.
  assert.equal(h.creatives_total[6], 99);
});
