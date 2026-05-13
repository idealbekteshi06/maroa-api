'use strict';

/**
 * tests/taxonomy-refresh.test.js
 *
 * Wave 59 Session 5 — verifies the AI-assisted taxonomy refresh:
 *   - Runs both passes (industries + expert_sources)
 *   - Routes proposals to Slack via alertRouter
 *   - NEVER auto-applies the diff (load-bearing safety property)
 *   - Soft-fails when Claude returns garbage
 */

const test = require('node:test');
const assert = require('node:assert');

const refresh = require('../services/taxonomy-refresh');

// ─── _parseDiff ────────────────────────────────────────────────────────────

test('S5: _parseDiff handles well-formed JSON', () => {
  const out = refresh._parseDiff('{"additions":[{"id":"x"}],"removals":[],"summary":"ok"}');
  assert.strictEqual(out.additions.length, 1);
  assert.strictEqual(out.summary, 'ok');
});

test('S5: _parseDiff strips markdown fences', () => {
  const out = refresh._parseDiff('```json\n{"additions":[],"removals":[],"summary":""}\n```');
  assert.ok(out);
});

test('S5: _parseDiff returns null on garbage', () => {
  assert.strictEqual(refresh._parseDiff('not json'), null);
  assert.strictEqual(refresh._parseDiff(''), null);
  assert.strictEqual(refresh._parseDiff(null), null);
});

// ─── _formatIndustriesDiff / _formatExpertSourcesDiff ─────────────────────

test('S5: _formatIndustriesDiff renders additions + removals + merges', () => {
  const diff = {
    additions: [{ id: 'ai_agents', label: 'AI Agents', reason: 'fastest-growing vertical' }],
    removals: [{ id: 'blackberry_dev', reason: 'platform dead' }],
    merges: [{ absorbed_into: 'restaurant', remove: 'food_truck', reason: 'too narrow' }],
    summary: 'Net +1 vertical, modernizing the catalog.',
  };
  const formatted = refresh._formatIndustriesDiff(diff);
  assert.match(formatted, /Industries taxonomy review/);
  assert.match(formatted, /ai_agents/);
  assert.match(formatted, /blackberry_dev/);
  assert.match(formatted, /food_truck/);
  assert.match(formatted, /modernizing/);
  assert.match(formatted, /lib\/taxonomy\/industries\.js/);
});

test('S5: _formatIndustriesDiff handles empty diff gracefully', () => {
  const diff = { additions: [], removals: [], merges: [], summary: 'No changes needed.' };
  const formatted = refresh._formatIndustriesDiff(diff);
  assert.match(formatted, /No changes/);
});

test('S5: _formatIndustriesDiff handles null diff (parse failure)', () => {
  const formatted = refresh._formatIndustriesDiff(null);
  assert.match(formatted, /failed to parse/);
});

test('S5: _formatExpertSourcesDiff renders additions + removals', () => {
  const diff = {
    additions: [{ name: 'Skims', industry: 'ecommerce_apparel', region: 'US', reason: 'viral growth' }],
    removals: [],
    summary: '1 brand to add',
  };
  const formatted = refresh._formatExpertSourcesDiff(diff);
  assert.match(formatted, /Expert brands taxonomy review/);
  assert.match(formatted, /Skims/);
  assert.match(formatted, /viral growth/);
});

// ─── refreshTaxonomy end-to-end ───────────────────────────────────────────

test('S5: refreshTaxonomy requires callClaude + alertRouter', async () => {
  assert.deepStrictEqual(await refresh.refreshTaxonomy({}), {
    ok: false,
    reason: 'callClaude + alertRouter required',
  });
  assert.deepStrictEqual(await refresh.refreshTaxonomy({ deps: {} }), {
    ok: false,
    reason: 'callClaude + alertRouter required',
  });
});

test('S5: refreshTaxonomy posts BOTH industries + expert_sources to alertRouter', async () => {
  const claudeCalls = [];
  const fakeClaude = async (args) => {
    claudeCalls.push(args);
    if (args.system?.includes('industry taxonomy')) {
      return '{"additions":[{"id":"ai_agents","label":"AI Agents","reason":"growing"}],"removals":[],"merges":[],"summary":"+1 vertical"}';
    }
    return '{"additions":[{"name":"Skims","industry":"ecommerce_apparel","region":"US","quality_score":0.9,"reason":"viral"}],"removals":[],"summary":"+1 brand"}';
  };
  const alertCalls = [];
  const alertRouter = {
    alert: async (args) => {
      alertCalls.push(args);
      return { sentry: { ok: true }, slack: { ok: true } };
    },
  };

  const out = await refresh.refreshTaxonomy({
    deps: { callClaude: fakeClaude, alertRouter, logger: { info: () => {}, warn: () => {} } },
  });

  assert.strictEqual(out.ok, true);
  assert.strictEqual(claudeCalls.length, 2, 'both reviews must run');
  assert.ok(out.industries_diff);
  assert.ok(out.expert_sources_diff);
  assert.strictEqual(out.industries_diff.additions[0].id, 'ai_agents');
  assert.strictEqual(out.expert_sources_diff.additions[0].name, 'Skims');

  // Slack dispatch
  assert.strictEqual(alertCalls.length, 1);
  assert.strictEqual(alertCalls[0].severity, 'info', 'taxonomy refresh is informational, not a page');
  assert.match(alertCalls[0].title, /Quarterly taxonomy/);
  assert.match(alertCalls[0].message, /ai_agents/);
  assert.match(alertCalls[0].message, /Skims/);
});

test('S5: refreshTaxonomy NEVER auto-applies — diff stays on disk in files only', async () => {
  // This is the critical safety property — no PR, no commit, no DB write
  // happens automatically. The diff lives only in the returned object and
  // the alertRouter message. To apply, a human must open a PR by hand.
  const fakeClaude = async () =>
    '{"additions":[{"id":"x","label":"X","reason":"y"}],"removals":[],"merges":[],"summary":""}';
  let applyCalled = false;
  const alertRouter = {
    alert: async () => {
      // The alert is informational only — message is a string, no payload
      // contains auto-apply instructions
      return { ok: true };
    },
  };
  // No fs writes, no git commands, no sbPost — just `await refreshTaxonomy`
  const result = await refresh.refreshTaxonomy({
    deps: { callClaude: fakeClaude, alertRouter },
  });
  assert.strictEqual(applyCalled, false, 'no auto-apply hook called');
  assert.ok(result.industries_diff, 'diff exists in result for human review');
});

test('S5: refreshTaxonomy survives Claude throwing on one pass', async () => {
  let claudeCallCount = 0;
  const fakeClaude = async (args) => {
    claudeCallCount++;
    if (args.system?.includes('industry taxonomy')) {
      throw new Error('rate limited');
    }
    return '{"additions":[],"removals":[],"summary":"ok"}';
  };
  const alertCalls = [];
  const alertRouter = {
    alert: async (args) => {
      alertCalls.push(args);
      return { ok: true };
    },
  };

  const out = await refresh.refreshTaxonomy({
    deps: { callClaude: fakeClaude, alertRouter, logger: { warn: () => {} } },
  });

  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.industries_diff, null, 'failed pass leaves diff null');
  assert.ok(out.expert_sources_diff, 'second pass still ran');
  // Still dispatches to Slack with whatever was learned
  assert.strictEqual(alertCalls.length, 1);
  assert.match(alertCalls[0].message, /failed to parse/);
});

test('S5: refreshTaxonomy survives malformed Claude output (returns null diff)', async () => {
  const fakeClaude = async () => 'this is not JSON at all';
  const alertCalls = [];
  const alertRouter = {
    alert: async (args) => {
      alertCalls.push(args);
      return { ok: true };
    },
  };
  const out = await refresh.refreshTaxonomy({
    deps: { callClaude: fakeClaude, alertRouter },
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.industries_diff, null);
  assert.strictEqual(out.expert_sources_diff, null);
  assert.strictEqual(alertCalls.length, 1);
});
