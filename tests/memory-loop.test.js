'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ml = require('../services/prompts/memory-loop');

// ─── Scope + helpers ──────────────────────────────────────────────────────

test('buildScope: combines domain + businessId', () => {
  assert.strictEqual(ml.buildScope('wf1', 'biz-123'), 'wf1.biz-123');
  assert.strictEqual(ml.buildScope('ad-optimizer', 'biz-456'), 'ad-optimizer.biz-456');
});

test('buildPriorContextBlock: empty array → empty string', () => {
  assert.strictEqual(ml.buildPriorContextBlock([]), '');
  assert.strictEqual(ml.buildPriorContextBlock(null), '');
});

test('buildPriorContextBlock: caps at MAX_FACTS_PER_INJECTION', () => {
  const many = Array.from({ length: 50 }, (_, i) => `Fact ${i}`);
  const block = ml.buildPriorContextBlock(many);
  // 25 numbered lines max
  const numberedLines = (block.match(/^\d+\./gm) || []).length;
  assert.strictEqual(numberedLines, ml.MAX_FACTS_PER_INJECTION);
});

test('buildPriorContextBlock: includes header + numbered list', () => {
  const block = ml.buildPriorContextBlock(['Pattern X works.', 'Avoid Y.']);
  assert.match(block, /PRIOR LEARNINGS/);
  assert.match(block, /1\. Pattern X works\./);
  assert.match(block, /2\. Avoid Y\./);
});

test('freshFactsOnly: filters facts older than MAX_FACT_AGE_DAYS', () => {
  const old = new Date(Date.now() - 200 * 86400000).toISOString();
  const fresh = new Date(Date.now() - 30 * 86400000).toISOString();
  const filtered = ml.freshFactsOnly([
    { fact: 'old', created_at: old },
    { fact: 'fresh', created_at: fresh },
  ]);
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0], 'fresh');
});

test('freshFactsOnly: handles string-array input + facts without timestamps', () => {
  const out = ml.freshFactsOnly(['plain string', { fact: 'object form' }, '']);
  assert.deepStrictEqual(out, ['plain string', 'object form']);
});

// ─── Learning extraction ──────────────────────────────────────────────────

test('extractLearnings wf1.content: high engagement → save positive pattern', () => {
  const facts = ml.extractLearnings({
    task: 'wf1.content',
    input: { baseline_engagement_pct: 1.5 },
    output: { caption: 'Why does your morning coffee taste different in summer?' },
    outcome: { engagement_pct: 4.2 },
  });
  assert.strictEqual(facts.length, 1);
  assert.match(facts[0], /High-engagement/);
});

test('extractLearnings wf1.content: low engagement → save anti-pattern', () => {
  const facts = ml.extractLearnings({
    task: 'wf1.content',
    input: {},
    output: { caption: 'New product available' },
    outcome: { engagement_pct: 0.2 },
  });
  assert.strictEqual(facts.length, 1);
  assert.match(facts[0], /Low-engagement/);
});

test('extractLearnings ad-optimizer.audit: positive ROAS follow-up → save signal', () => {
  const facts = ml.extractLearnings({
    task: 'ad-optimizer.audit',
    input: { market_tier: 'ULTRA_LOW', budget_tier: 'SMALL' },
    output: { decision: 'scale' },
    outcome: { decision_followup_roas_change: 0.4 },
  });
  assert.strictEqual(facts.length, 1);
  assert.match(facts[0], /good signal/);
});

test('extractLearnings unknown task: returns empty array (no memory pollution)', () => {
  const facts = ml.extractLearnings({
    task: 'random.task',
    input: {},
    output: { something: true },
  });
  assert.strictEqual(facts.length, 0);
});

test('extractLearnings voc.synthesis: saves top customer phrase', () => {
  const facts = ml.extractLearnings({
    task: 'voc.synthesis',
    output: {
      pain_points: [
        { theme: 'Parking', verbatim_quotes: ['parking is impossible on weekends'] },
      ],
    },
  });
  assert.strictEqual(facts.length, 1);
  assert.match(facts[0], /Top customer phrase/);
});

// ─── End-to-end loop ──────────────────────────────────────────────────────

test('applyMemoryLoop: runs task without memoryService (graceful degradation)', async () => {
  let priorContextSeen = null;
  const r = await ml.applyMemoryLoop({
    memoryService: null,
    scope: 'wf1.business-1',
    task: 'wf1.content',
    runTask: async (prior) => { priorContextSeen = prior; return { input: {}, output: {} }; },
  });
  assert.strictEqual(priorContextSeen, '');
  assert.strictEqual(r.factsRead, 0);
  assert.strictEqual(r.factsWritten, 0);
});

test('applyMemoryLoop: reads + writes facts when memoryService provided', async () => {
  const factsAppended = [];
  const fakeMemory = {
    ensureSession: async () => ({ id: 'sess-123' }),
    getSession: async () => ({ facts: ['Existing fact 1', 'Existing fact 2'] }),
    appendFact: async ({ sessionId, fact }) => { factsAppended.push(fact); },
  };
  const r = await ml.applyMemoryLoop({
    memoryService: fakeMemory,
    scope: 'wf1.business-1',
    task: 'wf1.content',
    runTask: async (prior) => {
      assert.match(prior, /PRIOR LEARNINGS/);
      assert.match(prior, /Existing fact 1/);
      return {
        input: { baseline_engagement_pct: 1.0 },
        output: { caption: 'Test caption that will engage' },
      };
    },
    outcome: { engagement_pct: 3.0 },
  });
  assert.strictEqual(r.factsRead, 2);
  assert.strictEqual(r.factsWritten, 1);
  assert.match(factsAppended[0], /High-engagement/);
});

test('applyMemoryLoop: graceful when memory read fails', async () => {
  const fakeMemory = {
    ensureSession: async () => { throw new Error('memory unavailable'); },
    getSession: async () => null,
    appendFact: async () => {},
  };
  const r = await ml.applyMemoryLoop({
    memoryService: fakeMemory,
    scope: 'wf1.business-1',
    task: 'wf1.content',
    runTask: async () => ({ input: {}, output: {} }),
  });
  // Falls back to no-prior, no-write — but the task still runs
  assert.strictEqual(r.factsRead, 0);
  assert.strictEqual(r.factsWritten, 0);
});
