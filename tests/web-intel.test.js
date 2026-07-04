'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { webSearchQuery, parseWebSearchResponse } = require('../lib/webIntel');
const competitorWatch = require('../services/competitor-watch');
const citationTracker = require('../services/citation-tracker');

const BIZ = '11111111-1111-4111-8111-111111111111';

test('parseWebSearchResponse: joins text, dedupes cited URLs, counts searches', () => {
  const body = {
    content: [
      { type: 'server_tool_use', name: 'web_search', input: { query: 'x' } },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://a.com/1' },
          { type: 'web_search_result', url: 'https://b.com/2' },
        ],
      },
      {
        type: 'text',
        text: 'Answer text.',
        citations: [{ type: 'web_search_result_location', url: 'https://a.com/1' }],
      },
      { type: 'text', text: 'More.' },
    ],
  };
  const r = parseWebSearchResponse(body);
  assert.strictEqual(r.text, 'Answer text.\nMore.');
  assert.deepStrictEqual(r.citedUrls, ['https://a.com/1', 'https://b.com/2']);
  assert.strictEqual(r.searchCount, 1);
});

test('parseWebSearchResponse: error-object tool result (not a list) is tolerated', () => {
  const r = parseWebSearchResponse({
    content: [
      {
        type: 'web_search_tool_result',
        content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
      },
      { type: 'text', text: 'Partial answer.' },
    ],
  });
  assert.strictEqual(r.text, 'Partial answer.');
  assert.deepStrictEqual(r.citedUrls, []);
});

test('webSearchQuery: passes webSearch tool config through callClaude and soft-fails on error', async () => {
  let captured;
  const fakeClaude = async (prompt, model, maxTokens, extra) => {
    captured = { prompt, model, maxTokens, extra };
    return { content: [{ type: 'text', text: 'grounded answer' }] };
  };
  const ok = await webSearchQuery({ callClaude: fakeClaude, prompt: 'q', businessId: BIZ, maxSearches: 2 });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.text, 'grounded answer');
  assert.strictEqual(captured.extra.webSearch.max_uses, 2);
  assert.strictEqual(captured.extra.returnFullResponse, true);

  const boom = await webSearchQuery({
    callClaude: async () => {
      throw new Error('anthropic down');
    },
    prompt: 'q',
  });
  assert.strictEqual(boom.ok, false);
  assert.strictEqual(boom.reason, 'web_search_failed');
});

test('competitor-watch webIntelSweep: parses signal JSON, validates enums, caps at 10', async () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    signal_type: i === 0 ? 'promotion' : 'made_up_type',
    summary: `Signal ${i}`,
    severity: i === 0 ? 'alert' : 'nonsense',
    source_url: 'https://news.example/x',
  }));
  const fakeClaude = async () => ({
    content: [{ type: 'text', text: `Here you go:\n${JSON.stringify(items)}` }],
  });
  const signals = await competitorWatch.webIntelSweep({
    businessId: BIZ,
    competitorName: 'Acme Co',
    deps: { callClaude: fakeClaude },
  });
  assert.strictEqual(signals.length, 10, 'capped at 10');
  assert.strictEqual(signals[0].signal_type, 'promotion');
  assert.strictEqual(signals[0].severity, 'alert');
  assert.strictEqual(signals[1].signal_type, 'news', 'unknown type normalized');
  assert.strictEqual(signals[1].severity, 'info', 'unknown severity normalized');
});

test('competitor-watch webIntelSweep: no callClaude → [] (soft skip)', async () => {
  assert.deepStrictEqual(await competitorWatch.webIntelSweep({ businessId: BIZ, competitorName: 'X', deps: {} }), []);
});

test('citation-tracker queryClaudeWebSearch: returns engine result with cited urls', async () => {
  const fakeClaude = async () => ({
    content: [
      {
        type: 'web_search_tool_result',
        content: [{ type: 'web_search_result', url: 'https://customer-site.com/services' }],
      },
      { type: 'text', text: 'Best plumbers in Tirana include Customer Site.' },
    ],
  });
  const r = await citationTracker.queryClaudeWebSearch({
    prompt: 'best plumber tirana',
    businessId: BIZ,
    deps: { callClaude: fakeClaude },
  });
  assert.strictEqual(r.engine, 'claude');
  assert.ok(r.response_text.includes('Customer Site'));
  assert.deepStrictEqual(r.cited_urls, ['https://customer-site.com/services']);
  assert.strictEqual(r.api_cost_usd, 0);
});

test('citation-tracker queryClaudeWebSearch: null without callClaude or on empty result', async () => {
  assert.strictEqual(await citationTracker.queryClaudeWebSearch({ prompt: 'x', businessId: BIZ, deps: {} }), null);
  const empty = await citationTracker.queryClaudeWebSearch({
    prompt: 'x',
    businessId: BIZ,
    deps: { callClaude: async () => ({ content: [] }) },
  });
  assert.strictEqual(empty, null);
});
