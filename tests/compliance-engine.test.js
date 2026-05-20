'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createComplianceEngine,
  classify,
  severityRollup,
  rulesetFor,
} = require('../lib/complianceEngine');

const generic = rulesetFor('generic');
const cafe = rulesetFor('cafe');

test('classifier hits hard rule on income claim', () => {
  const matches = classify(
    'You can make $5,000 per month from home with our system.',
    generic,
  );
  assert.ok(matches.some((m) => m.severity === 'hard' && m.rule_id === 'generic.income_claim'));
});

test('classifier hits hard rule on absolute guarantee', () => {
  const matches = classify(
    'Guaranteed weight loss in 7 days or your money back.',
    generic,
  );
  assert.ok(matches.some((m) => m.severity === 'hard'));
});

test('classifier hits soft rule on "world\'s best"', () => {
  const matches = classify("World's best coffee, hands down.", generic);
  assert.ok(matches.some((m) => m.rule_id === 'generic.superlative_best'));
});

test('classifier passes clean copy', () => {
  const matches = classify(
    'New seasonal blend, roasted this week. Available at our Tirana shop until Sunday.',
    generic,
  );
  // Cafe ruleset would also be tested; generic should pass.
  assert.equal(matches.filter((m) => m.severity === 'hard').length, 0);
});

test('café "organic" without certification is hard-blocked', () => {
  const matches = classify(
    'Our coffee is 100% organic and fair trade.',
    cafe,
  );
  assert.ok(matches.some((m) => m.rule_id === 'cafe.organic_uncertified'));
  assert.ok(matches.some((m) => m.rule_id === 'cafe.fair_trade_unverified'));
});

test('café health claim is hard-blocked', () => {
  const matches = classify(
    'Coffee cures fatigue and boosts metabolism — proven antioxidants fight aging.',
    cafe,
  );
  assert.ok(matches.some((m) => m.severity === 'hard'));
});

test('severityRollup picks the strongest match', () => {
  assert.equal(severityRollup([]), 'clean');
  assert.equal(severityRollup([{ severity: 'info' }]), 'info');
  assert.equal(severityRollup([{ severity: 'soft' }, { severity: 'info' }]), 'soft');
  assert.equal(severityRollup([{ severity: 'soft' }, { severity: 'hard' }]), 'hard');
});

test('engine evaluate returns ok=false on hard violation', async () => {
  const engine = createComplianceEngine({});
  const verdict = await engine.evaluate({
    businessId: '00000000-0000-4000-8000-000000000001',
    industry: 'cafe',
    draft: 'Our 100% organic certified coffee guarantees weight loss.',
    surface: 'meta_ad',
    plan: 'agency',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.severity, 'hard');
  assert.ok(verdict.violations.length >= 2);
  assert.equal(verdict.appealable, true);
});

test('engine evaluate hides soft violations from growth tier', async () => {
  const engine = createComplianceEngine({});
  const verdict = await engine.evaluate({
    businessId: '00000000-0000-4000-8000-000000000002',
    industry: 'generic',
    draft: "We're the world's best coffee shop, number one in the city.",
    surface: 'social_post',
    plan: 'growth',
  });
  // Growth sees only hard enforcement
  assert.equal(verdict.ok, true);
  assert.equal(verdict.severity, 'soft');
});

test('engine evaluate accepts clean café copy', async () => {
  const engine = createComplianceEngine({});
  const verdict = await engine.evaluate({
    businessId: '00000000-0000-4000-8000-000000000003',
    industry: 'cafe',
    draft:
      'Our newest seasonal espresso, roasted this Tuesday. ' +
      'Brought in from a small farm outside Korçë — limited to 80kg this year.',
    surface: 'meta_ad',
    plan: 'agency',
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.severity, 'clean');
});
