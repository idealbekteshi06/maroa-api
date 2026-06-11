'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  decidePlanLimit,
  normalizePlan,
  isValidAction,
  limitKeyForAction,
  PLAN_LIMITS,
  VALID_ACTIONS,
} = require('../middleware/planLimits');

test('normalizePlan: free→starter, unknown→starter, known passthrough', () => {
  assert.equal(normalizePlan('free'), 'starter');
  assert.equal(normalizePlan('FREE'), 'starter');
  assert.equal(normalizePlan(undefined), 'starter');
  assert.equal(normalizePlan('bogus'), 'starter');
  assert.equal(normalizePlan('growth'), 'growth');
  assert.equal(normalizePlan('Agency'), 'agency');
});

test('isValidAction: only whitelisted actions pass (enum-injection guard)', () => {
  assert.equal(isValidAction('generate_image'), true);
  assert.equal(isValidAction('process_product'), true);
  // Crafted action attempting query-shape injection must be rejected.
  assert.equal(isValidAction('generate_image&order=created_at'), false);
  assert.equal(isValidAction('drop_table'), false);
  assert.equal(isValidAction(''), false);
  assert.equal(isValidAction(undefined), false);
});

test('limitKeyForAction maps every valid action (and null for unknown)', () => {
  assert.equal(limitKeyForAction('generate_image'), 'images');
  assert.equal(limitKeyForAction('generate_video_kling'), 'kling');
  assert.equal(limitKeyForAction('generate_video_sora'), 'sora');
  assert.equal(limitKeyForAction('score_content'), 'scores');
  assert.equal(limitKeyForAction('generate_caption'), 'captions');
  assert.equal(limitKeyForAction('process_product'), 'process_product');
  assert.equal(limitKeyForAction('nope'), null);
});

test('decidePlanLimit: under limit → allowed', () => {
  const d = decidePlanLimit({ plan: 'starter', action: 'generate_image', count: 5 });
  assert.equal(d.allowed, true);
  assert.equal(d.plan, 'starter');
  assert.equal(d.limit, PLAN_LIMITS.starter.images);
});

test('decidePlanLimit: at limit → denied (limit_reached, >= boundary)', () => {
  const cap = PLAN_LIMITS.starter.images; // 20
  const d = decidePlanLimit({ plan: 'starter', action: 'generate_image', count: cap });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'limit_reached');
  assert.equal(d.limit, cap);
  assert.equal(d.current, cap);
});

test('decidePlanLimit: one below limit → allowed (off-by-one boundary)', () => {
  const cap = PLAN_LIMITS.growth.images; // 60
  const d = decidePlanLimit({ plan: 'growth', action: 'generate_image', count: cap - 1 });
  assert.equal(d.allowed, true);
});

test('decidePlanLimit: video blocked on starter (no video capability)', () => {
  for (const action of ['generate_video', 'generate_video_kling', 'generate_video_sora']) {
    const d = decidePlanLimit({ plan: 'starter', action, count: 0 });
    assert.equal(d.allowed, false, `${action} should be blocked on starter`);
    assert.equal(d.reason, 'upgrade_required');
  }
});

test('decidePlanLimit: sora blocked on growth (growth has video but sora cap 0)', () => {
  // growth has video:true but sora:0 → kling allowed, sora hits limit_reached at 0.
  const kling = decidePlanLimit({ plan: 'growth', action: 'generate_video_kling', count: 0 });
  assert.equal(kling.allowed, true);
  const sora = decidePlanLimit({ plan: 'growth', action: 'generate_video_sora', count: 0 });
  assert.equal(sora.allowed, false);
  assert.equal(sora.reason, 'limit_reached');
  assert.equal(sora.limit, 0);
});

test('decidePlanLimit: agency allows sora under its cap', () => {
  const d = decidePlanLimit({ plan: 'agency', action: 'generate_video_sora', count: 1 });
  assert.equal(d.allowed, true);
  assert.equal(d.limit, PLAN_LIMITS.agency.sora);
});

test('decidePlanLimit: unknown plan normalized to starter caps', () => {
  const d = decidePlanLimit({ plan: 'enterprise-legacy', action: 'generate_image', count: PLAN_LIMITS.starter.images });
  assert.equal(d.plan, 'starter');
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'limit_reached');
});

test('VALID_ACTIONS is the exact whitelist used by the gate', () => {
  assert.ok(VALID_ACTIONS instanceof Set);
  assert.ok(VALID_ACTIONS.has('generate_image'));
  assert.ok(VALID_ACTIONS.has('generate_video')); // accepted, then remapped to _kling
  assert.ok(!VALID_ACTIONS.has('generate_image&order=created_at')); // injection rejected
});
