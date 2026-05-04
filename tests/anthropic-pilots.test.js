'use strict';

/**
 * Real integration tests for the Anthropic pilots:
 *   - anthropic-memory  — every method tested with a mocked HTTPS layer
 *   - managed-agent     — every non-streaming method tested likewise
 *   - mcp-server        — actual JSON-RPC roundtrip via child_process.spawn
 *
 * These tests assert request shape (URL / headers / body) and parse
 * mock responses. They DO NOT hit live Anthropic — beta API paths might
 * shift; tests verify our service builds the right requests against the
 * documented public-beta shape.
 *
 * Run with: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// ─── Mock HTTP factory ──────────────────────────────────────────────

/**
 * Records every call and returns canned responses. Fail-loud if a request
 * arrives that hasn't been queued — keeps tests honest.
 */
function makeMockHttp() {
  const recorded = [];
  const queue = [];
  const handler = async (method, url, headers, body) => {
    recorded.push({ method, url, headers, body });
    if (queue.length === 0) {
      throw new Error(`mock-http: no response queued for ${method} ${url}`);
    }
    const next = queue.shift();
    if (typeof next === 'function') return next({ method, url, headers, body });
    return next;
  };
  handler.recorded = recorded;
  handler.enqueue = (response) => queue.push(response);
  handler.queueLength = () => queue.length;
  return handler;
}

// ─── anthropic-memory ───────────────────────────────────────────────

test('memory: createSession sends correct URL + beta header + body', async () => {
  const { createMemoryService } = require(path.join(ROOT, 'services/anthropic-memory'));
  const http = makeMockHttp();
  http.enqueue({ status: 200, body: { id: 'sess_1', external_id: 'wf15:b1:u1' } });
  const svc = createMemoryService({ apiKey: 'sk-ant-test', logger: { warn: () => {} }, http });

  const out = await svc.createSession({ businessId: 'b1', userId: 'u1' });

  const call = http.recorded[0];
  assert.equal(call.method, 'POST');
  assert.match(call.url, /\/v1\/managed-agents\/memory\/sessions/);
  assert.equal(call.headers['x-api-key'], 'sk-ant-test');
  assert.equal(call.headers['anthropic-beta'], 'managed-agents-2026-04-01');
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.body.external_id, 'wf15:b1:u1');
  assert.equal(call.body.metadata.businessId, 'b1');
  assert.equal(out.id, 'sess_1');
});

test('memory: getSession returns null on 404', async () => {
  const { createMemoryService } = require(path.join(ROOT, 'services/anthropic-memory'));
  const http = makeMockHttp();
  http.enqueue({ status: 404, body: { error: 'not_found' } });
  const svc = createMemoryService({ apiKey: 'sk-ant-test', logger: {}, http });

  const out = await svc.getSession('sess_does_not_exist');
  assert.equal(out, null);
});

test('memory: appendFact sends fact + kind + importance to correct path', async () => {
  const { createMemoryService } = require(path.join(ROOT, 'services/anthropic-memory'));
  const http = makeMockHttp();
  http.enqueue({ status: 200, body: { ok: true } });
  const svc = createMemoryService({ apiKey: 'sk-ant-test', logger: {}, http });

  await svc.appendFact({ sessionId: 'sess_1', fact: 'Customer prefers reels over carousels', importance: 0.8 });
  const call = http.recorded[0];
  assert.match(call.url, /\/v1\/managed-agents\/memory\/sessions\/sess_1\/append/);
  assert.equal(call.body.fact, 'Customer prefers reels over carousels');
  assert.equal(call.body.importance, 0.8);
  assert.equal(call.body.kind, 'observation');
});

test('memory: deleteSession returns ok on 200 and on 404', async () => {
  const { createMemoryService } = require(path.join(ROOT, 'services/anthropic-memory'));

  const http1 = makeMockHttp();
  http1.enqueue({ status: 200, body: {} });
  const svc1 = createMemoryService({ apiKey: 'sk-ant-test', logger: {}, http: http1 });
  const out1 = await svc1.deleteSession('sess_1');
  assert.deepEqual(out1, { ok: true });

  const http2 = makeMockHttp();
  http2.enqueue({ status: 404, body: { error: 'not_found' } });
  const svc2 = createMemoryService({ apiKey: 'sk-ant-test', logger: {}, http: http2 });
  const out2 = await svc2.deleteSession('sess_already_gone');
  assert.deepEqual(out2, { ok: true });
});

test('memory: ensureSession reuses existing session when GET ?external_id returns one', async () => {
  const { createMemoryService } = require(path.join(ROOT, 'services/anthropic-memory'));
  const http = makeMockHttp();
  http.enqueue({ status: 200, body: { data: [{ id: 'sess_existing', external_id: 'wf15:b1:u1' }] } });
  const svc = createMemoryService({ apiKey: 'sk-ant-test', logger: {}, http });

  const out = await svc.ensureSession({ businessId: 'b1', userId: 'u1' });
  assert.equal(out.id, 'sess_existing');
  assert.equal(http.queueLength(), 0, 'should not have called createSession');
  assert.equal(http.recorded[0].method, 'GET');
});

test('memory: ensureSession creates a new one when none exists', async () => {
  const { createMemoryService } = require(path.join(ROOT, 'services/anthropic-memory'));
  const http = makeMockHttp();
  // First GET returns empty list → falls through to POST create
  http.enqueue({ status: 200, body: { data: [] } });
  http.enqueue({ status: 200, body: { id: 'sess_new', external_id: 'wf15:b2:' } });
  const svc = createMemoryService({ apiKey: 'sk-ant-test', logger: {}, http });

  const out = await svc.ensureSession({ businessId: 'b2' });
  assert.equal(out.id, 'sess_new');
  assert.equal(http.recorded[0].method, 'GET');
  assert.equal(http.recorded[1].method, 'POST');
});

test('memory: createSession surfaces non-2xx as throwable error with status', async () => {
  const { createMemoryService } = require(path.join(ROOT, 'services/anthropic-memory'));
  const http = makeMockHttp();
  http.enqueue({ status: 500, body: { error: 'internal' }, raw: '{"error":"internal"}' });
  const svc = createMemoryService({ apiKey: 'sk-ant-test', logger: { warn: () => {} }, http });

  await assert.rejects(svc.createSession({ businessId: 'b1' }), (e) => {
    assert.match(e.message, /Memory createSession HTTP 500/);
    assert.equal(e.status, 500);
    return true;
  });
});

// ─── managed-agent ──────────────────────────────────────────────────

test('managed-agent: ensureAgent creates new when no existing match', async () => {
  const { createManagedAgentService } = require(path.join(ROOT, 'services/managed-agent'));
  const http = makeMockHttp();
  http.enqueue({ status: 200, body: { data: [] } }); // GET — no match
  http.enqueue({ status: 200, body: { id: 'agent_1', external_id: 'wf15:b1', name: 'test agent' } });
  const svc = createManagedAgentService({ apiKey: 'sk-ant-test', logger: {}, http });

  const agent = await svc.ensureAgent({
    externalId: 'wf15:b1',
    name: 'test agent',
    instructions: 'You are an AI brain.',
    model: 'claude-opus-4-7',
  });
  assert.equal(agent.id, 'agent_1');
  assert.equal(http.recorded.length, 2);
  assert.equal(http.recorded[1].method, 'POST');
  assert.equal(http.recorded[1].body.model, 'claude-opus-4-7');
  assert.equal(http.recorded[1].body.external_id, 'wf15:b1');
  assert.equal(http.recorded[1].headers['anthropic-beta'], 'managed-agents-2026-04-01');
});

test('managed-agent: ensureAgent reuses existing agent', async () => {
  const { createManagedAgentService } = require(path.join(ROOT, 'services/managed-agent'));
  const http = makeMockHttp();
  http.enqueue({ status: 200, body: { data: [{ id: 'agent_existing', external_id: 'wf15:b1' }] } });
  const svc = createManagedAgentService({ apiKey: 'sk-ant-test', logger: {}, http });

  const agent = await svc.ensureAgent({ externalId: 'wf15:b1', name: 'x', instructions: 'y' });
  assert.equal(agent.id, 'agent_existing');
  assert.equal(http.recorded.length, 1, 'no POST should have fired');
});

test('managed-agent: runSession non-stream sends correct payload', async () => {
  const { createManagedAgentService } = require(path.join(ROOT, 'services/managed-agent'));
  const http = makeMockHttp();
  http.enqueue({ status: 200, body: { session_id: 'sess_1', message: { content: 'hi' } } });
  const svc = createManagedAgentService({ apiKey: 'sk-ant-test', logger: {}, http });

  const out = await svc.runSession({
    agentId: 'agent_1',
    message: 'Generate a content brief for biz_xyz',
    businessId: 'biz_xyz',
    memorySessionId: 'sess_memory',
  });
  assert.equal(out.session_id, 'sess_1');
  const call = http.recorded[0];
  assert.match(call.url, /\/v1\/managed-agents\/agents\/agent_1\/sessions/);
  assert.equal(call.body.message.role, 'user');
  assert.equal(call.body.metadata.businessId, 'biz_xyz');
  assert.equal(call.body.memory_session_id, 'sess_memory');
});

test('managed-agent: pollSession + cancelSession hit correct paths', async () => {
  const { createManagedAgentService } = require(path.join(ROOT, 'services/managed-agent'));
  const http = makeMockHttp();
  http.enqueue({ status: 200, body: { id: 'sess_1', status: 'completed' } });
  http.enqueue({ status: 200, body: { id: 'sess_1', status: 'canceled' } });
  const svc = createManagedAgentService({ apiKey: 'sk-ant-test', logger: {}, http });

  const polled = await svc.pollSession('sess_1');
  assert.equal(polled.status, 'completed');
  assert.match(http.recorded[0].url, /\/v1\/managed-agents\/sessions\/sess_1$/);
  assert.equal(http.recorded[0].method, 'GET');

  const canceled = await svc.cancelSession('sess_1');
  assert.equal(canceled.status, 'canceled');
  assert.match(http.recorded[1].url, /\/v1\/managed-agents\/sessions\/sess_1\/cancel/);
  assert.equal(http.recorded[1].method, 'POST');
});

// ─── MCP server: real JSON-RPC roundtrip ────────────────────────────

test('mcp-server: roundtrip — initialize + tools/list returns correct schema', { timeout: 5000 }, async () => {
  // Spawn the script with empty SUPABASE_KEY so it exits gracefully with a
  // helpful error… actually the script REQUIRES SUPABASE_KEY to start. Pass a
  // dummy value; the JSON-RPC layer doesn't actually call Supabase for
  // initialize / tools/list, only for tools/call.
  const child = spawn('node', [path.join(ROOT, 'mcp-server/server.js')], {
    env: { ...process.env, SUPABASE_KEY: 'dummy-test-key', SUPABASE_URL: 'https://example.invalid' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  child.stdout.on('data', (c) => { stdoutBuf += c.toString('utf8'); });

  function readNextLine() {
    return new Promise((resolve, reject) => {
      const tryRead = () => {
        const idx = stdoutBuf.indexOf('\n');
        if (idx >= 0) {
          const line = stdoutBuf.slice(0, idx);
          stdoutBuf = stdoutBuf.slice(idx + 1);
          return resolve(line);
        }
        setTimeout(tryRead, 20);
      };
      const timer = setTimeout(() => reject(new Error('readNextLine timeout')), 3000);
      const wrap = () => { clearTimeout(timer); tryRead(); };
      wrap();
    });
  }

  try {
    // 1. initialize
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    const line1 = await readNextLine();
    const resp1 = JSON.parse(line1);
    assert.equal(resp1.id, 1);
    assert.equal(resp1.result.serverInfo.name, 'maroa-internal');
    assert.equal(resp1.result.serverInfo.version, '1.0.0');
    assert.ok(resp1.result.protocolVersion);

    // 2. tools/list
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    const line2 = await readNextLine();
    const resp2 = JSON.parse(line2);
    assert.equal(resp2.id, 2);
    assert.ok(Array.isArray(resp2.result.tools));
    assert.equal(resp2.result.tools.length, 6);
    const names = resp2.result.tools.map((t) => t.name);
    for (const expected of ['get_business_profile', 'get_content_history', 'get_performance_metrics', 'list_creative_concepts', 'list_recent_events', 'list_characters']) {
      assert.ok(names.includes(expected), `tools/list should include ${expected}`);
    }

    // 3. ping
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) + '\n');
    const line3 = await readNextLine();
    const resp3 = JSON.parse(line3);
    assert.equal(resp3.id, 3);
    assert.deepEqual(resp3.result, {});

    // 4. unknown method → JSON-RPC error
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'unknown/method' }) + '\n');
    const line4 = await readNextLine();
    const resp4 = JSON.parse(line4);
    assert.equal(resp4.id, 4);
    assert.equal(resp4.error.code, -32601);
    assert.match(resp4.error.message, /method not found/);
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
  }
});
