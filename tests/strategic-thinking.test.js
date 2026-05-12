'use strict';

const test = require('node:test');
const assert = require('node:assert');

const st = require('../lib/strategicThinking');

// ─── supportsNativeThinking ─────────────────────────────────────────────────

test('strategicThinking: detects native-thinking models', () => {
  assert.strictEqual(st.supportsNativeThinking('claude-sonnet-4-5'), true);
  assert.strictEqual(st.supportsNativeThinking('claude-opus-4-7'), true);
  assert.strictEqual(st.supportsNativeThinking('sonnet'), true);
  assert.strictEqual(st.supportsNativeThinking('opus'), true);
  // Older models — no native thinking
  assert.strictEqual(st.supportsNativeThinking('claude-haiku-4-5'), false);
  assert.strictEqual(st.supportsNativeThinking('claude-sonnet-3-5'), false);
  assert.strictEqual(st.supportsNativeThinking(''), false);
  assert.strictEqual(st.supportsNativeThinking(null), false);
});

// ─── parseTagModeResponse ───────────────────────────────────────────────────

test('strategicThinking: parses well-formed strategy + output', () => {
  const raw = `<strategy>Audience: busy parents. Hook: scarcity. Risks: too pushy.</strategy>

Buy now — only 12 left and we close orders at midnight.`;
  const out = st.parseTagModeResponse(raw);
  assert.match(out.strategy, /busy parents/);
  assert.match(out.output, /only 12 left/);
});

test('strategicThinking: handles multi-line strategy block', () => {
  const raw = `<strategy>
1. Audience: founders
2. Hook: authority via numbers
3. Constraints: 280 chars
</strategy>

We helped 47 founders ship their first AI feature this quarter.`;
  const out = st.parseTagModeResponse(raw);
  assert.match(out.strategy, /founders/);
  assert.match(out.strategy, /authority/);
  assert.match(out.output, /47 founders/);
});

test('strategicThinking: returns whole text as output when no tags', () => {
  const raw = 'Direct output with no strategy tags at all.';
  const out = st.parseTagModeResponse(raw);
  assert.strictEqual(out.strategy, '');
  assert.strictEqual(out.output, raw);
});

test('strategicThinking: handles empty / null input', () => {
  assert.deepStrictEqual(st.parseTagModeResponse(''), { strategy: '', output: '' });
  assert.deepStrictEqual(st.parseTagModeResponse(null), { strategy: '', output: '' });
});

// ─── strategize ─────────────────────────────────────────────────────────────

test('strategize: throws when callClaude or user missing', async () => {
  await assert.rejects(st.strategize({ user: 'x' }), /callClaude required/);
  await assert.rejects(st.strategize({ callClaude: async () => '' }), /user required/);
});

test('strategize: uses native thinking on Sonnet 4.5', async () => {
  const captured = [];
  const fakeClaude = async (args) => {
    captured.push(args);
    return 'Final output, no tags.';
  };
  const out = await st.strategize({
    callClaude: fakeClaude,
    user: 'Write a tagline',
    system: 'You are a copywriter.',
    model: 'claude-sonnet-4-5',
  });
  assert.strictEqual(out.mode, st.MODE.NATIVE);
  assert.strictEqual(out.output, 'Final output, no tags.');
  // Native mode must request thinking via extra.thinking
  assert.ok(captured[0].extra.thinking);
  assert.strictEqual(captured[0].extra.thinking.type, 'enabled');
});

test('strategize: uses tag mode on Haiku', async () => {
  const captured = [];
  const fakeClaude = async (args) => {
    captured.push(args);
    return `<strategy>Audience: students. Hook: curiosity.</strategy>

The one thing every student gets wrong about budgeting.`;
  };
  const out = await st.strategize({
    callClaude: fakeClaude,
    user: 'Write a hook',
    system: 'You are a copywriter.',
    model: 'claude-haiku-4-5',
  });
  assert.strictEqual(out.mode, st.MODE.TAG);
  assert.match(out.strategy, /students/);
  assert.match(out.output, /budgeting/);
  // Tag mode injects strategy instructions into system
  assert.match(captured[0].system, /<strategy>/);
  assert.match(captured[0].system, /TARGET AUDIENCE/);
});

test('strategize: forceTagMode overrides native model', async () => {
  let captured;
  const fakeClaude = async (args) => {
    captured = args;
    return '<strategy>x</strategy>\n\nfinal';
  };
  const out = await st.strategize({
    callClaude: fakeClaude,
    user: 'Test',
    system: 'sys',
    model: 'claude-sonnet-4-5', // native-capable
    forceTagMode: true,
  });
  assert.strictEqual(out.mode, st.MODE.TAG);
  // Should NOT have requested native thinking
  assert.strictEqual(captured.extra.thinking, undefined);
});

test('strategize: native mode falls back to tag mode on "unsupported" error', async () => {
  let calls = 0;
  const fakeClaude = async (args) => {
    calls++;
    if (args.extra?.thinking) {
      throw new Error('thinking parameter unsupported in this API version');
    }
    return '<strategy>fallback</strategy>\n\noutput';
  };
  const out = await st.strategize({
    callClaude: fakeClaude,
    user: 'Test',
    system: 'sys',
    model: 'claude-sonnet-4-5',
  });
  // Should have tried native first (call 1), then tag (call 2)
  assert.strictEqual(calls, 2);
  assert.strictEqual(out.mode, st.MODE.TAG);
  assert.strictEqual(out.output, 'output');
});

test('strategize: real errors (non-thinking-related) propagate', async () => {
  const fakeClaude = async () => {
    throw new Error('rate_limited 429');
  };
  await assert.rejects(
    st.strategize({
      callClaude: fakeClaude,
      user: 'x',
      system: 's',
      model: 'claude-sonnet-4-5',
    }),
    /rate_limited/
  );
});

test('strategize: tag-mode system prompt enumerates the 4 required strategy points', async () => {
  let captured;
  const fakeClaude = async (args) => {
    captured = args;
    return 'output';
  };
  await st.strategize({
    callClaude: fakeClaude,
    user: 'x',
    system: 'You are a copywriter.',
    model: 'claude-haiku-4-5',
  });
  assert.match(captured.system, /TARGET AUDIENCE/);
  assert.match(captured.system, /CORE HOOK/);
  assert.match(captured.system, /CONSTRAINT MAP/);
  assert.match(captured.system, /RISKS/);
});
