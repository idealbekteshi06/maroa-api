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

// ─── Generation canary marker (lib/generationCanary) ───────────────────────
const canary = require('../lib/generationCanary');

test('generationCanary: no run yet → skipped, not a warning', () => {
  canary._reset();
  const c = canary.readCanary();
  assert.equal(c.ok, true);
  assert.equal(c.skipped, true);
});

test('generationCanary: fresh success → ok, not stale', () => {
  canary._reset();
  canary.recordCanary({ ok: true, model: 'haiku', latency_ms: 42 });
  const c = canary.readCanary();
  assert.equal(c.ok, true);
  assert.equal(c.stale, false);
  assert.equal(c.last_ok, true);
});

test('generationCanary: last run failed → ok:false with reason (soft warn)', () => {
  canary._reset();
  canary.recordCanary({ ok: false, model: 'haiku', reason: 'credit balance too low' });
  const c = canary.readCanary();
  assert.equal(c.ok, false);
  assert.equal(c.skipped, undefined);
  assert.match(c.reason, /credit/);
});

test('generationCanary: stale success → ok:false with canary_stale', () => {
  canary._reset();
  canary.recordCanary({ ok: true, model: 'haiku' });
  // Read as if 2h have passed (> 90min STALE_MS).
  const c = canary.readCanary({ now: Date.now() + 2 * 60 * 60 * 1000 });
  assert.equal(c.ok, false);
  assert.equal(c.stale, true);
  assert.equal(c.reason, 'canary_stale');
});

test('generationCanary: recordCanary never throws on bad input', () => {
  canary._reset();
  assert.doesNotThrow(() => canary.recordCanary(null));
  assert.doesNotThrow(() => canary.recordCanary(undefined));
});
