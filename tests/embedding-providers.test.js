'use strict';

const test = require('node:test');
const assert = require('node:assert');

const providers = require('../lib/embeddingProviders');
const openai = require('../lib/embeddingProviders/openai');
const stub = require('../lib/embeddingProviders/stub');

// ─── Stub provider ──────────────────────────────────────────────────────────

test('stub: embed returns 384-dim L2-normalized Float32Array', async () => {
  const e = await stub.embed({ text: 'cafe morning routine' });
  assert.ok(e instanceof Float32Array);
  assert.strictEqual(e.length, 384);
  let norm = 0;
  for (let i = 0; i < e.length; i++) norm += e[i] * e[i];
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-6, 'must be L2-normalized');
});

test('stub: deterministic — same input produces same output', async () => {
  const a = await stub.embed({ text: 'test text' });
  const b = await stub.embed({ text: 'test text' });
  for (let i = 0; i < a.length; i++) assert.strictEqual(a[i], b[i]);
});

test('stub: different text produces different embeddings', async () => {
  const a = await stub.embed({ text: 'completely first' });
  const b = await stub.embed({ text: 'absolutely second different' });
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  assert.ok(same < a.length);
});

test('stub: returns null on empty/null input', async () => {
  assert.strictEqual(await stub.embed({ text: '' }), null);
  assert.strictEqual(await stub.embed({ text: null }), null);
  assert.strictEqual(await stub.embed({}), null);
});

test('stub: respects custom dim', async () => {
  const e = await stub.embed({ text: 'x', dim: 768 });
  assert.strictEqual(e.length, 768);
});

test('stub: embedBatch returns array of embeddings', async () => {
  const out = await stub.embedBatch({ texts: ['a', 'b', 'c'] });
  assert.strictEqual(out.length, 3);
  for (const e of out) assert.ok(e instanceof Float32Array);
});

test('stub: isConfigured returns true (always)', () => {
  assert.strictEqual(stub.isConfigured(), true);
});

// ─── OpenAI provider ────────────────────────────────────────────────────────

test('openai: returns null when no API key', async () => {
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const e = await openai.embed({ text: 'x' });
  assert.strictEqual(e, null);
  if (prev) process.env.OPENAI_API_KEY = prev;
});

test('openai: returns null on empty text', async () => {
  const e = await openai.embed({ text: '', apiKey: 'fake' });
  assert.strictEqual(e, null);
});

test('openai: makes correct request shape', async () => {
  let capturedBody;
  let capturedKey;
  const mockHttp = async (url, body, apiKey) => {
    capturedBody = body;
    capturedKey = apiKey;
    return {
      ok: true,
      status: 200,
      json: { data: [{ embedding: new Array(384).fill(0.01) }] },
    };
  };
  const e = await openai.embed({
    text: 'morning coffee',
    apiKey: 'sk-fake',
    _httpPostJSONOverride: mockHttp,
  });
  assert.ok(e instanceof Float32Array);
  assert.strictEqual(e.length, 384);
  assert.strictEqual(capturedBody.model, 'text-embedding-3-small');
  assert.strictEqual(capturedBody.dimensions, 384);
  assert.strictEqual(capturedKey, 'sk-fake');
});

test('openai: returns null on HTTP failure', async () => {
  const mockHttp = async () => ({ ok: false, status: 429, raw: 'rate limit' });
  const e = await openai.embed({
    text: 'x',
    apiKey: 'fake',
    _httpPostJSONOverride: mockHttp,
  });
  assert.strictEqual(e, null);
});

test('openai: returns null on malformed response', async () => {
  const mockHttp = async () => ({ ok: true, status: 200, json: { error: 'malformed' } });
  const e = await openai.embed({
    text: 'x',
    apiKey: 'fake',
    _httpPostJSONOverride: mockHttp,
  });
  assert.strictEqual(e, null);
});

test('openai: embedBatch sends multiple texts in one request', async () => {
  let capturedBody;
  const mockHttp = async (url, body) => {
    capturedBody = body;
    return {
      ok: true,
      status: 200,
      json: {
        data: [
          { index: 0, embedding: new Array(384).fill(0.1) },
          { index: 1, embedding: new Array(384).fill(0.2) },
        ],
      },
    };
  };
  const out = await openai.embedBatch({
    texts: ['first', 'second'],
    apiKey: 'fake',
    _httpPostJSONOverride: mockHttp,
  });
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(capturedBody.input, ['first', 'second']);
});

test('openai: isConfigured returns true iff OPENAI_API_KEY is set', () => {
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test';
  assert.strictEqual(openai.isConfigured(), true);
  delete process.env.OPENAI_API_KEY;
  assert.strictEqual(openai.isConfigured(), false);
  if (prev) process.env.OPENAI_API_KEY = prev;
});

// ─── Provider registry / pick() ─────────────────────────────────────────────

test('providers: pick selects OpenAI when API key set', () => {
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test';
  providers._resetCache();
  assert.strictEqual(providers.pick().name, 'openai');
  if (prev) {
    process.env.OPENAI_API_KEY = prev;
  } else {
    delete process.env.OPENAI_API_KEY;
  }
  providers._resetCache();
});

test('providers: pick falls back to stub when no provider configured', () => {
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  providers._resetCache();
  assert.strictEqual(providers.pick().name, 'stub');
  if (prev) process.env.OPENAI_API_KEY = prev;
  providers._resetCache();
});

test('providers: pick result is cached (no re-evaluation per call)', () => {
  providers._resetCache();
  delete process.env.OPENAI_API_KEY;
  const p1 = providers.pick();
  process.env.OPENAI_API_KEY = 'sk-test';
  const p2 = providers.pick();
  assert.strictEqual(p1.name, p2.name, 'cache should pin first selection until _resetCache()');
  delete process.env.OPENAI_API_KEY;
  providers._resetCache();
});

test('providers: convenience embed() delegates to active provider', async () => {
  providers._resetCache();
  delete process.env.OPENAI_API_KEY;
  const e = await providers.embed('test');
  assert.ok(e instanceof Float32Array);
  assert.strictEqual(e.length, 384);
});

test('providers: getActiveProviderName reflects pick', () => {
  providers._resetCache();
  delete process.env.OPENAI_API_KEY;
  assert.strictEqual(providers.getActiveProviderName(), 'stub');
  providers._resetCache();
});
