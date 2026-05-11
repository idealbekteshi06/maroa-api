'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const stripe = require('../services/stripe');

const SECRET = 'whsec_test_secret_dont_leak';

function makeStripeSignature(rawBody, secret, ts = Math.floor(Date.now() / 1000)) {
  const signed = `${ts}.${rawBody}`;
  const sig = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return { header: `t=${ts},v1=${sig}`, timestamp: ts };
}

// ─── Signature verification ──────────────────────────────────────────────

test('stripe: verifies a valid signature', () => {
  const body = '{"id":"evt_1","type":"checkout.session.completed"}';
  const { header } = makeStripeSignature(body, SECRET);
  assert.strictEqual(stripe.verifyStripeSignature(body, header, SECRET), true);
});

test('stripe: rejects signature signed with wrong secret', () => {
  const body = '{"id":"evt_1"}';
  const { header } = makeStripeSignature(body, 'other-secret');
  assert.strictEqual(stripe.verifyStripeSignature(body, header, SECRET), false);
});

test('stripe: rejects tampered body', () => {
  const body = '{"id":"evt_1"}';
  const { header } = makeStripeSignature(body, SECRET);
  const tamperedBody = '{"id":"evt_TAMPERED"}';
  assert.strictEqual(stripe.verifyStripeSignature(tamperedBody, header, SECRET), false);
});

test('stripe: rejects expired timestamps (>5 min old)', () => {
  const body = '{"id":"evt_1"}';
  const ancientTs = Math.floor(Date.now() / 1000) - 600; // 10 min ago
  const { header } = makeStripeSignature(body, SECRET, ancientTs);
  assert.strictEqual(stripe.verifyStripeSignature(body, header, SECRET), false);
});

test('stripe: rejects malformed signature header', () => {
  assert.strictEqual(stripe.verifyStripeSignature('{}', 'not-a-real-sig', SECRET), false);
  assert.strictEqual(stripe.verifyStripeSignature('{}', '', SECRET), false);
  assert.strictEqual(stripe.verifyStripeSignature('{}', null, SECRET), false);
});

test('stripe: accepts buffer or string raw body', () => {
  const body = '{"x":1}';
  const { header } = makeStripeSignature(body, SECRET);
  assert.strictEqual(stripe.verifyStripeSignature(body, header, SECRET), true);
  assert.strictEqual(stripe.verifyStripeSignature(Buffer.from(body), header, SECRET), true);
});

// ─── Event handler: checkout.session.completed ───────────────────────────

test('stripe: checkout.session.completed updates plan + triggers cold-start on first paid activation', async () => {
  const calls = { sbGetCalls: [], sbPatchCalls: [], sbPostCalls: [], fetchCalls: [] };
  const sbGet = async (table, q) => {
    calls.sbGetCalls.push({ table, q });
    if (table === 'businesses') return [{ plan: 'free' }];
    return [];
  };
  const sbPatch = async (table, filter, body) => {
    calls.sbPatchCalls.push({ table, filter, body });
  };
  const sbPost = async (table, row) => {
    calls.sbPostCalls.push({ table, row });
  };

  // Stub global fetch to capture cold-start trigger
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.fetchCalls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({}) };
  };

  try {
    const result = await stripe.handleStripeEvent({
      event: {
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_123',
            customer: 'cus_abc',
            subscription: 'sub_xyz',
            metadata: { business_id: 'biz-new-1', plan: 'growth' },
          },
        },
      },
      sbGet,
      sbPatch,
      sbPost,
      sendEmail: async () => ({ ok: true }),
      logger: { warn: () => {}, error: () => {}, info: () => {} },
      internalSecret: 'webhook-secret',
      port: 3000,
    });

    assert.strictEqual(result.ok, true);
    assert.ok(calls.sbPatchCalls.length >= 1, 'plan should be patched');
    assert.strictEqual(calls.sbPatchCalls[0].body.plan, 'growth');
    assert.strictEqual(calls.sbPatchCalls[0].body.stripe_customer_id, 'cus_abc');
    // Cold-start trigger should fire (free → growth = first paid)
    assert.strictEqual(calls.fetchCalls.length, 1, 'cold-start trigger should fire');
    assert.ok(/cold-start-trigger/.test(calls.fetchCalls[0].url));
    assert.strictEqual(JSON.parse(calls.fetchCalls[0].opts.body).businessId, 'biz-new-1');
  } finally {
    global.fetch = origFetch;
  }
});

test('stripe: checkout.session.completed on existing paid customer does NOT re-trigger cold-start', async () => {
  const fetchCalls = [];
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    fetchCalls.push(url);
    return { ok: true, json: async () => ({}) };
  };

  try {
    await stripe.handleStripeEvent({
      event: {
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test',
            customer: 'cus',
            metadata: { business_id: 'biz-existing', plan: 'agency' },
          },
        },
      },
      sbGet: async () => [{ plan: 'growth' }], // already on a paid plan
      sbPatch: async () => {},
      sbPost: async () => {},
      logger: { warn: () => {}, error: () => {}, info: () => {} },
    });
    assert.strictEqual(fetchCalls.length, 0, 'Should NOT trigger cold-start on growth → agency upgrade');
  } finally {
    global.fetch = origFetch;
  }
});

// ─── Event handler: subscription.deleted ─────────────────────────────────

test('stripe: customer.subscription.deleted downgrades plan to free', async () => {
  const patches = [];
  await stripe.handleStripeEvent({
    event: {
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_x', metadata: { business_id: 'biz-cancel' } } },
    },
    sbGet: async () => [],
    sbPatch: async (table, filter, body) => {
      patches.push({ table, filter, body });
    },
    sbPost: async () => {},
    logger: { warn: () => {}, error: () => {} },
  });
  assert.strictEqual(patches.length, 1);
  assert.strictEqual(patches[0].body.plan, 'free');
});

// ─── Event handler: payment_failed grace period ──────────────────────────

test('stripe: invoice.payment_failed waits for 4 attempts before downgrading', async () => {
  const patches = [];

  // 1st attempt — no downgrade
  await stripe.handleStripeEvent({
    event: {
      type: 'invoice.payment_failed',
      data: {
        object: {
          attempt_count: 1,
          subscription_details: { metadata: { business_id: 'biz-fail' } },
        },
      },
    },
    sbGet: async () => [],
    sbPatch: async (table, filter, body) => {
      patches.push({ table, body });
    },
    sbPost: async () => {},
    logger: { warn: () => {}, error: () => {} },
  });
  assert.strictEqual(patches.length, 0, 'attempt 1 should NOT downgrade');

  // 4th attempt — downgrade
  await stripe.handleStripeEvent({
    event: {
      type: 'invoice.payment_failed',
      data: {
        object: {
          attempt_count: 4,
          subscription_details: { metadata: { business_id: 'biz-fail' } },
        },
      },
    },
    sbGet: async () => [],
    sbPatch: async (table, filter, body) => {
      patches.push({ table, body });
    },
    sbPost: async () => {},
    logger: { warn: () => {}, error: () => {} },
  });
  assert.strictEqual(patches.length, 1, 'attempt 4 should downgrade');
  assert.strictEqual(patches[0].body.plan, 'free');
});

// ─── Defensive: malformed event ──────────────────────────────────────────

test('stripe: malformed event returns ok:false instead of crashing', async () => {
  const r = await stripe.handleStripeEvent({
    event: null,
    sbGet: async () => [],
    sbPatch: async () => {},
    sbPost: async () => {},
    logger: { warn: () => {}, error: () => {} },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'malformed_event');
});
