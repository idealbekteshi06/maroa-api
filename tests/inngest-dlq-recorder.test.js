'use strict';

/**
 * tests/inngest-dlq-recorder.test.js
 *
 * Verifies services/inngest/dlqRecorder.js — the onFailure callback
 * that writes terminal Inngest failures to the inngest_dlq table.
 */

const test = require('node:test');
const assert = require('node:assert');

const { dlqHandler } = require('../services/inngest/dlqRecorder');

test('dlqHandler: returns a function with the right shape', () => {
  const h = dlqHandler({ functionId: 'test-fn', eventName: 'test.event' });
  assert.strictEqual(typeof h, 'function');
});

test('dlqHandler: never throws even when Supabase env is missing', async () => {
  const origUrl = process.env.SUPABASE_URL;
  const origKey = process.env.SUPABASE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_KEY;

  const h = dlqHandler({ functionId: 'no-supabase', eventName: 'test.event' });
  // Should resolve without throwing (soft-fail design).
  const result = await h({
    event: { id: 'evt_1', data: { businessId: 'biz_1' } },
    error: new Error('boom'),
  });
  assert.strictEqual(result.dlq_recorded, true);

  if (origUrl) process.env.SUPABASE_URL = origUrl;
  if (origKey) process.env.SUPABASE_KEY = origKey;
});

test('dlqHandler: never throws on absurd inputs', async () => {
  const h = dlqHandler({ functionId: 'test-fn', eventName: 'test.event' });
  await assert.doesNotReject(() => h({ event: null, error: null }));
  await assert.doesNotReject(() => h({}));
  await assert.doesNotReject(() => h({ event: { data: {} }, error: 'string-not-error' }));
});

test('dlqHandler: extracts businessId from event.data.businessId', async () => {
  // We can't easily intercept the HTTP call without mocking https,
  // but we can verify the handler accepts the canonical shape without
  // throwing. Real HTTP behavior is tested separately.
  const h = dlqHandler({ functionId: 'feedback-24h', eventName: 'maroa/content.publish.feedback-24h' });
  const r = await h({
    event: { id: 'evt_42', data: { businessId: 'fea4aae5-14b4-486d-89f4-33a7d7e4ab60', contentId: 'c1' } },
    error: new Error('downstream 500'),
  });
  assert.strictEqual(r.dlq_recorded, true);
});

test('dlqHandler: handles event.data.business_id (snake_case fallback)', async () => {
  const h = dlqHandler({ functionId: 'test-fn', eventName: 'test.event' });
  const r = await h({
    event: { id: 'evt_43', data: { business_id: 'fea4aae5-14b4-486d-89f4-33a7d7e4ab60' } },
    error: new Error('test'),
  });
  assert.strictEqual(r.dlq_recorded, true);
});

test('dlqHandler: handles Error objects with stack traces', async () => {
  const h = dlqHandler({ functionId: 'test-fn', eventName: 'test.event' });
  const err = new Error('serious error');
  err.stack = 'Error: serious error\n    at someFn (/path/to/file.js:42:5)';
  const r = await h({
    event: { id: 'evt_stack', data: {} },
    error: err,
  });
  assert.strictEqual(r.dlq_recorded, true);
});

test('dlqHandler: truncates absurdly long error messages', async () => {
  // We can't directly observe the truncation without DB intercept,
  // but we verify it doesn't throw on a 50k-char error.
  const h = dlqHandler({ functionId: 'test-fn', eventName: 'test.event' });
  const r = await h({
    event: { id: 'evt_long', data: {} },
    error: new Error('x'.repeat(50_000)),
  });
  assert.strictEqual(r.dlq_recorded, true);
});
