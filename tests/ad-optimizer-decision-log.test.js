'use strict';

/**
 * tests/ad-optimizer-decision-log.test.js
 * ----------------------------------------------------------------------------
 * Verifies the ad-optimizer engine's mirror into decision_logs.
 *
 * The mirror fires after every audit decision (scale | pause | optimize |
 * keep | refresh_creative). It maps the audit decision onto:
 *   - decisionType = 'campaign_audit'
 *   - decisionSubtype = the decision string
 *   - autoSafeBand: red (pause) | yellow (scale|optimize) | green (else)
 *   - executed: true only if dryRun=false AND action_taken changed state
 *
 * Test strategy: stub out all DB + Claude calls, intercept the decisionLog
 * call, and assert the recorded row shape.
 * ----------------------------------------------------------------------------
 */

const test = require('node:test');
const assert = require('node:assert');

const createEngine = require('../services/ad-optimizer/engine');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMinimalDeps({ recordedDecisions, auditOverride } = {}) {
  const sbGet = async (table, query = '') => {
    if (table === 'ad_campaigns') {
      return [
        {
          id: 'camp-1',
          business_id: 'biz-1',
          name: 'Test Campaign',
          status: 'ACTIVE',
          daily_budget: 50,
          objective: 'OUTCOME_TRAFFIC',
          platform: 'meta',
        },
      ];
    }
    if (table === 'businesses') {
      return [{ id: 'biz-1', plan: 'growth', location: 'New York', primary_language: 'en' }];
    }
    if (table === 'ad_performance_logs') {
      return [
        { logged_at: '2026-05-13T08:00:00Z', spend: 47, clicks: 30, conversions: 2, ctr: 1.5 },
      ];
    }
    if (table === 'ad_audit_results') return [];
    return [];
  };

  const sbPost = async () => {};
  const sbPatch = async () => {};

  // Stub Claude to return a deterministic audit decision
  const callClaude = async () => JSON.stringify(auditOverride || {
    decision: 'keep',
    decision_reason: 'Campaign performing within bands',
    audit_score: 72,
    score_breakdown: {},
    critical_issues: [],
    warnings: [],
    opportunities: [],
    trend: 'stable',
    citations: [],
    market_tier: 'ULTRA_HIGH',
    budget_tier: 'STARTER',
    gates: {},
  });

  const extractJSON = (s) => {
    try { return JSON.parse(s); } catch { return null; }
  };

  // Stub decisionLog that records what would be written
  const decisionLog = {
    proposeDecision: async (row) => {
      recordedDecisions.push(row);
      return { ok: true, decisionId: 'decision-' + recordedDecisions.length };
    },
  };

  return { sbGet, sbPost, sbPatch, callClaude, extractJSON, decisionLog, logger: null, Sentry: null };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('ad-optimizer decisionLog mirror: writes a row after a "keep" decision', async () => {
  const recorded = [];
  const engine = createEngine(makeMinimalDeps({
    recordedDecisions: recorded,
    auditOverride: {
      decision: 'keep',
      decision_reason: 'Stable, no action needed',
      audit_score: 80,
    },
  }));

  await engine.auditOne({ campaignId: 'camp-1', businessId: 'biz-1', dryRun: true });

  assert.strictEqual(recorded.length, 1, 'mirror should fire once');
  const row = recorded[0];
  assert.strictEqual(row.agentName, 'ad-optimizer');
  assert.strictEqual(row.decisionType, 'campaign_audit');
  assert.strictEqual(row.decisionSubtype, 'keep');
  assert.strictEqual(row.autoSafeBand, 'green', 'keep is informational → green');
  assert.strictEqual(row.businessId, 'biz-1');
  assert.strictEqual(row.refused, false);
});

test('ad-optimizer decisionLog mirror: every mirrored row has a valid autoSafeBand', async () => {
  const recorded = [];
  const engine = createEngine(makeMinimalDeps({ recordedDecisions: recorded }));

  await engine.auditOne({ campaignId: 'camp-1', businessId: 'biz-1', dryRun: true });

  assert.strictEqual(recorded.length, 1);
  assert.ok(
    ['red', 'yellow', 'green'].includes(recorded[0].autoSafeBand),
    `autoSafeBand must be red|yellow|green, got: ${recorded[0].autoSafeBand}`
  );
});

test('ad-optimizer decisionLog mirror: decisionSubtype is a known audit verb', async () => {
  const recorded = [];
  const engine = createEngine(makeMinimalDeps({ recordedDecisions: recorded }));

  await engine.auditOne({ campaignId: 'camp-1', businessId: 'biz-1', dryRun: true });

  assert.ok(
    ['keep', 'scale', 'optimize', 'pause', 'refresh_creative'].includes(recorded[0].decisionSubtype),
    `decisionSubtype must be a known audit verb, got: ${recorded[0].decisionSubtype}`
  );
});

test('ad-optimizer decisionLog mirror: dryRun=true → executed=false', async () => {
  const recorded = [];
  const engine = createEngine(makeMinimalDeps({
    recordedDecisions: recorded,
    auditOverride: { decision: 'scale', new_daily_budget: 100, audit_score: 88 },
  }));

  await engine.auditOne({ campaignId: 'camp-1', businessId: 'biz-1', dryRun: true });

  assert.strictEqual(recorded[0].executed, false, 'dryRun must NOT execute');
});

test('ad-optimizer decisionLog mirror: missing decisionLog dep is safe (no throw)', async () => {
  const deps = makeMinimalDeps({ recordedDecisions: [] });
  delete deps.decisionLog;
  const engine = createEngine(deps);

  // Should not throw — the mirror is a pure side-effect that no-ops when
  // the logger isn't wired.
  await assert.doesNotReject(
    engine.auditOne({ campaignId: 'camp-1', businessId: 'biz-1', dryRun: true })
  );
});

test('ad-optimizer decisionLog mirror: decisionLog throw must NOT break the audit', async () => {
  const recorded = [];
  const deps = makeMinimalDeps({ recordedDecisions: recorded });
  // Replace with a logger that throws
  deps.decisionLog = {
    proposeDecision: async () => {
      throw new Error('synthetic mirror failure');
    },
  };
  // Capture the warn so it doesn't pollute test output
  deps.logger = { warn: () => {}, info: () => {}, error: () => {} };

  const engine = createEngine(deps);

  // The audit must succeed even if the mirror fails.
  const result = await engine.auditOne({ campaignId: 'camp-1', businessId: 'biz-1', dryRun: true });
  assert.ok(result, 'audit must complete despite mirror failure');
  assert.ok(result.audit, 'audit object should still be returned');
});

test('ad-optimizer decisionLog mirror: budgetImpactUsd is always a number (not null/undefined)', async () => {
  const recorded = [];
  const engine = createEngine(makeMinimalDeps({
    recordedDecisions: recorded,
    auditOverride: {
      decision: 'scale',
      decision_reason: 'Scaling',
      audit_score: 90,
      new_daily_budget: 75,
    },
  }));

  await engine.auditOne({ campaignId: 'camp-1', businessId: 'biz-1', dryRun: true });

  // Whether the delta is 25 (passthrough) or 0 (normalized away by
  // auditCampaign) depends on engine internals — but the field MUST exist
  // and be a number, so downstream consumers can rely on it.
  assert.strictEqual(typeof recorded[0].budgetImpactUsd, 'number');
});

test('ad-optimizer decisionLog mirror: targetEntity captures campaign id + name', async () => {
  const recorded = [];
  const engine = createEngine(makeMinimalDeps({
    recordedDecisions: recorded,
    auditOverride: { decision: 'keep', audit_score: 70 },
  }));

  await engine.auditOne({ campaignId: 'camp-1', businessId: 'biz-1', dryRun: true });

  assert.deepStrictEqual(recorded[0].targetEntity, {
    type: 'campaign',
    id: 'camp-1',
    name: 'Test Campaign',
  });
});
