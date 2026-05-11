'use strict';

/**
 * tests/helpers/fakeSupabase.js
 *
 * In-memory PostgREST fake. Provides sbGet/sbPost/sbPatch/sbDelete helpers
 * with the same shapes server.js exports. Internally backed by plain
 * JavaScript Maps so tests can pre-seed rows and assert mutations
 * synchronously.
 *
 * Supported PostgREST filter ops (subset that covers Maroa's usage):
 *   col=eq.VALUE          equality
 *   col=neq.VALUE         not-equal
 *   col=in.(a,b,c)        IN list
 *   col=gte.X / lte.X     numeric / date compare
 *   col=is.null           NULL check
 *   select=col1,col2      column projection
 *   order=col.asc|desc    single-column ordering
 *   limit=N / offset=N
 *
 * Anything outside this subset returns the matching row set unfiltered —
 * tests that need fancier predicates can use `db.where()` direct.
 *
 * Usage:
 *
 *   const db = createFakeSupabase();
 *   db.seed('businesses', [{ id: 'b1', plan: 'growth' }, { id: 'b2', plan: 'free' }]);
 *   const rows = await db.sbGet('businesses', 'id=eq.b1&select=plan');
 *   assert.strictEqual(rows[0].plan, 'growth');
 *
 * Conflict simulation: pass { failOn: { businesses: 'sbPost' } } to force
 * a specific method to throw. Useful for testing soft-fail paths.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createFakeSupabase(opts = {}) {
  const { failOn = {}, autogenId = true } = opts;
  /** @type {Map<string, Array<object>>} */
  const tables = new Map();

  function getTable(name) {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  }

  function maybeFail(table, method) {
    const m = failOn[table];
    if (m && (m === method || (Array.isArray(m) && m.includes(method)))) {
      const err = new Error(`fakeSupabase: ${method} ${table} forced to fail`);
      err.status = 503;
      throw err;
    }
  }

  function parseFilters(query) {
    const search = new URLSearchParams(query);
    const out = { filters: [], select: null, order: null, limit: null, offset: null };
    for (const [k, v] of search.entries()) {
      if (k === 'select') { out.select = v.split(',').map((s) => s.trim()); continue; }
      if (k === 'order') {
        const [col, dir] = v.split('.');
        out.order = { col, dir: dir || 'asc' };
        continue;
      }
      if (k === 'limit') { out.limit = Number(v); continue; }
      if (k === 'offset') { out.offset = Number(v); continue; }
      out.filters.push({ col: k, raw: v });
    }
    return out;
  }

  function rowMatchesFilter(row, filter) {
    const { col, raw } = filter;
    const [op, ...rest] = raw.split('.');
    const val = rest.join('.');
    switch (op) {
      case 'eq':  return String(row[col]) === decodeURIComponent(val);
      case 'neq': return String(row[col]) !== decodeURIComponent(val);
      case 'in': {
        const list = val.replace(/^[(]/, '').replace(/[)]$/, '').split(',').map(decodeURIComponent);
        return list.includes(String(row[col]));
      }
      case 'gte': return Number(row[col]) >= Number(val) || String(row[col]) >= String(val);
      case 'lte': return Number(row[col]) <= Number(val) || String(row[col]) <= String(val);
      case 'is':  return val === 'null' ? row[col] == null : row[col] === val;
      default:    return true;
    }
  }

  function applyQuery(rows, parsed) {
    let out = rows.filter((row) => parsed.filters.every((f) => rowMatchesFilter(row, f)));
    if (parsed.order) {
      out = [...out].sort((a, b) => {
        if (a[parsed.order.col] < b[parsed.order.col]) return parsed.order.dir === 'asc' ? -1 : 1;
        if (a[parsed.order.col] > b[parsed.order.col]) return parsed.order.dir === 'asc' ? 1 : -1;
        return 0;
      });
    }
    if (parsed.offset) out = out.slice(parsed.offset);
    if (parsed.limit) out = out.slice(0, parsed.limit);
    if (parsed.select && !(parsed.select.length === 1 && parsed.select[0] === '*')) {
      out = out.map((r) => Object.fromEntries(parsed.select.map((c) => [c, r[c]])));
    }
    return out;
  }

  function rid() {
    // Deterministic-enough UUIDs for tests; not real v4 but parses as UUID
    return `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, '0')}`;
  }

  async function sbGet(table, query = '') {
    maybeFail(table, 'sbGet');
    const parsed = parseFilters(query);
    return applyQuery(getTable(table), parsed);
  }

  async function sbPost(table, data) {
    maybeFail(table, 'sbPost');
    const rows = getTable(table);
    const row = { ...(autogenId && !data.id ? { id: rid() } : {}), ...data };
    // Simulate PK conflict on common dedup tables
    if (table === 'webhook_events') {
      const exists = rows.find((r) => r.provider === row.provider && r.event_id === row.event_id);
      if (exists) {
        const err = new Error('duplicate key value violates unique constraint (409)');
        err.status = 409;
        throw err;
      }
    }
    rows.push(row);
    return row;
  }

  async function sbPatch(table, filter, data) {
    maybeFail(table, 'sbPatch');
    const rows = getTable(table);
    const parsed = parseFilters(filter);
    const matched = rows.filter((row) => parsed.filters.every((f) => rowMatchesFilter(row, f)));
    for (const r of matched) Object.assign(r, data);
    return true;
  }

  async function sbDelete(table, filter) {
    maybeFail(table, 'sbDelete');
    const rows = getTable(table);
    const parsed = parseFilters(filter);
    const before = rows.length;
    const kept = rows.filter((row) => !parsed.filters.every((f) => rowMatchesFilter(row, f)));
    tables.set(table, kept);
    return before - kept.length;
  }

  // Helpers for tests
  function seed(table, rows) {
    if (!Array.isArray(rows)) rows = [rows];
    const t = getTable(table);
    for (const r of rows) t.push({ ...r });
    return t.length;
  }
  function reset(table) {
    if (table) tables.set(table, []);
    else tables.clear();
  }
  function where(table, predicate) {
    return getTable(table).filter(predicate);
  }
  function all(table) {
    return [...getTable(table)];
  }

  return {
    sbGet, sbPost, sbPatch, sbDelete,
    seed, reset, where, all,
    _tables: tables,
    UUID_RE,
  };
}

module.exports = { createFakeSupabase };
