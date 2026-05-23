'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { probeInngestDlq, probeInngest, _resetProbeCache } = require('../lib/healthCheck');

test('probeInngestDlq queries failed_at column', async () => {
  _resetProbeCache();
  let filter = '';
  const sbGet = async (table, query) => {
    filter = query;
    return [{ id: 1 }];
  };
  const r = await probeInngestDlq(sbGet);
  assert.match(filter, /failed_at=gte\./);
  assert.equal(r.ok, true);
  assert.equal(r.dlq_count_24h, 1);
});

test('probeInngest reports function count from functions module', async () => {
  const prevEv = process.env.INNGEST_EVENT_KEY;
  const prevSig = process.env.INNGEST_SIGNING_KEY;
  process.env.INNGEST_EVENT_KEY = 'test-event-key-123456789';
  process.env.INNGEST_SIGNING_KEY = 'test-signing-key-123456789';
  try {
    const r = await probeInngest({});
    assert.equal(r.ok, true);
    assert.ok(typeof r.functions === 'number' && r.functions > 0);
  } finally {
    if (prevEv === undefined) delete process.env.INNGEST_EVENT_KEY;
    else process.env.INNGEST_EVENT_KEY = prevEv;
    if (prevSig === undefined) delete process.env.INNGEST_SIGNING_KEY;
    else process.env.INNGEST_SIGNING_KEY = prevSig;
  }
});
