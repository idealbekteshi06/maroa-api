'use strict';

// Basic behavioural smoke test for WF4 (reviews & reputation).
// WF4 had ZERO behavioural coverage and its "publish" is inert (advisory-only),
// so we cover the read path + the Claude classification round-trip before wiring.

const test = require('node:test');
const assert = require('node:assert/strict');

const createWf4 = require('../services/wf4');

function makeWf4(overrides = {}) {
  return createWf4({
    sbGet: async () => [],
    sbPost: async () => ({ id: 'x1' }),
    sbPatch: async () => true,
    callClaude: async () => '{}',
    extractJSON: () => ({}),
    logger: { warn() {}, error() {} },
    sendEmail: async () => ({ sent: true }),
    sendWhatsApp: async () => ({ sent: true }),
    ...overrides,
  });
}

test('wf4: factory exposes the reviews surface', () => {
  const wf4 = makeWf4();
  for (const fn of ['classifyReview', 'generateResponse', 'publishResponse', 'listReviews', 'getReputationSnapshot']) {
    assert.equal(typeof wf4[fn], 'function', `wf4.${fn} missing`);
  }
});

test('wf4: listReviews returns empty items when DB is empty', async () => {
  const r = await makeWf4().listReviews({ businessId: 'b1' });
  assert.ok(Array.isArray(r.items));
  assert.equal(r.items.length, 0);
});

test('wf4: classifyReview patches the review with the Claude classification', async () => {
  const patched = [];
  const wf4 = makeWf4({
    sbGet: async (table) => {
      if (table === 'reviews') return [{ id: 'rev1', business_id: 'b1', body: 'Great service' }];
      if (table === 'businesses') return [{ id: 'b1', business_name: 'Acme' }];
      return [];
    },
    sbPatch: async (table, _filter, row) => (patched.push({ table, row }), true),
    callClaude: async () => '{"category":"praise","urgency":"low","sentiment":1}',
    extractJSON: (raw) => JSON.parse(raw),
  });
  const parsed = await wf4.classifyReview({ businessId: 'b1', reviewId: 'rev1' });
  assert.equal(parsed.category, 'praise');
  const patchRow = patched.find((p) => p.table === 'reviews')?.row;
  assert.equal(patchRow.category, 'praise');
});
