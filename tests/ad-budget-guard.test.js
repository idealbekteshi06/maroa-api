'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateMonthlyBudget, ceilingFor } = require('../lib/adBudgetGuard');

test('ceilingFor: returns 0 for free, 5000 for growth, 50000 for agency', () => {
  assert.equal(ceilingFor('free'), 0);
  assert.equal(ceilingFor('growth'), 5_000);
  assert.equal(ceilingFor('agency'), 50_000);
  assert.equal(ceilingFor('enterprise'), Infinity);
});

test('ceilingFor: unknown plan defaults to free', () => {
  assert.equal(ceilingFor('frobnicator'), 0);
  assert.equal(ceilingFor(undefined), 0);
});

test('validateMonthlyBudget: growth $300 is fine', () => {
  const r = validateMonthlyBudget({ plan: 'growth', monthlyBudget: 300 });
  assert.equal(r.ok, true);
  assert.equal(r.ceiling, 5_000);
});

test('validateMonthlyBudget: growth $10,000 blocked', () => {
  const r = validateMonthlyBudget({ plan: 'growth', monthlyBudget: 10_000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BUDGET_OVER_PLAN_CEILING');
  assert.equal(r.ceiling, 5_000);
});

test('validateMonthlyBudget: agency $40,000 fine', () => {
  const r = validateMonthlyBudget({ plan: 'agency', monthlyBudget: 40_000 });
  assert.equal(r.ok, true);
});

test('validateMonthlyBudget: 0 and negative rejected', () => {
  assert.equal(validateMonthlyBudget({ plan: 'agency', monthlyBudget: 0 }).ok, false);
  assert.equal(validateMonthlyBudget({ plan: 'agency', monthlyBudget: -10 }).ok, false);
});

test('validateMonthlyBudget: free plan rejects any non-zero budget', () => {
  const r = validateMonthlyBudget({ plan: 'free', monthlyBudget: 10 });
  assert.equal(r.ok, false);
});

test('validateMonthlyBudget: enterprise has no ceiling', () => {
  const r = validateMonthlyBudget({ plan: 'enterprise', monthlyBudget: 1_000_000 });
  assert.equal(r.ok, true);
});
