'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { completenessScore } = require('../routes/onboarding');

test('completenessScore: empty profile is 0 and lists required missing fields', () => {
  const r = completenessScore(null);
  assert.equal(r.score, 0);
  assert.deepEqual(r.missing_fields.sort(), ['business_name', 'industry', 'location'].sort());
});

test('completenessScore: required-fields filled scores at least 50', () => {
  const r = completenessScore({ business_name: 'X', industry: 'Y', location: 'Z' });
  assert.ok(r.score >= 50, `expected >= 50, got ${r.score}`);
  assert.deepEqual(r.missing_fields, []);
});

test('completenessScore: 100 when all six scored fields are filled', () => {
  const r = completenessScore({
    business_name: 'X',
    industry: 'Y',
    location: 'Z',
    target_audience: 'A',
    marketing_goal: 'G',
    brand_tone: 'T',
  });
  assert.equal(r.score, 100);
  assert.equal(r.recommendations.length, 0);
});

test('completenessScore: partial profile surfaces only the relevant recommendations', () => {
  const r = completenessScore({
    business_name: 'X',
    industry: 'Y',
    location: 'Z',
    target_audience: 'A',
  });
  assert.deepEqual(r.missing_fields, []);
  // marketing_goal + brand_tone missing → 2 recs.
  assert.equal(r.recommendations.length, 2);
});
