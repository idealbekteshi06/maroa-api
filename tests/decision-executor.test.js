'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _routeFor } = require('../lib/decisionExecutor');

test('routeFor: scale_budget → meta-campaign-optimize', () => {
  const r = _routeFor({
    id: 'd1',
    decision_type: 'scale_budget',
    business_id: 'b1',
  });
  assert.deepEqual(r, { path: '/webhook/meta-campaign-optimize', body: { business_id: 'b1' } });
});

test('routeFor: pause_campaign → meta-campaign-optimize', () => {
  const r = _routeFor({ id: 'd1', decision_type: 'pause_campaign', business_id: 'b2' });
  assert.equal(r.path, '/webhook/meta-campaign-optimize');
});

test('routeFor: refresh_creative → /webhook/creative-refresh', () => {
  const r = _routeFor({ id: 'd1', decision_type: 'refresh_creative', business_id: 'b3' });
  assert.equal(r.path, '/webhook/creative-refresh');
  assert.equal(r.body.decision_id, 'd1');
});

test('routeFor: generate_content → /webhook/instant-content', () => {
  const r = _routeFor({
    id: 'd1',
    decision_type: 'generate_content',
    business_id: 'b4',
    inputs: { theme: 'spring sale' },
  });
  assert.equal(r.path, '/webhook/instant-content');
  assert.equal(r.body.theme, 'spring sale');
});

test('routeFor: unknown type returns null', () => {
  const r = _routeFor({ id: 'd1', decision_type: 'wat', business_id: 'b1' });
  assert.equal(r, null);
});

test('routeFor: missing business_id returns null', () => {
  const r = _routeFor({ id: 'd1', decision_type: 'scale_budget' });
  assert.equal(r, null);
});
