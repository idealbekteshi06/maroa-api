'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const createWf11 = require('../services/wf11');

function mockSb() {
  const store = {
    inbox_threads: [{ id: 't1', business_id: 'b1', channel: 'email', body: 'I need a refund', classification: 'complaint', status: 'new' }],
    inbox_routing_settings: [],
    inbox_escalations: [],
    events: [],
  };
  return {
    sbGet: async (table, query) => {
      if (table === 'inbox_threads' && query.includes('t1')) return store.inbox_threads;
      if (table === 'inbox_routing_settings') return store.inbox_routing_settings;
      if (table === 'inbox_threads' && query.includes('sla_deadline')) return [];
      return [];
    },
    sbPatch: async (table, q, patch) => {
      if (table === 'inbox_threads') {
        Object.assign(store.inbox_threads[0], patch);
      }
    },
    sbPost: async (table, row) => {
      if (table === 'inbox_escalations') store.inbox_escalations.push(row);
      if (table === 'events') store.events.push(row);
      return row;
    },
    logger: null,
    sendEmail: null,
  };
}

describe('WF11 Smart Routing', () => {
  it('maps complaint to support specialist by default', async () => {
    const deps = mockSb();
    const wf11 = createWf11(deps);
    const out = await wf11.applyRouting({
      businessId: 'b1',
      threadId: 't1',
      triage: { classification: 'complaint', urgency: 'high' },
    });
    assert.equal(out.specialist, 'support');
    assert.ok(Array.isArray(out.escalationReasons));
  });

  it('exports seven specialist roles', () => {
    const wf11 = createWf11(mockSb());
    assert.equal(wf11.SPECIALISTS.length, 7);
  });
});
