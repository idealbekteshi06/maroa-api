'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { executeTool, TOOLS, TOOL_SCHEMAS } = require('../services/wf15/toolRegistry.js');
const createWf15 = require('../services/wf15');

const BIZ = 'fea4aae5-14b4-486d-89f4-33a7d7e4ab60';

function fakeCtx(recorder) {
  return {
    businessId: BIZ,
    logger: { warn() {}, info() {} },
    loopback: async (method, path, body) => {
      recorder.push({ method, path, body });
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
test('executeTool routes to the right loopback path/method', async () => {
  const rec = [];
  const ctx = fakeCtx(rec);

  await executeTool('get_performance', {}, ctx);
  await executeTool('run_forecast', { horizonDays: 60 }, ctx);
  await executeTool('create_ad_campaign', { objective: 'leads', target_audience: 'x', daily_budget: 20 }, ctx);

  assert.equal(rec[0].method, 'GET');
  assert.ok(rec[0].path.startsWith('/webhook/analytics-get?business_id='));

  assert.equal(rec[1].method, 'POST');
  assert.equal(rec[1].path, '/webhook/forecast');
  assert.deepEqual(rec[1].body, { businessId: BIZ, horizonDays: 60 });

  assert.equal(rec[2].method, 'POST');
  assert.equal(rec[2].path, '/webhook/meta-campaign-create');
  assert.equal(rec[2].body.wizard.objective, 'leads');
  assert.equal(rec[2].body.wizard.daily_budget, 20);
});

test('navigate tool returns {navigate} without calling loopback', async () => {
  const rec = [];
  const ctx = fakeCtx(rec);
  const result = await executeTool('navigate', { tab: 'paid-ads' }, ctx);
  assert.deepEqual(result, { navigate: 'paid-ads' });
  assert.equal(rec.length, 0);
});

test('unknown tool returns { error: unknown_tool }', async () => {
  const result = await executeTool('nope', {}, fakeCtx([]));
  assert.deepEqual(result, { error: 'unknown_tool' });
});

test('executeTool never throws — loopback error becomes { error }', async () => {
  const ctx = {
    businessId: BIZ,
    logger: { warn() {} },
    loopback: async () => {
      throw new Error('boom');
    },
  };
  const result = await executeTool('get_performance', {}, ctx);
  assert.equal(result.error, 'boom');
});

test('approval flags are correct', () => {
  assert.equal(TOOLS.get_performance.approval, false);
  assert.equal(TOOLS.navigate.approval, false);
  assert.equal(TOOLS.create_ad_campaign.approval, true);
  assert.equal(TOOLS.generate_content.approval, true);
  assert.ok(TOOL_SCHEMAS.every((s) => s.name && s.input_schema));
});

// ---------------------------------------------------------------------------
// sendMessage agentic-loop harness

function fakeRes() {
  const writes = [];
  return {
    writableEnded: false,
    write(s) {
      writes.push(s);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    _writes: writes,
  };
}

function baseDeps({ callClaude, loopbackRec }) {
  const rows = {};
  const patches = [];
  return {
    deps: {
      sbGet: async (table) => {
        // brand context + memory + history reads — return empty-ish
        if (table === 'businesses') return [{ id: BIZ, business_name: 'Test', primary_language: 'English' }];
        return [];
      },
      sbPost: async (table, body) => {
        const id = `${table}-${Object.keys(rows).length + 1}`;
        rows[id] = { id, ...body };
        return { id, ...body };
      },
      sbPatch: async (table, scope, body) => {
        patches.push({ table, scope, body });
        return {};
      },
      callClaude,
      streamClaude: null,
      extractJSON: () => ({}),
      logger: { warn() {}, info() {} },
    },
    rows,
    patches,
    loopbackRec,
  };
}

test('agentic loop runs a safe tool then finishes with text', async () => {
  const loopbackRec = [];
  // Intercept the real loopback via global fetch so no network happens.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    loopbackRec.push({ url, method: opts.method });
    return { ok: true, status: 200, text: async () => JSON.stringify({ views: 42 }) };
  };

  let call = 0;
  const callClaude = async (_p, _m, _t, extra) => {
    call++;
    if (call === 1) {
      return {
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'tu_1', name: 'get_performance', input: {} },
        ],
      };
    }
    // second call: Claude saw the tool_result, replies with final text
    assert.ok(extra.messages.some((m) => Array.isArray(m.content) && m.content[0]?.type === 'tool_result'));
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'You had 42 views.' }] };
  };

  const { deps, patches } = baseDeps({ callClaude, loopbackRec });
  const wf15 = createWf15(deps);
  const res = fakeRes();

  try {
    await wf15.sendMessage({ businessId: BIZ, conversationId: 'c1', content: 'how am I doing?', res });
  } finally {
    globalThis.fetch = origFetch;
  }

  const joined = res._writes.join('');
  assert.ok(joined.includes('event: tool_call'), 'tool_call emitted');
  assert.ok(joined.includes('event: tool_result'), 'tool_result emitted');
  assert.ok(joined.includes('data: [DONE]'), 'done emitted');
  assert.equal(loopbackRec.length, 1, 'safe tool executed via loopback');

  // final assistant text saved
  const contentPatch = patches.find((p) => p.table === 'brain_messages' && p.body.content?.includes('42 views'));
  assert.ok(contentPatch, 'final text saved to assistant message');
});

test('agentic loop STOPS on an approval-required tool (no execution)', async () => {
  const loopbackRec = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    loopbackRec.push({ url, method: opts.method });
    return { ok: true, status: 200, text: async () => '{}' };
  };

  const callClaude = async () => ({
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'I can create that campaign.' },
      {
        type: 'tool_use',
        id: 'tu_2',
        name: 'create_ad_campaign',
        input: { objective: 'leads', target_audience: 'locals', daily_budget: 15 },
      },
    ],
  });

  const { deps, rows } = baseDeps({ callClaude, loopbackRec });
  const wf15 = createWf15(deps);
  const res = fakeRes();

  try {
    await wf15.sendMessage({ businessId: BIZ, conversationId: 'c1', content: 'run a campaign', res });
  } finally {
    globalThis.fetch = origFetch;
  }

  const joined = res._writes.join('');
  assert.ok(joined.includes('awaiting_approval'), 'tool_call emitted as awaiting_approval');
  assert.equal(loopbackRec.length, 0, 'gated tool NOT executed');

  const toolRow = Object.values(rows).find((r) => r.tool === 'create_ad_campaign');
  assert.ok(toolRow, 'brain_tool_calls row persisted');
  assert.equal(toolRow.status, 'awaiting_approval');
  assert.equal(toolRow.requires_approval, true);
});

test('toolDecision approve executes the stored tool and marks completed', async () => {
  const loopbackRec = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    loopbackRec.push({ url, method: opts.method });
    return { ok: true, status: 200, text: async () => JSON.stringify({ campaign_id: 'x1' }) };
  };

  const patches = [];
  const deps = {
    sbGet: async (table) =>
      table === 'brain_tool_calls'
        ? [
            {
              id: 'tc1',
              business_id: BIZ,
              tool: 'create_ad_campaign',
              input: { objective: 'leads', target_audience: 'locals', daily_budget: 15 },
              requires_approval: true,
              status: 'awaiting_approval',
            },
          ]
        : [],
    sbPost: async () => ({ id: 'x' }),
    sbPatch: async (table, scope, body) => {
      patches.push({ table, scope, body });
      return {};
    },
    callClaude: async () => ({}),
    streamClaude: null,
    extractJSON: () => ({}),
    logger: { warn() {}, info() {} },
  };
  const wf15 = createWf15(deps);

  let out;
  try {
    out = await wf15.toolDecision({ businessId: BIZ, toolCallId: 'tc1', decision: 'approve' });
  } finally {
    globalThis.fetch = origFetch;
  }

  assert.equal(out.status, 'completed');
  assert.equal(loopbackRec.length, 1, 'tool executed via loopback on approve');
  const patch = patches.find((p) => p.table === 'brain_tool_calls' && p.body.status === 'completed');
  assert.ok(patch, 'row marked completed');
});
