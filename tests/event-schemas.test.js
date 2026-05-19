'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateEventPayload,
  validateApprovalPayload,
  validateDecisionLogContext,
  validateColdStartPhase,
} = require('../lib/eventSchemas');

const UUID = '11111111-1111-4111-8111-111111111111';

test('events: strict schema enforced for known kind', () => {
  const v = validateEventPayload({
    kind: 'wf4.response.published',
    review_id: UUID,
    draft_id: UUID,
  });
  assert.equal(v.kind, 'wf4.response.published');
  assert.equal(v.review_id, UUID);
});

test('events: rejects strict schema with missing required field', () => {
  assert.throws(() =>
    validateEventPayload({
      kind: 'wf4.response.published',
      review_id: UUID,
      // draft_id missing
    })
  );
});

test('events: rejects payload without kind', () => {
  assert.throws(() => validateEventPayload({ foo: 'bar' }));
});

test('events: passthrough on unknown kind, kind format enforced', () => {
  const v = validateEventPayload({ kind: 'new.event.kind', some_field: 1 });
  assert.equal(v.kind, 'new.event.kind');
  assert.throws(() => validateEventPayload({ kind: 'BAD KIND with spaces' }));
});

test('approvals: shape enforced', () => {
  const v = validateApprovalPayload({
    business_id: UUID,
    surface: 'social_post',
    target_id: UUID,
  });
  assert.equal(v.surface, 'social_post');
  assert.throws(() => validateApprovalPayload({ surface: 'x' })); // missing business_id+target_id
});

test('decision_logs: agent required', () => {
  const v = validateDecisionLogContext({
    agent: 'ad-optimizer',
    decision: 'scale',
  });
  assert.equal(v.agent, 'ad-optimizer');
  assert.throws(() => validateDecisionLogContext({ decision: 'scale' }));
});

test('cold-start phase: status enum enforced', () => {
  const v = validateColdStartPhase({ phase: 'compose-strategy', status: 'succeeded' });
  assert.equal(v.status, 'succeeded');
  assert.throws(() =>
    validateColdStartPhase({ phase: 'compose-strategy', status: 'not-a-real-status' })
  );
});
