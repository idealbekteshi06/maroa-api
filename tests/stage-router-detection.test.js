'use strict';

/**
 * tests/stage-router-detection.test.js
 *
 * Wave 60 Session 2 — verifies detectStage:
 *   - heuristic detection from customer_history
 *   - Schwartz signals from current_content override low-confidence heuristic
 *   - optional LLM probe runs only for ambiguous cases
 *   - safe defaults when nothing is detectable
 */

const test = require('node:test');
const assert = require('node:assert');

const { detectStage, detectAndRoute } = require('../lib/stageRouter');

// ─── Heuristic detection ─────────────────────────────────────────────────

test('detectStage: existing customer → most_aware × retention', async () => {
  const r = await detectStage({ customer_history: { is_existing_customer: true } });
  assert.strictEqual(r.awareness, 'most_aware');
  assert.strictEqual(r.funnel, 'retention');
  assert.ok(r.confidence >= 0.8);
});

test('detectStage: last_purchase_days_ago = 30 → most_aware × retention', async () => {
  const r = await detectStage({ customer_history: { last_purchase_days_ago: 30 } });
  assert.strictEqual(r.awareness, 'most_aware');
  assert.strictEqual(r.funnel, 'retention');
});

test('detectStage: 5 sessions, 0 conversions → product_aware × bofu', async () => {
  const r = await detectStage({ customer_history: { sessions: 5, conversions: 0 } });
  assert.strictEqual(r.awareness, 'product_aware');
  assert.strictEqual(r.funnel, 'bofu');
});

test('detectStage: 1 session, no purchase → solution_aware × mofu (medium confidence)', async () => {
  const r = await detectStage({ customer_history: { sessions: 1, conversions: 0 } });
  assert.strictEqual(r.awareness, 'solution_aware');
  assert.strictEqual(r.funnel, 'mofu');
});

test('detectStage: first-time visitor (0 sessions) → problem_aware × tofu', async () => {
  const r = await detectStage({ customer_history: { sessions: 0 } });
  assert.strictEqual(r.awareness, 'problem_aware');
  assert.strictEqual(r.funnel, 'tofu');
});

// ─── Schwartz signals in current_content ─────────────────────────────────

test('detectStage: strong product_aware content overrides weak heuristic', async () => {
  // Strong product_aware signals in content + weak heuristic
  const content = 'Try our free trial today. Sign up. Get our features now.';
  const r = await detectStage({
    customer_history: { sessions: 1, conversions: 0 }, // → solution_aware (conf 0.5)
    current_content: content,
  });
  // Schwartz should detect product_aware and override since its confidence > 0.5
  assert.strictEqual(r.awareness, 'product_aware');
});

test('detectStage: content with no signals does not override heuristic', async () => {
  const r = await detectStage({
    customer_history: { is_existing_customer: true },
    current_content: 'something boring',
  });
  // Heuristic confidence was 0.9 → wins
  assert.strictEqual(r.awareness, 'most_aware');
});

// ─── LLM probe ────────────────────────────────────────────────────────────

test('detectStage: low-confidence heuristic + callClaude → LLM probe runs', async () => {
  let llmCalled = false;
  const fakeClaude = async () => {
    llmCalled = true;
    return '{"awareness":"solution_aware","funnel":"mofu","confidence":0.85}';
  };
  // 1 session = confidence 0.5 → triggers LLM probe
  const r = await detectStage({
    customer_history: { sessions: 1 },
    callClaude: fakeClaude,
  });
  assert.strictEqual(llmCalled, true);
  assert.strictEqual(r.source, 'llm');
  assert.strictEqual(r.confidence, 0.85);
});

test('detectStage: high-confidence heuristic skips LLM', async () => {
  let llmCalled = false;
  const fakeClaude = async () => {
    llmCalled = true;
    return '';
  };
  await detectStage({
    customer_history: { is_existing_customer: true }, // confidence 0.9
    callClaude: fakeClaude,
  });
  assert.strictEqual(llmCalled, false, 'should not call LLM when heuristic is confident');
});

test('detectStage: LLM throws → falls back to heuristic', async () => {
  const fakeClaude = async () => {
    throw new Error('rate limit');
  };
  const r = await detectStage({
    customer_history: { sessions: 1 },
    callClaude: fakeClaude,
  });
  assert.strictEqual(r.source, 'heuristic');
});

test('detectStage: LLM returns garbage → falls back to heuristic', async () => {
  const fakeClaude = async () => 'not json at all';
  const r = await detectStage({
    customer_history: { sessions: 1 },
    callClaude: fakeClaude,
  });
  assert.strictEqual(r.source, 'heuristic');
});

test('detectStage: LLM returns invalid stage → ignored', async () => {
  const fakeClaude = async () => '{"awareness":"bogus","funnel":"tofu","confidence":0.9}';
  const r = await detectStage({
    customer_history: { sessions: 1 },
    callClaude: fakeClaude,
  });
  // Invalid LLM result is rejected; heuristic kept
  assert.notStrictEqual(r.awareness, 'bogus');
});

// ─── Safe defaults ───────────────────────────────────────────────────────

test('detectStage: nothing supplied → safe default (problem_aware × tofu)', async () => {
  const r = await detectStage({});
  assert.strictEqual(r.awareness, 'problem_aware');
  assert.strictEqual(r.funnel, 'tofu');
});

// ─── detectAndRoute integration ──────────────────────────────────────────

test('detectAndRoute: combines detection + routing', async () => {
  const r = await detectAndRoute({ customer_history: { is_existing_customer: true } });
  assert.ok(r.ok, 'most_aware × retention is a valid cell');
  assert.ok(r.detection);
  assert.strictEqual(r.detection.awareness, 'most_aware');
  assert.strictEqual(r.detection.funnel, 'retention');
});
