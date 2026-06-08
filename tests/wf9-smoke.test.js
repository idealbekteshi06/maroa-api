'use strict';

// Basic behavioural smoke test for WF9 (unified inbox). WF9 had ZERO behavioural
// coverage; this covers the read path the UI binds to plus one triage round-trip
// before any screen is wired. The send-path is intentionally not exercised — it
// does not exist (draft-reply is advisory/copy-only).

const test = require('node:test');
const assert = require('node:assert/strict');

const createWf9 = require('../services/wf9');

function makeWf9(overrides = {}) {
  return createWf9({
    sbGet: async () => [],
    sbPost: async () => ({ id: 'x1' }),
    sbPatch: async () => true,
    callClaude: async () => '{}',
    extractJSON: () => ({}),
    logger: { warn() {} },
    ...overrides,
  });
}

test('wf9: factory exposes intake/triage/draft/list', () => {
  const wf9 = makeWf9();
  for (const fn of ['intakeThread', 'triageThread', 'draftReply', 'listThreads']) {
    assert.equal(typeof wf9[fn], 'function', `wf9.${fn} missing`);
  }
});

test('wf9: listThreads returns the threads list shape', async () => {
  const wf9 = makeWf9({ sbGet: async () => [{ id: 't1', channel: 'email', status: 'new' }] });
  const r = await wf9.listThreads({ businessId: 'b1' });
  assert.ok(Array.isArray(r.items));
  assert.equal(r.items[0].id, 't1');
});

test('wf9: triageThread classifies + routes a thread via Claude', async () => {
  const patched = [];
  const wf9 = makeWf9({
    sbGet: async (table) => {
      if (table === 'inbox_threads') return [{ id: 't1', business_id: 'b1', channel: 'email', body: 'Help!' }];
      if (table === 'businesses') return [{ id: 'b1', business_name: 'Acme' }];
      return [];
    },
    sbPatch: async (table, _filter, row) => (patched.push({ table, row }), true),
    callClaude: async () =>
      '{"classification":"support","urgency":"high","sentiment":"negative","route_to":"support","ai_can_draft":false}',
    extractJSON: (raw) => JSON.parse(raw),
  });
  const r = await wf9.triageThread({ businessId: 'b1', threadId: 't1' });
  assert.ok(r);
  const patchRow = patched.find((p) => p.table === 'inbox_threads')?.row;
  assert.equal(patchRow.classification, 'support');
  assert.equal(patchRow.status, 'routed');
});
