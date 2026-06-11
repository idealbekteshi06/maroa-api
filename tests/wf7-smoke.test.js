'use strict';

// Basic behavioural smoke test for WF7 (deprecated email engine) — AND the
// regression test for the email_sequences double-writer fix: wf7.designSequence
// and wf7.dispatchDue must NO LONGER read or write the shared email_sequences
// table (now owned exclusively by services/email-lifecycle).

const test = require('node:test');
const assert = require('node:assert/strict');

const createWf7 = require('../services/wf7');

function makeWf7(overrides = {}) {
  return createWf7({
    sbGet: async () => [],
    sbPost: async () => ({ id: 'x1' }),
    sbPatch: async () => true,
    logger: { warn() {} },
    ...overrides,
  });
}

test('wf7: factory still exposes its surface', () => {
  const wf7 = makeWf7();
  for (const fn of ['createSegment', 'designSequence', 'enrollContact', 'dispatchDue']) {
    assert.equal(typeof wf7[fn], 'function', `wf7.${fn} missing`);
  }
});

test('wf7: createSegment writes only the wf7-owned email_segments table', async () => {
  const posts = [];
  const wf7 = makeWf7({ sbPost: async (table) => (posts.push(table), { id: 'seg1' }) });
  const r = await wf7.createSegment({ businessId: 'b1', name: 'VIPs' });
  assert.equal(r.segmentId, 'seg1');
  assert.deepEqual(posts, ['email_segments']);
});

test('wf7: designSequence is a deprecation stub and NEVER writes email_sequences', async () => {
  const posts = [];
  const wf7 = makeWf7({ sbPost: async (table) => (posts.push(table), { id: 'x' }) });
  const r = await wf7.designSequence({ businessId: 'b1', segmentId: 'seg1' });
  assert.equal(r.deprecated, true);
  assert.equal(r.use, 'services/email-lifecycle');
  assert.equal(posts.length, 0, 'designSequence must not write any table');
  assert.ok(!posts.includes('email_sequences'));
});

test('wf7: dispatchDue is a deprecation stub and NEVER touches email_sequences', async () => {
  const touched = [];
  const wf7 = makeWf7({
    sbGet: async (table) => (touched.push(table), []),
    sbPost: async (table) => (touched.push(table), { id: 'x' }),
    sbPatch: async (table) => (touched.push(table), true),
  });
  const r = await wf7.dispatchDue({ businessId: 'b1' });
  assert.equal(r.deprecated, true);
  assert.equal(r.dispatched, 0);
  assert.ok(!touched.includes('email_sequences'), 'dispatchDue must not touch email_sequences');
});
