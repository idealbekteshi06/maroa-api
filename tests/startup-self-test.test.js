'use strict';

/**
 * tests/startup-self-test.test.js
 *
 * Verifies lib/startupSelfTest.js — the boot-time probe suite that
 * pings Supabase + Anthropic + verifies the encryption key + required
 * env vars. Result is cached for 5 min so /readyz can surface it
 * without re-probing on every check.
 */

const test = require('node:test');
const assert = require('node:assert');

const sst = require('../lib/startupSelfTest');

test('runStartupSelfTest: returns the four expected probes', async () => {
  const sbGet = async () => [{ id: '00000000-0000-4000-8000-000000000001' }];
  // Original fetch — stub Anthropic call
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200 });

  try {
    const result = await sst.runStartupSelfTest({ sbGet, logger: { info: () => {}, warn: () => {} } });
    assert.ok(result.timestamp);
    assert.ok(result.duration_ms >= 0);
    assert.ok(typeof result.passed === 'number');
    assert.ok(typeof result.total === 'number');
    assert.strictEqual(result.total, 4);
    for (const probe of ['env', 'encryption_key', 'supabase', 'anthropic']) {
      assert.ok(probe in result.results, `missing probe: ${probe}`);
      assert.ok('ok' in result.results[probe]);
    }
  } finally {
    global.fetch = origFetch;
  }
});

test('runStartupSelfTest: marks supabase probe as failed when sbGet rejects', async () => {
  const sbGet = async () => {
    throw new Error('connection refused');
  };
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200 });

  try {
    const result = await sst.runStartupSelfTest({ sbGet, logger: { info: () => {}, warn: () => {} } });
    assert.strictEqual(result.results.supabase.ok, false);
    assert.match(result.results.supabase.error, /connection refused/);
  } finally {
    global.fetch = origFetch;
  }
});

test('runStartupSelfTest: marks anthropic probe failed on non-2xx fetch', async () => {
  const sbGet = async () => [];
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401 });
  // Force Anthropic env so probe actually runs
  const origKey = process.env.ANTHROPIC_KEY;
  process.env.ANTHROPIC_KEY = 'sk-ant-stub-for-tests';

  try {
    const result = await sst.runStartupSelfTest({ sbGet, logger: { info: () => {}, warn: () => {} } });
    assert.strictEqual(result.results.anthropic.ok, false);
    assert.strictEqual(result.results.anthropic.status, 401);
  } finally {
    global.fetch = origFetch;
    if (origKey) process.env.ANTHROPIC_KEY = origKey;
    else delete process.env.ANTHROPIC_KEY;
  }
});

test('runStartupSelfTest: anthropic probe times out under 4s budget', async () => {
  const sbGet = async () => [];
  const origFetch = global.fetch;
  // Fake fetch that hangs longer than the 4s probe timeout
  global.fetch = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200 }), 8000));
  const origKey = process.env.ANTHROPIC_KEY;
  process.env.ANTHROPIC_KEY = 'sk-ant-stub';

  try {
    const result = await sst.runStartupSelfTest({ sbGet, logger: { info: () => {}, warn: () => {} } });
    assert.strictEqual(result.results.anthropic.ok, false);
    assert.match(result.results.anthropic.error, /timeout/i);
  } finally {
    global.fetch = origFetch;
    if (origKey) process.env.ANTHROPIC_KEY = origKey;
    else delete process.env.ANTHROPIC_KEY;
  }
});

test('runStartupSelfTest: encryption_key probe rejects wrong-length key', async () => {
  const sbGet = async () => [];
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200 });
  const origKey = process.env.OAUTH_TOKEN_ENC_KEY;
  process.env.OAUTH_TOKEN_ENC_KEY = 'too-short';

  try {
    const result = await sst.runStartupSelfTest({ sbGet, logger: { info: () => {}, warn: () => {} } });
    assert.strictEqual(result.results.encryption_key.ok, false);
    assert.match(result.results.encryption_key.error, /length/);
  } finally {
    global.fetch = origFetch;
    if (origKey) process.env.OAUTH_TOKEN_ENC_KEY = origKey;
    else delete process.env.OAUTH_TOKEN_ENC_KEY;
  }
});

test('runStartupSelfTest: encryption_key probe rejects non-hex 64-char string', async () => {
  const sbGet = async () => [];
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200 });
  const origKey = process.env.OAUTH_TOKEN_ENC_KEY;
  process.env.OAUTH_TOKEN_ENC_KEY = 'Z'.repeat(64); // 64 chars but Z is not hex

  try {
    const result = await sst.runStartupSelfTest({ sbGet, logger: { info: () => {}, warn: () => {} } });
    assert.strictEqual(result.results.encryption_key.ok, false);
    assert.match(result.results.encryption_key.error, /hex/);
  } finally {
    global.fetch = origFetch;
    if (origKey) process.env.OAUTH_TOKEN_ENC_KEY = origKey;
    else delete process.env.OAUTH_TOKEN_ENC_KEY;
  }
});

test('runStartupSelfTest: env probe lists missing required vars', async () => {
  const sbGet = async () => [];
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200 });

  // Save + clear
  const origUrl = process.env.SUPABASE_URL;
  const origKey = process.env.SUPABASE_KEY;
  const origWebhook = process.env.N8N_WEBHOOK_SECRET;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_KEY;
  delete process.env.N8N_WEBHOOK_SECRET;

  try {
    const result = await sst.runStartupSelfTest({ sbGet, logger: { info: () => {}, warn: () => {} } });
    assert.strictEqual(result.results.env.ok, false);
    assert.ok(Array.isArray(result.results.env.missing));
    assert.ok(result.results.env.missing.includes('SUPABASE_URL'));
    assert.ok(result.results.env.missing.includes('SUPABASE_KEY'));
    assert.ok(result.results.env.missing.includes('N8N_WEBHOOK_SECRET'));
  } finally {
    global.fetch = origFetch;
    if (origUrl) process.env.SUPABASE_URL = origUrl;
    if (origKey) process.env.SUPABASE_KEY = origKey;
    if (origWebhook) process.env.N8N_WEBHOOK_SECRET = origWebhook;
  }
});

test('getCached: returns null until runStartupSelfTest has run', () => {
  // Bust cache to ensure fresh module state
  delete require.cache[require.resolve('../lib/startupSelfTest')];
  const fresh = require('../lib/startupSelfTest');
  assert.strictEqual(fresh.getCached(), null);
});

test('getCached: returns most recent result after run', async () => {
  delete require.cache[require.resolve('../lib/startupSelfTest')];
  const fresh = require('../lib/startupSelfTest');
  const sbGet = async () => [];
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200 });

  try {
    const r1 = await fresh.runStartupSelfTest({ sbGet, logger: { info: () => {}, warn: () => {} } });
    const cached = fresh.getCached();
    assert.ok(cached);
    assert.strictEqual(cached.timestamp, r1.timestamp);
  } finally {
    global.fetch = origFetch;
  }
});
