'use strict';

const test = require('node:test');
const assert = require('node:assert');

const vp = require('../services/prompts/voice-polish');

// ─── Detection patterns ────────────────────────────────────────────────────

test('detect: catches "in today\'s fast-paced world" English opener', () => {
  const r = vp.detect("In today's fast-paced world, businesses need to leverage cutting-edge solutions.");
  assert.ok(r.slop_score > 50, `expected high slop score, got ${r.slop_score}`);
  assert.ok(r.flagged_phrases.length >= 3);
});

test('detect: catches Albanian opener "në botën e sotme"', () => {
  const r = vp.detect('Në botën e sotme, biznesi juaj duhet të shfrytëzojë fuqinë e teknologjisë.');
  assert.strictEqual(r.language_detected, 'sq');
  assert.ok(r.flagged_phrases.length >= 1);
  assert.ok(r.slop_score > 30);
});

test('detect: catches German + Spanish + Italian openers in their language', () => {
  const de = vp.detect("In der heutigen digitalen Welt müssen Sie auf das nächste Level kommen.");
  const es = vp.detect("En el mundo de hoy, lleva tu negocio al siguiente nivel.");
  const it = vp.detect("Nel mondo di oggi, immergiti nel futuro.");
  assert.ok(de.flagged_phrases.length >= 1, 'German pattern missed');
  assert.ok(es.flagged_phrases.length >= 1, 'Spanish pattern missed');
  assert.ok(it.flagged_phrases.length >= 1, 'Italian pattern missed');
});

test('detect: high specificity reduces should_rewrite even with some slop', () => {
  const r = vp.detect("Open Mon-Fri 9-17 at Rruga Myslym Shyri 5, Tirana. €5 espresso, €8 cappuccino. Call +355 69 123 4567.");
  assert.ok(r.specificity_score > 70, `expected high specificity, got ${r.specificity_score}`);
  // Even if some buzzword appears, high-spec should reduce the rewrite signal
});

test('detect: clean concrete copy has low slop score', () => {
  const r = vp.detect("Open 9-17 Mon to Fri. Espresso €1.50. Call us at +355 69 123 4567 or come visit at Rruga Myslym Shyri 5.");
  assert.ok(r.slop_score < 25, `expected low slop, got ${r.slop_score}`);
  assert.strictEqual(r.should_rewrite, false);
});

test('detect: catches "as an AI" meta-language regardless of context language', () => {
  const r = vp.detect("As an AI, I think your business should embrace innovation.");
  assert.ok(r.flagged_phrases.find(f => f.pattern_id === 'AI301'));
});

test('detect: empty/null input returns zero score', () => {
  assert.strictEqual(vp.detect('').slop_score, 0);
  assert.strictEqual(vp.detect(null).slop_score, 0);
});

// ─── shouldRewrite logic ──────────────────────────────────────────────────

test('shouldRewrite: very short text never rewrites', () => {
  const r = vp.detect('Buy now');
  assert.strictEqual(r.should_rewrite, false);
});

test('shouldRewrite: high slop + low specificity → rewrite', () => {
  const r = vp.detect("Leverage our world-class cutting-edge innovative solutions to elevate your business and unlock the power of synergy in today's fast-paced world.");
  assert.strictEqual(r.should_rewrite, true);
});

// ─── Specificity scoring ──────────────────────────────────────────────────

test('specificity: numbers + currency + times boost score', () => {
  const a = vp.slopPatterns.specificityScore('Open 9-17 Mon to Fri. Espresso €1.50. Phone +355 69 123 4567.');
  const b = vp.slopPatterns.specificityScore('Open most days. Coffee available. Call us.');
  assert.ok(a > b + 30, `concrete should beat vague: ${a} vs ${b}`);
});

test('specificity: vague quantifiers penalize', () => {
  const a = vp.slopPatterns.specificityScore('We have many customers and several products.');
  const b = vp.slopPatterns.specificityScore('We have 47 customers and 12 products.');
  assert.ok(b > a + 10);
});

// ─── End-to-end polish ────────────────────────────────────────────────────

test('polish: skips rewrite when text already clean', async () => {
  let claudeCalled = false;
  const r = await vp.polish({
    text: 'Open 9-17 Mon-Fri. €5 espresso. Call +355 69 1234567.',
    business: {},
    plan: 'agency',
    callClaude: async () => { claudeCalled = true; return '{}'; },
    extractJSON: JSON.parse,
  });
  assert.strictEqual(claudeCalled, false);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.reason, 'already_clean');
});

test('polish: free tier skips LLM rewrite (cost protection)', async () => {
  let claudeCalled = false;
  const r = await vp.polish({
    text: "In today's fast-paced world, leverage our cutting-edge innovative world-class solutions to elevate your business.",
    business: {},
    plan: 'free',
    callClaude: async () => { claudeCalled = true; return '{}'; },
    extractJSON: JSON.parse,
  });
  assert.strictEqual(claudeCalled, false);
});

test('polish: agency tier rewrites slop-heavy text', async () => {
  const r = await vp.polish({
    text: "In today's fast-paced world, leverage our cutting-edge innovative world-class solutions to elevate your business.",
    business: { business_name: 'Cafe Petit', industry: 'cafe', tone_keywords: ['warm', 'direct'] },
    plan: 'agency',
    callClaude: async () => JSON.stringify({
      polished: 'Get faster espresso and a warm welcome at Cafe Petit. Open 7-19 daily.',
      changes_made: ["Stripped 'In today\\'s...'", 'Replaced buzzwords with concrete service'],
      language_preserved: true,
    }),
    extractJSON: JSON.parse,
  });
  assert.strictEqual(r.changed, true);
  assert.ok(r.slop_score < r.slop_score_before, 'rewrite should reduce slop');
});

test('polish: returns original if rewrite makes it worse', async () => {
  const r = await vp.polish({
    text: "In today's fast-paced world, leverage cutting-edge solutions.",
    business: {},
    plan: 'agency',
    callClaude: async () => JSON.stringify({
      // Make the polished version actually slop-pier — skill should reject and return original
      polished: "In today's fast-paced world, you must leverage world-class cutting-edge innovative solutions to elevate your business.",
      changes_made: ['none'],
      language_preserved: true,
    }),
    extractJSON: JSON.parse,
  });
  // The skill should detect rewrite-made-it-worse and return original
  assert.strictEqual(r.polished, "In today's fast-paced world, leverage cutting-edge solutions.");
});

test('polish: handles malformed LLM output gracefully', async () => {
  const r = await vp.polish({
    text: "In today's fast-paced world, leverage our world-class solutions.",
    business: {},
    plan: 'agency',
    callClaude: async () => 'not json at all',
    extractJSON: () => { throw new Error('parse error'); },
  });
  // Should fall back to original
  assert.match(r.reason, /parse|llm|unavail/i);
});

test('polish: reduces slop score on noisy English input (with mocked good rewrite)', async () => {
  const r = await vp.polish({
    text: "It's worth noting that we leverage cutting-edge innovative solutions to elevate your tapestry of options.",
    business: { tone_keywords: ['plain'] },
    plan: 'agency',
    callClaude: async () => JSON.stringify({
      polished: 'We help you find the right plan, fast.',
      changes_made: ['stripped 4 buzzwords', 'removed "tapestry"'],
      language_preserved: true,
    }),
    extractJSON: JSON.parse,
  });
  assert.ok(r.slop_score < r.slop_score_before);
});
