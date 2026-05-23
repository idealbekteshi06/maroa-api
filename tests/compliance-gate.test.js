'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ensureCompliant, evaluateOnly, ComplianceBlocked, _resetForTest } = require('../lib/complianceGate');

test('ensureCompliant passes clean content', async () => {
  _resetForTest();
  const r = await ensureCompliant({
    content: 'Come visit our cafe this Saturday for a free pastry tasting.',
    industry: 'cafe',
    businessId: 'b1',
    plan: 'growth',
  });
  assert.equal(r.severity, 'clean');
  assert.equal(r.ok, true);
});

test('ensureCompliant throws ComplianceBlocked on hard violation', async () => {
  _resetForTest();
  await assert.rejects(
    ensureCompliant({
      content: 'I guarantee you 5x ROI in 30 days, $5,000 per month minimum.',
      industry: 'generic',
      businessId: 'b1',
      plan: 'growth',
    }),
    (e) => {
      assert.ok(e instanceof ComplianceBlocked, 'expected ComplianceBlocked');
      assert.equal(e.severity, 'hard');
      assert.ok(e.violations.length > 0, 'expected violations');
      return true;
    }
  );
});

test('evaluateOnly returns verdict without throwing on hard violations', async () => {
  _resetForTest();
  const v = await evaluateOnly({
    content: 'I guarantee 5x ROI.',
    industry: 'generic',
    businessId: 'b1',
    plan: 'growth',
  });
  assert.equal(v.severity, 'hard');
  // No throw — caller decides what to do.
});
