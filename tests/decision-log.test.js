'use strict';

/**
 * tests/decision-log.test.js
 *
 * Unit tests for lib/decisionLog.js — universal agent decision audit
 * trail. Verifies the propose → execute → outcome lifecycle + the
 * approval inbox.
 */

const test = require('node:test');
const assert = require('node:assert');

const { makeDecisionLogger, AUTO_SAFE_BANDS } = require('../lib/decisionLog');

function makeFakeSb() {
  const writes = [];
  const patches = [];
  let probeReachable = true;
  const tableData = new Map();

  return {
    writes,
    patches,
    setProbe(b) {
      probeReachable = b;
    },
    preload(table, rows) {
      tableData.set(table, rows);
    },
    sbGet: async (table, filter) => {
      if (filter === 'select=id&limit=1' && !probeReachable) {
        throw new Error('relation does not exist');
      }
      if (filter === 'select=id&limit=1') return [];
      return tableData.get(table) || [];
    },
    sbPost: async (table, row, opts = {}) => {
      const inserted = { id: `dec-${writes.length + 1}`, ...row, created_at: new Date().toISOString() };
      writes.push({ table, row });
      return opts.returning === 'representation' ? [inserted] : inserted;
    },
    sbPatch: async (table, filter, updates, opts = {}) => {
      patches.push({ table, filter, updates });
      const updated = { id: 'patched', ...updates };
      return opts.returning === 'representation' ? [updated] : updated;
    },
  };
}

// ─── Construction ─────────────────────────────────────────────────────────

test('decisionLog: requires sbPost dep', () => {
  assert.throws(() => makeDecisionLogger({}), /sbPost is a required dep/);
});

test('decisionLog: exports AUTO_SAFE_BANDS', () => {
  assert.deepStrictEqual(AUTO_SAFE_BANDS, ['green', 'yellow', 'red']);
});

// ─── proposeDecision ──────────────────────────────────────────────────────

test('proposeDecision: validates required fields', async () => {
  const log = makeDecisionLogger(makeFakeSb());
  await assert.rejects(
    () => log.proposeDecision({ agentName: 'x', decisionType: 'y', recommendationText: 'z' }),
    /required/
  );
});

test('proposeDecision: writes a row with sensible defaults', async () => {
  const sb = makeFakeSb();
  const log = makeDecisionLogger(sb);
  const r = await log.proposeDecision({
    businessId: 'b1',
    agentName: 'ad-optimizer',
    decisionType: 'refresh_creative',
    recommendationText: 'CTR dropped 31%. Refresh creative, not budget.',
  });
  assert.ok(r.id);
  assert.strictEqual(r.agent_name, 'ad-optimizer');
  assert.strictEqual(r.confidence, 0.5); // default
  assert.strictEqual(r.auto_safe_band, 'green'); // default
  assert.strictEqual(r.required_approval, false); // green = no approval
});

test('proposeDecision: clamps confidence to [0,1]', async () => {
  const sb = makeFakeSb();
  const log = makeDecisionLogger(sb);
  const tooHigh = await log.proposeDecision({
    businessId: 'b1',
    agentName: 'a',
    decisionType: 't',
    recommendationText: 'x',
    confidence: 5,
  });
  assert.strictEqual(tooHigh.confidence, 1);
  const tooLow = await log.proposeDecision({
    businessId: 'b1',
    agentName: 'a',
    decisionType: 't',
    recommendationText: 'x',
    confidence: -1,
  });
  assert.strictEqual(tooLow.confidence, 0);
});

test('proposeDecision: yellow band → required_approval=true automatically', async () => {
  const sb = makeFakeSb();
  const log = makeDecisionLogger(sb);
  const r = await log.proposeDecision({
    businessId: 'b1',
    agentName: 'content-generator',
    decisionType: 'publish_post',
    recommendationText: 'About to publish on healthcare claim — brand sensitive',
    autoSafeBand: 'yellow',
  });
  assert.strictEqual(r.required_approval, true);
});

test('proposeDecision: red band → required_approval=true automatically', async () => {
  const sb = makeFakeSb();
  const log = makeDecisionLogger(sb);
  const r = await log.proposeDecision({
    businessId: 'b1',
    agentName: 'ad-optimizer',
    decisionType: 'scale_budget',
    recommendationText: 'Above auto-spend threshold',
    autoSafeBand: 'red',
  });
  assert.strictEqual(r.required_approval, true);
});

test('proposeDecision: invalid band falls back to green', async () => {
  const sb = makeFakeSb();
  const log = makeDecisionLogger(sb);
  const r = await log.proposeDecision({
    businessId: 'b1',
    agentName: 'a',
    decisionType: 't',
    recommendationText: 'x',
    autoSafeBand: 'purple',
  });
  assert.strictEqual(r.auto_safe_band, 'green');
});

test('proposeDecision: returns soft result when logger offline', async () => {
  const sb = makeFakeSb();
  sb.setProbe(false);
  const log = makeDecisionLogger(sb);
  const r = await log.proposeDecision({
    businessId: 'b1',
    agentName: 'a',
    decisionType: 't',
    recommendationText: 'x',
  });
  assert.strictEqual(r.id, null);
  assert.strictEqual(r._soft, true);
});

test('proposeDecision: stores expected_upside text + value', async () => {
  const sb = makeFakeSb();
  const log = makeDecisionLogger(sb);
  const r = await log.proposeDecision({
    businessId: 'b1',
    agentName: 'a',
    decisionType: 't',
    recommendationText: 'x',
    expectedUpside: { text: '+15% CTR within 7 days', value: 0.15 },
  });
  assert.strictEqual(r.expected_upside_text, '+15% CTR within 7 days');
  assert.strictEqual(r.expected_upside_value, 0.15);
});

test('proposeDecision: rounds costUsd to 2 decimals', async () => {
  const sb = makeFakeSb();
  const log = makeDecisionLogger(sb);
  const r = await log.proposeDecision({
    businessId: 'b1',
    agentName: 'a',
    decisionType: 't',
    recommendationText: 'x',
    costUsd: 0.301234,
  });
  assert.strictEqual(r.cost_usd, 0.3);
});

// ─── recordExecution ──────────────────────────────────────────────────────

test('recordExecution: writes executed=true + executed_at', async () => {
  const sb = makeFakeSb();
  const log = makeDecisionLogger(sb);
  await log.recordExecution('dec-1', { executed: true, executionDetails: { new_creative_id: 'c1' } });
  assert.strictEqual(sb.patches.length, 1);
  assert.strictEqual(sb.patches[0].updates.executed, true);
  assert.ok(sb.patches[0].updates.executed_at);
});

test('recordExecution: writes refused=true + reason', async () => {
  const sb = makeFakeSb();
  const log = makeDecisionLogger(sb);
  await log.recordExecution('dec-1', { refused: true, refusalReason: 'compliance violation' });
  assert.strictEqual(sb.patches[0].updates.refused, true);
  assert.strictEqual(sb.patches[0].updates.refusal_reason, 'compliance violation');
});

test('recordExecution: returns null when no id', async () => {
  const log = makeDecisionLogger(makeFakeSb());
  assert.strictEqual(await log.recordExecution(null, { executed: true }), null);
});

// ─── recordOutcome ────────────────────────────────────────────────────────

test('recordOutcome: writes outcome + outcome_score clamped', async () => {
  const sb = makeFakeSb();
  const log = makeDecisionLogger(sb);
  await log.recordOutcome('dec-1', { outcome: { ctr: 0.04 }, outcomeScore: 1.5 });
  assert.strictEqual(sb.patches[0].updates.outcome_score, 1);
  assert.deepStrictEqual(sb.patches[0].updates.outcome, { ctr: 0.04 });
  assert.ok(sb.patches[0].updates.outcome_measured_at);
});

// ─── pendingApprovals + recentDecisions ───────────────────────────────────

test('pendingApprovals: returns rows from sb', async () => {
  const sb = makeFakeSb();
  sb.preload('decision_logs', [{ id: 'pending-1' }, { id: 'pending-2' }]);
  const log = makeDecisionLogger(sb);
  const r = await log.pendingApprovals('b1');
  assert.strictEqual(r.length, 2);
});

test('recentDecisions: filters by agentName', async () => {
  const sb = makeFakeSb();
  let capturedFilter = null;
  sb.sbGet = async (table, filter) => {
    if (filter === 'select=id&limit=1') return [];
    capturedFilter = filter;
    return [];
  };
  const log = makeDecisionLogger(sb);
  await log.recentDecisions('b1', { agentName: 'ad-optimizer' });
  assert.ok(capturedFilter.includes('agent_name=eq.ad-optimizer'));
});

// ─── approve ──────────────────────────────────────────────────────────────

test('approve: writes approved_by + approved_at', async () => {
  const sb = makeFakeSb();
  const log = makeDecisionLogger(sb);
  await log.approve('dec-1', 'user-uuid');
  assert.strictEqual(sb.patches[0].updates.approved_by, 'user-uuid');
  assert.ok(sb.patches[0].updates.approved_at);
});

test('approve: returns null without id or userId', async () => {
  const log = makeDecisionLogger(makeFakeSb());
  assert.strictEqual(await log.approve(null, 'u'), null);
  assert.strictEqual(await log.approve('d', null), null);
});

// ─── reject ───────────────────────────────────────────────────────────────

test('reject: sets refused=true with operator note + clears executed flag', async () => {
  const sb = makeFakeSb();
  const log = makeDecisionLogger(sb);
  await log.reject('dec-2', 'user-uuid', 'off-brand');
  const patch = sb.patches[0];
  assert.strictEqual(patch.updates.refused, true);
  assert.strictEqual(patch.updates.executed, false);
  assert.match(patch.updates.refusal_reason, /user-uuid/);
  assert.match(patch.updates.refusal_reason, /off-brand/);
});

test('reject: works without reason — still tracks actor', async () => {
  const sb = makeFakeSb();
  const log = makeDecisionLogger(sb);
  await log.reject('dec-3', 'user-uuid');
  assert.strictEqual(sb.patches[0].updates.refused, true);
  assert.match(sb.patches[0].updates.refusal_reason, /user-uuid/);
});

test('reject: returns null without id or userId', async () => {
  const log = makeDecisionLogger(makeFakeSb());
  assert.strictEqual(await log.reject(null, 'u'), null);
  assert.strictEqual(await log.reject('d', null), null);
});

test('reject: caps reason at 500 chars to prevent abuse', async () => {
  const sb = makeFakeSb();
  const log = makeDecisionLogger(sb);
  await log.reject('dec-4', 'user-uuid', 'x'.repeat(2000));
  // reason segment: everything after the actor note
  const note = sb.patches[0].updates.refusal_reason;
  const reasonSegment = note.split(': ').slice(1).join(': ');
  assert.ok(reasonSegment.length <= 500, `expected ≤ 500 chars, got ${reasonSegment.length}`);
});

// ─── getById ──────────────────────────────────────────────────────────────

test('getById: returns the row when found', async () => {
  const sb = makeFakeSb();
  sb.preload('decision_logs', [{ id: 'dec-5', business_id: 'b-cafe' }]);
  const log = makeDecisionLogger(sb);
  const row = await log.getById('dec-5');
  assert.strictEqual(row.id, 'dec-5');
});

test('getById: returns null for missing id', async () => {
  const log = makeDecisionLogger(makeFakeSb());
  assert.strictEqual(await log.getById(null), null);
});

// ─── Fail-safe ────────────────────────────────────────────────────────────

test('proposeDecision: sbPost throws → soft result, no exception', async () => {
  const sb = makeFakeSb();
  sb.sbPost = async () => {
    throw new Error('db down');
  };
  const log = makeDecisionLogger(sb);
  const r = await log.proposeDecision({
    businessId: 'b1',
    agentName: 'a',
    decisionType: 't',
    recommendationText: 'x',
  });
  assert.strictEqual(r.id, null);
  assert.strictEqual(r._soft, true);
});
