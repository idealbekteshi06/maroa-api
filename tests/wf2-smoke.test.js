'use strict';

// Basic behavioural smoke test for WF2 (lead scoring & routing).
// WF2 had ZERO behavioural coverage; this exercises the read paths the UI binds
// to plus one real scoring round-trip, before any screen is wired to it.

const test = require('node:test');
const assert = require('node:assert/strict');

const createWf2 = require('../services/wf2');

function makeWf2(overrides = {}) {
  return createWf2({
    sbGet: async () => [],
    sbPost: async () => ({ id: 'x1' }),
    sbPatch: async () => true,
    callClaude: async () => '{}',
    extractJSON: () => ({}),
    logger: { warn() {}, error() {} },
    sendEmail: async () => ({ sent: true, id: 'e1' }),
    ...overrides,
  });
}

test('wf2: factory exposes the lead-scoring surface', () => {
  const wf2 = makeWf2();
  for (const fn of ['rescoreLead', 'listLeads', 'getLead', 'getCalibration', 'getIcp', 'buildEnrichmentPayload']) {
    assert.equal(typeof wf2[fn], 'function', `wf2.${fn} missing`);
  }
});

test('wf2: listLeads returns empty items + tier counts when DB is empty', async () => {
  const r = await makeWf2().listLeads({ businessId: 'b1' });
  assert.deepEqual(r.items, []);
  assert.equal(r.nextCursor, null);
  assert.equal(typeof r.counts, 'object');
});

test('wf2: getIcp returns normalized defaults when no row exists', async () => {
  const icp = await makeWf2().getIcp('b1');
  assert.deepEqual(icp.idealTitles, []);
  assert.deepEqual(icp.idealIndustries, []);
});

test('wf2: rescoreLead scores a contact and upserts lead_scores', async () => {
  const posted = [];
  const wf2 = makeWf2({
    sbGet: async (table) =>
      table === 'contacts' ? [{ id: 'lead1', email: 'cfo@acme.com', company_name: 'Acme' }] : [],
    sbPost: async (table, row) => (posted.push({ table, row }), { id: 'ls1' }),
  });
  const r = await wf2.rescoreLead({ businessId: 'b1', leadId: 'lead1' });
  assert.equal(typeof r.score, 'number');
  assert.ok(['hot', 'warm_high', 'warm', 'cool', 'junk'].includes(r.tier));
  assert.ok(
    posted.some((p) => p.table === 'lead_scores'),
    'expected a lead_scores write'
  );
});
