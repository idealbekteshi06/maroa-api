'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const customerResearch = require('../services/prompts/frameworks/customer-research');
const copyEditing = require('../services/prompts/frameworks/copy-editing');
const mpAudit = require('../services/prompts/frameworks/multi-platform-audit');
const recursiveRefine = require('../services/prompts/creative-director/recursive-refine');
const { buildCreativeDirectorSystemPrompt } = require('../services/prompts/creative-director/system-prompt');
const adOptimizer = require('../services/prompts/ad-optimizer');
const { gate, COPY_EDITING_TYPES } = require('../services/prompts/quality-gate');
const checksMeta = require('../services/prompts/ad-optimizer/checks-meta');

test('customer-research framework includes confidence labels', () => {
  const s = customerResearch.buildCustomerResearchPromptSection();
  assert.match(s, /high.*medium.*low/i);
  assert.match(s, /Jobs to Be Done/i);
});

test('copy-editing heuristics flag vague corporate phrases', () => {
  const r = copyEditing.runSevenSweepsHeuristics('Our innovative solution leverages best-in-class synergy.');
  assert.equal(r.passed, false);
  assert.ok(r.issues.length > 0);
});

test('multi-platform merge tags findings by platform', () => {
  const merged = mpAudit.mergeMultiPlatformBundles(
    [
      { platform: 'meta', findings: [{ check_id: 'M01', severity: 'warning', category: 'delivery' }], auditScore: 70 },
      { platform: 'google', findings: [{ check_id: 'G01', severity: 'info', category: 'delivery' }], auditScore: 80 },
    ],
    { meta: 0.6, google: 0.4 }
  );
  assert.equal(merged.auditScore, 74);
  assert.ok(merged.findings.some((f) => f.platform === 'meta'));
  assert.ok(merged.multi_platform.parallel_audit);
});

test('buildAuditInputs supports metricsByPlatform parallel path', () => {
  const business = { business_name: 'Test', country: 'US', primary_language: 'en' };
  const inputs = adOptimizer.buildAuditInputs({
    business,
    metricsByPlatform: {
      meta: { spend: 100, clicks: 200, impressions: 10000, daily_budget: 50, ctr: 0.02 },
      google: { spend: 50, clicks: 80, impressions: 5000, daily_budget: 30, ctr: 0.015 },
    },
    plan: 'agency',
  });
  assert.equal(inputs.platform, 'multi');
  assert.ok(inputs.multi_platform?.parallel_audit);
  assert.equal(inputs.multi_platform.platforms.length, 2);
});

test('creative-director system prompt includes recursive refine + SMB stopping', () => {
  const p = buildCreativeDirectorSystemPrompt({}, 'grow revenue', 'instagram reel', { ideaLevel: 'execution' });
  assert.match(p, /Brief compliance/i);
  assert.match(p, /recursive refine/i);
  assert.match(p, /3 refinement passes/i);
  assert.match(p, /HumanKind ≥ 6/i);
  assert.ok(recursiveRefine.buildRecursiveRefineSection('execution').includes('HumanKind'));
});

test('quality gate COPY_EDITING_TYPES includes ad_copy', () => {
  assert.ok(COPY_EDITING_TYPES.has('ad_copy'));
});

test('clean copy passes seven sweeps in gate ship path', async () => {
  const r = await gate({
    text: 'Free parking after 6pm. Book your table in 30 seconds.',
    business: { business_name: 'Cafe', primary_language: 'en', industry: 'restaurant' },
    contentType: 'caption',
    plan: 'free',
    bypass: false,
  });
  assert.equal(r.decision, 'ship');
  if (r.checks.copy_editing) assert.equal(r.checks.copy_editing.passed, true);
});
