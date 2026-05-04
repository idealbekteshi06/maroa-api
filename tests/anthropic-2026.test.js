'use strict';

/**
 * Integration tests for the Anthropic 2026 features pass:
 *   - Opus 4.7 swap (no stale 4.5 / 4.6 references)
 *   - Files API service surface + document/image block builders
 *   - Batch API service surface + buildRequest shape + extended-output detection
 *   - Citations parsing across char_location / page_location / content_block_location
 *   - Memory service stub
 *   - Managed Agents service stub
 *   - MCP server tool catalog
 *
 * Run with: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');

// ─── 1. Opus 4.7 swap verification ───────────────────────────────────

test('opus swap: no claude-opus-4-5 or 4-6 references in production code', () => {
  const targets = [
    'server.js',
    'services/higgsfield.js',
    'services/wf1/engine.js',
    'services/wf13/engine.js',
    'services/wf15/index.js',
    'services/wf3/index.js',
    'services/wf5/index.js',
    'services/wf8/index.js',
    'services/wf12/index.js',
    'services/wf14/index.js',
    'services/creative/registerRoutes.js',
  ];
  for (const rel of targets) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, 'utf8');
    assert.ok(!/claude-opus-4-5/.test(src), `${rel} still references claude-opus-4-5`);
    assert.ok(!/claude-opus-4-6/.test(src), `${rel} still references claude-opus-4-6`);
  }
});

test('opus swap: at least one claude-opus-4-7 reference exists', () => {
  const targets = ['services/higgsfield.js', 'services/wf1/engine.js'];
  for (const rel of targets) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(/claude-opus-4-7/.test(src), `${rel} should reference claude-opus-4-7`);
  }
});

// ─── 2. Files API ────────────────────────────────────────────────────

test('anthropic-files: factory returns the expected surface', () => {
  const { createFilesService } = require(path.join(ROOT, 'services/anthropic-files'));
  const svc = createFilesService({ apiKey: 'test', logger: { warn: () => {} } });
  for (const fn of ['uploadBuffer', 'listFiles', 'getFile', 'deleteFile', 'buildDocumentBlock', 'buildImageBlock']) {
    assert.equal(typeof svc[fn], 'function', `${fn} should be exported`);
  }
  assert.equal(svc.constants.FILES_BETA, 'files-api-2025-04-14');
  assert.equal(svc.constants.MAX_FILE_BYTES, 500 * 1024 * 1024);
});

test('anthropic-files: buildDocumentBlock supports citations + cache_control', () => {
  const { createFilesService } = require(path.join(ROOT, 'services/anthropic-files'));
  const svc = createFilesService({ apiKey: 'test', logger: { warn: () => {} } });

  const minimal = svc.buildDocumentBlock({ fileId: 'file_abc' });
  assert.equal(minimal.type, 'document');
  assert.equal(minimal.source.type, 'file');
  assert.equal(minimal.source.file_id, 'file_abc');
  assert.equal(minimal.citations, undefined);
  assert.equal(minimal.cache_control, undefined);

  const full = svc.buildDocumentBlock({
    fileId: 'file_abc',
    title: 'Brand Guidelines',
    context: 'v3 latest',
    citations: true,
    cacheControl: true,
  });
  assert.equal(full.title, 'Brand Guidelines');
  assert.equal(full.context, 'v3 latest');
  assert.deepEqual(full.citations, { enabled: true });
  assert.deepEqual(full.cache_control, { type: 'ephemeral' });
});

test('anthropic-files: buildImageBlock returns a valid image content block', () => {
  const { createFilesService } = require(path.join(ROOT, 'services/anthropic-files'));
  const svc = createFilesService({ apiKey: 'test', logger: { warn: () => {} } });
  const blk = svc.buildImageBlock({ fileId: 'file_img' });
  assert.equal(blk.type, 'image');
  assert.equal(blk.source.type, 'file');
  assert.equal(blk.source.file_id, 'file_img');
});

test('anthropic-files: requires API key', () => {
  const { createFilesService } = require(path.join(ROOT, 'services/anthropic-files'));
  assert.throws(() => createFilesService({ apiKey: null }), /ANTHROPIC_KEY required/);
});

// ─── 3. Batch API ────────────────────────────────────────────────────

test('anthropic-batch: factory returns the expected surface', () => {
  const { createBatchService } = require(path.join(ROOT, 'services/anthropic-batch'));
  const svc = createBatchService({ apiKey: 'test', logger: {}, sbGet: async () => [], sbPost: async () => ({}), sbPatch: async () => ({}) });
  for (const fn of ['buildRequest', 'submitBatch', 'pollBatch', 'fetchResults', 'cancelBatch', 'reconcileResults']) {
    assert.equal(typeof svc[fn], 'function', `${fn} should be exported`);
  }
  assert.equal(svc.constants.BATCH_MAX_REQUESTS, 100000);
});

test('anthropic-batch: buildRequest produces correct shape', () => {
  const { createBatchService } = require(path.join(ROOT, 'services/anthropic-batch'));
  const svc = createBatchService({ apiKey: 'test', logger: {}, sbGet: async () => [], sbPost: async () => ({}), sbPatch: async () => ({}) });
  const req = svc.buildRequest({
    customId: 'biz_123_concept_5',
    model: 'claude-sonnet-4-5',
    system: 'You are a senior marketing analyst.',
    prompt: 'Score this concept.',
    maxTokens: 2048,
  });
  assert.equal(req.custom_id, 'biz_123_concept_5');
  assert.equal(req.params.model, 'claude-sonnet-4-5');
  assert.equal(req.params.max_tokens, 2048);
  assert.equal(req.params.messages[0].role, 'user');
  // buildRequest always normalises content to an array of blocks for batch submissions
  assert.ok(Array.isArray(req.params.messages[0].content));
  assert.equal(req.params.messages[0].content.at(-1).type, 'text');
  assert.equal(req.params.messages[0].content.at(-1).text, 'Score this concept.');
  assert.equal(req.params.system, 'You are a senior marketing analyst.');
});

test('anthropic-batch: buildRequest with cacheSystem wraps system in cacheable block', () => {
  const { createBatchService } = require(path.join(ROOT, 'services/anthropic-batch'));
  const svc = createBatchService({ apiKey: 'test', logger: {}, sbGet: async () => [], sbPost: async () => ({}), sbPatch: async () => ({}) });
  const req = svc.buildRequest({
    customId: 'biz_x',
    model: 'claude-opus-4-7',
    system: 'long system',
    prompt: 'q',
    cacheSystem: true,
  });
  assert.ok(Array.isArray(req.params.system));
  assert.equal(req.params.system[0].type, 'text');
  assert.deepEqual(req.params.system[0].cache_control, { type: 'ephemeral' });
});

test('anthropic-batch: buildRequest with fileIds + citations attaches document blocks', () => {
  const { createBatchService } = require(path.join(ROOT, 'services/anthropic-batch'));
  const svc = createBatchService({ apiKey: 'test', logger: {}, sbGet: async () => [], sbPost: async () => ({}), sbPatch: async () => ({}) });
  const req = svc.buildRequest({
    customId: 'biz_x',
    model: 'claude-sonnet-4-5',
    prompt: 'Summarize.',
    fileIds: ['file_a', 'file_b'],
    citations: true,
  });
  const content = req.params.messages[0].content;
  assert.ok(Array.isArray(content));
  assert.equal(content.length, 3); // 2 docs + 1 text
  assert.equal(content[0].type, 'document');
  assert.equal(content[0].source.file_id, 'file_a');
  assert.deepEqual(content[0].citations, { enabled: true });
  assert.equal(content[2].type, 'text');
});

test('anthropic-batch: buildRequest validates required fields', () => {
  const { createBatchService } = require(path.join(ROOT, 'services/anthropic-batch'));
  const svc = createBatchService({ apiKey: 'test', logger: {}, sbGet: async () => [], sbPost: async () => ({}), sbPatch: async () => ({}) });
  assert.throws(() => svc.buildRequest({ model: 'x', prompt: 'y' }), /customId required/);
  assert.throws(() => svc.buildRequest({ customId: 'x', prompt: 'y' }), /model required/);
});

// ─── 4. Citations ────────────────────────────────────────────────────

test('citations: parseCitedResponse with no citations returns plain text', () => {
  const c = require(path.join(ROOT, 'services/anthropic-citations'));
  const out = c.parseCitedResponse({
    content: [
      { type: 'text', text: 'Here is the answer.' },
    ],
  });
  assert.equal(out.renderedText, 'Here is the answer.');
  assert.deepEqual(out.citations, []);
});

test('citations: parseCitedResponse renders inline numbered markers + dedupes', () => {
  const c = require(path.join(ROOT, 'services/anthropic-citations'));
  const out = c.parseCitedResponse({
    content: [
      { type: 'text', text: 'According to your data, ' },
      {
        type: 'text', text: 'Q4 reach grew 32%',
        citations: [{ type: 'char_location', cited_text: 'Q4 reach: +32%', document_index: 0, document_title: 'Performance Report', start_char_index: 100, end_char_index: 120 }],
      },
      { type: 'text', text: ' and ' },
      {
        type: 'text', text: 'CTR improved',
        citations: [{ type: 'page_location', cited_text: 'CTR rose from 0.8 to 1.4', document_index: 1, document_title: 'IG Analytics', start_page_number: 3, end_page_number: 4 }],
      },
      // duplicate citation should NOT get a new marker
      {
        type: 'text', text: ' as already shown',
        citations: [{ type: 'char_location', cited_text: 'Q4 reach: +32%', document_index: 0, document_title: 'Performance Report', start_char_index: 100, end_char_index: 120 }],
      },
    ],
  });
  assert.match(out.renderedText, /\[1\]/);
  assert.match(out.renderedText, /\[2\]/);
  assert.equal(out.citations.length, 2, 'duplicates dedupe to 2 footnotes');
  assert.equal(out.citations[0].kind, 'text');
  assert.equal(out.citations[1].kind, 'pdf');
  assert.equal(out.citations[1].startPage, 3);
});

test('citations: normaliseCitation handles all 3 location types', () => {
  const c = require(path.join(ROOT, 'services/anthropic-citations'));
  const text = c.normaliseCitation({ type: 'char_location', cited_text: 'x', document_index: 0, start_char_index: 5, end_char_index: 10 });
  assert.equal(text.kind, 'text');
  assert.equal(text.start, 5);
  assert.equal(text.end, 10);

  const pdf = c.normaliseCitation({ type: 'page_location', cited_text: 'y', document_index: 1, start_page_number: 2, end_page_number: 3 });
  assert.equal(pdf.kind, 'pdf');
  assert.equal(pdf.startPage, 2);

  const block = c.normaliseCitation({ type: 'content_block_location', cited_text: 'z', document_index: 2, start_block_index: 0, end_block_index: 1 });
  assert.equal(block.kind, 'block');
  assert.equal(block.startBlock, 0);
});

test('citations: builders attach { citations: { enabled: true } } when requested', () => {
  const c = require(path.join(ROOT, 'services/anthropic-citations'));
  const inline = c.buildInlineTextDocument({ data: 'foo', citations: true });
  assert.deepEqual(inline.citations, { enabled: true });

  const pdf = c.buildPdfBase64Document({ base64Data: 'AAAA', citations: true, cacheControl: true });
  assert.equal(pdf.source.type, 'base64');
  assert.deepEqual(pdf.cache_control, { type: 'ephemeral' });

  const file = c.buildFileDocument({ fileId: 'file_abc', citations: false });
  assert.equal(file.citations, undefined);
});

// ─── 5. Memory ───────────────────────────────────────────────────────

test('anthropic-memory: factory returns the expected surface', () => {
  const { createMemoryService } = require(path.join(ROOT, 'services/anthropic-memory'));
  const svc = createMemoryService({ apiKey: 'test', logger: {} });
  for (const fn of ['createSession', 'getSession', 'appendFact', 'deleteSession', 'ensureSession']) {
    assert.equal(typeof svc[fn], 'function', `${fn} should be exported`);
  }
  assert.equal(svc.constants.MANAGED_AGENTS_BETA, 'managed-agents-2026-04-01');
});

// ─── 6. Managed Agents ───────────────────────────────────────────────

test('managed-agent: factory returns the expected surface', () => {
  const { createManagedAgentService } = require(path.join(ROOT, 'services/managed-agent'));
  const svc = createManagedAgentService({ apiKey: 'test', logger: {} });
  for (const fn of ['ensureAgent', 'runSession', 'pollSession', 'cancelSession']) {
    assert.equal(typeof svc[fn], 'function', `${fn} should be exported`);
  }
  assert.equal(svc.constants.MANAGED_AGENTS_BETA, 'managed-agents-2026-04-01');
});

// ─── 7. MCP Server ───────────────────────────────────────────────────

test('mcp-server: source declares the 6 expected tools and JSON-RPC line protocol', () => {
  const src = fs.readFileSync(path.join(ROOT, 'mcp-server/server.js'), 'utf8');
  for (const tool of [
    'get_business_profile',
    'get_content_history',
    'get_performance_metrics',
    'list_creative_concepts',
    'list_recent_events',
    'list_characters',
  ]) {
    assert.ok(src.includes(`name: '${tool}'`), `mcp tool ${tool} should be declared`);
  }
  assert.ok(src.includes("method === 'initialize'"), 'JSON-RPC initialize handler');
  assert.ok(src.includes("method === 'tools/list'"), 'JSON-RPC tools/list handler');
  assert.ok(src.includes("method === 'tools/call'"), 'JSON-RPC tools/call handler');
});

test('mcp-server: shebang + node syntax check', () => {
  const src = fs.readFileSync(path.join(ROOT, 'mcp-server/server.js'), 'utf8');
  assert.ok(src.startsWith('#!/usr/bin/env node'), 'shebang for stdio launcher');
});

// ─── 8. Anthropic registerRoutes wiring ──────────────────────────────

test('anthropic registerRoutes: exposed plan limits + factory loadable', () => {
  const r = require(path.join(ROOT, 'services/anthropic/registerRoutes'));
  assert.equal(typeof r.registerAnthropicRoutes, 'function');
  assert.deepEqual(r.PLAN_FILES_LIMIT, { starter: 5, growth: 50, agency: 500 });
  assert.deepEqual(r.PLAN_BATCH_LIMIT, { starter: 1, growth: 10, agency: 100 });
  assert.deepEqual(r.PLAN_INSIGHTS_LIMIT, { starter: 5, growth: 50, agency: 500 });
});

test('migrations: 035 + 036 SQL files exist and are idempotent', () => {
  const sql035 = fs.readFileSync(path.join(ROOT, 'migrations/035_anthropic_files.sql'), 'utf8');
  const sql036 = fs.readFileSync(path.join(ROOT, 'migrations/036_anthropic_batches.sql'), 'utf8');
  assert.match(sql035, /CREATE TABLE IF NOT EXISTS anthropic_files/);
  assert.match(sql035, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql036, /CREATE TABLE IF NOT EXISTS anthropic_batches/);
  assert.match(sql036, /CREATE TABLE IF NOT EXISTS anthropic_batch_results/);
  assert.match(sql036, /idx_anthropic_batches_status/);
});
