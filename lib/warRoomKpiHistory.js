'use strict';

const { classifyCreativeDecay } = require('./warRoomFeed');

/**
 * lib/warRoomKpiHistory.js — derives 7-day sparkline arrays + week-over-week
 * delta percentages for each KPI surfaced on the War Room dashboard.
 *
 * Computed strictly from existing tables, NO snapshot table required:
 *
 *   active_clients     — workspace_clients.added_at bucketed cumulatively
 *   creatives_total    — creative_assets.created_at bucketed cumulatively
 *   decaying_or_dead   — classifyCreativeDecay() replayed against each
 *                        day-end so the "needs refresh" trend is real,
 *                        not a current-snapshot guess
 *   experiments_running— experiments rows where status='running' AND
 *                        started_at ≤ day-end AND (ended_at IS NULL OR
 *                        ended_at > day-end). i.e. "was-running on day D"
 *   pending_approvals  — client_approvals rows where status='pending' AND
 *                        created_at ≤ day-end AND expires_at > day-end
 *   refusals_7d        — count of decision_logs with refused=true bucketed
 *                        by day (not cumulative; per-day count)
 *
 * Where source rows lack a timestamp (legacy data), we fall back to the
 * current value flat across all 7 days with delta = 0 — honest signal that
 * no history is available.
 *
 * Used by routes/war-room.js to splice `kpi_history` into the workspace
 * feed response. Pure function over its deps for easy testing.
 */

const DAYS = 7;
const DAY_MS = 86400000;

function _encode(v) {
  return encodeURIComponent(String(v));
}

/** Returns an array of 7 day-bucket end timestamps (oldest → newest). */
function dayEnds(now = Date.now()) {
  const today = new Date(now);
  today.setUTCHours(23, 59, 59, 999);
  const endTs = today.getTime();
  return Array.from({ length: DAYS }, (_, i) => endTs - (DAYS - 1 - i) * DAY_MS);
}

function safeIsoToMs(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/** % change between week-ago (index 0) and now (index 6). 0 if no prior. */
function weekDeltaPct(history) {
  const prior = history[0];
  const curr = history[history.length - 1];
  if (!prior || prior === 0) {
    return curr > 0 ? 100 : 0;
  }
  return Math.round(((curr - prior) / prior) * 100);
}

/** Direction inference. Threshold ±2% avoids "flat" reading as "up" on noise. */
function trendDir(history) {
  const delta = weekDeltaPct(history);
  if (delta > 2) return 'up';
  if (delta < -2) return 'down';
  return 'flat';
}

/** Build cumulative count of items by their createdAt timestamp at each bucket. */
function cumulativeFromCreatedAt(rows, getMs, ends) {
  const ts = rows.map((r) => getMs(r)).filter((t) => typeof t === 'number' && Number.isFinite(t));
  return ends.map((end) => ts.filter((t) => t <= end).length);
}

/** Per-day count of items whose `getMs(row)` falls inside that day. */
function perDayFromCreatedAt(rows, getMs, ends) {
  const dayStart = ends.map((e) => e - DAY_MS + 1);
  return ends.map((end, i) => {
    const start = dayStart[i];
    return rows.filter((r) => {
      const t = getMs(r);
      return typeof t === 'number' && t >= start && t <= end;
    }).length;
  });
}

/**
 * Compute KPI history for a workspace.
 *
 * @param {object} opts
 * @param {Function} opts.sbGet                      — Supabase fetcher (read-only)
 * @param {Array<string>} opts.businessIds           — businesses in the workspace
 * @param {object} opts.currentSummary               — same shape as feed.summary
 * @param {number} [opts.now]                        — clock injection for tests
 *
 * @returns {Promise<{
 *   active_clients: number[],
 *   creatives_total: number[],
 *   experiments_running: number[],
 *   pending_approvals: number[],
 *   refusals_7d: number[],
 *   delta_pct: Record<string, number>,
 *   trend: Record<string, 'up'|'down'|'flat'>
 * }>}
 */
async function buildKpiHistory({ sbGet, businessIds, currentSummary, now = Date.now() }) {
  const ends = dayEnds(now);
  const oldestMs = ends[0] - DAY_MS + 1;
  const oldestIso = new Date(oldestMs).toISOString();

  if (typeof sbGet !== 'function') {
    return flat(currentSummary);
  }
  if (!Array.isArray(businessIds) || businessIds.length === 0) {
    return flat(currentSummary);
  }

  // PostgREST `in.(...)` list — encode every id.
  const bizIn = `business_id=in.(${businessIds.map(_encode).join(',')})`;

  // Pull the rows we need; soft-fail on each individually so one bad table
  // doesn't blank the whole sparkline grid.
  async function tryGet(table, filter) {
    try {
      const r = await sbGet(table, filter);
      return Array.isArray(r) ? r : [];
    } catch {
      return null; // signal: this metric has no history available
    }
  }

  const [creativeRows, experimentRows, approvalRows, refusalRows, clientRows] = await Promise.all([
    tryGet(
      'creative_assets',
      `${bizIn}&select=id,business_id,created_at,performance_score&order=created_at.asc&limit=2000`
    ),
    tryGet('experiments', `${bizIn}&select=id,status,started_at,ended_at&limit=2000`),
    tryGet('client_approvals', `${bizIn}&select=id,status,created_at,expires_at&order=created_at.asc&limit=2000`),
    tryGet(
      'decision_logs',
      `${bizIn}&refused=eq.true&created_at=gte.${_encode(oldestIso)}` +
        `&select=id,created_at&order=created_at.asc&limit=2000`
    ),
    tryGet(
      'workspace_clients',
      `business_id=in.(${businessIds.map(_encode).join(',')})` +
        `&select=business_id,added_at&order=added_at.asc&limit=1000`
    ),
  ]);

  // Creatives — cumulative on created_at, fallback to flat
  const creatives_total = creativeRows
    ? cumulativeFromCreatedAt(creativeRows, (r) => safeIsoToMs(r.created_at), ends)
    : flatArr(currentSummary.creatives_total);

  // Decaying-or-dead — replay the classifier against each day-end. Real
  // historical signal: a creative that's "decaying" today was "maturing"
  // last week. Falls back to flat current value if creative rows missing.
  const decaying_or_dead = creativeRows
    ? ends.map((end) =>
        creativeRows.reduce((count, c) => {
          const bucket = classifyCreativeDecay(c, { now: end });
          return bucket === 'decaying' || bucket === 'dead' ? count + 1 : count;
        }, 0)
      )
    : flatArr(currentSummary.decaying_or_dead || 0);

  // Active clients — cumulative on added_at, fallback to flat
  const active_clients = clientRows
    ? cumulativeFromCreatedAt(clientRows, (r) => safeIsoToMs(r.added_at), ends)
    : flatArr(currentSummary.clients_total);

  // Experiments — "was running" on each day
  const experiments_running = experimentRows
    ? ends.map(
        (end) =>
          experimentRows.filter((e) => {
            const started = safeIsoToMs(e.started_at);
            if (started === null || started > end) return false;
            const ended = safeIsoToMs(e.ended_at);
            // Treat null ended_at as "still running" iff status==='running'.
            if (ended === null) return e.status === 'running';
            return ended > end;
          }).length
      )
    : flatArr(currentSummary.experiments_running);

  // Pending approvals — created ≤ end, not yet expired
  const pending_approvals = approvalRows
    ? ends.map(
        (end) =>
          approvalRows.filter((a) => {
            if (a.status !== 'pending') return false;
            const created = safeIsoToMs(a.created_at);
            if (created === null || created > end) return false;
            const expires = safeIsoToMs(a.expires_at);
            if (expires !== null && expires <= end) return false;
            return true;
          }).length
      )
    : flatArr(currentSummary.pending_approvals);

  // Refusals — per-day count from rows already filtered to last 7d
  const refusals_7d = refusalRows
    ? perDayFromCreatedAt(refusalRows, (r) => safeIsoToMs(r.created_at), ends)
    : flatArr(0);

  // If the most-recent point disagrees with the live summary, force the
  // summary value — the snapshot tables can drift by a row or two.
  active_clients[active_clients.length - 1] = currentSummary.clients_total;
  creatives_total[creatives_total.length - 1] = currentSummary.creatives_total;
  experiments_running[experiments_running.length - 1] = currentSummary.experiments_running;
  pending_approvals[pending_approvals.length - 1] = currentSummary.pending_approvals;
  if (typeof currentSummary.decaying_or_dead === 'number') {
    decaying_or_dead[decaying_or_dead.length - 1] = currentSummary.decaying_or_dead;
  }

  const series = {
    active_clients,
    creatives_total,
    decaying_or_dead,
    experiments_running,
    pending_approvals,
    refusals_7d,
  };
  const delta_pct = Object.fromEntries(Object.entries(series).map(([k, v]) => [k, weekDeltaPct(v)]));
  const trend = Object.fromEntries(Object.entries(series).map(([k, v]) => [k, trendDir(v)]));

  return { ...series, delta_pct, trend };
}

// ─── Helpers for the "no source data" fallback ─────────────────────────────

function flatArr(value) {
  return Array.from({ length: DAYS }, () => value);
}

function flat(currentSummary = {}) {
  const series = {
    active_clients: flatArr(currentSummary.clients_total || 0),
    creatives_total: flatArr(currentSummary.creatives_total || 0),
    decaying_or_dead: flatArr(currentSummary.decaying_or_dead || 0),
    experiments_running: flatArr(currentSummary.experiments_running || 0),
    pending_approvals: flatArr(currentSummary.pending_approvals || 0),
    refusals_7d: flatArr(0),
  };
  const delta_pct = Object.fromEntries(Object.keys(series).map((k) => [k, 0]));
  const trend = Object.fromEntries(Object.keys(series).map((k) => [k, 'flat']));
  return { ...series, delta_pct, trend };
}

module.exports = {
  buildKpiHistory,
  weekDeltaPct,
  trendDir,
  _internals: { dayEnds, cumulativeFromCreatedAt, perDayFromCreatedAt },
};
