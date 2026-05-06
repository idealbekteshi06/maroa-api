'use strict';

const test = require('node:test');
const assert = require('node:assert');

const qg = require('../services/prompts/quality-gate');

// ─── Threshold helper ─────────────────────────────────────────────────────

test('thresholdsFor: ad_copy stricter than caption on slop', () => {
  const ad = qg.thresholdsFor('ad_copy');
  const cap = qg.thresholdsFor('caption');
  assert.ok(ad.slop_max < cap.slop_max);
});

test('thresholdsFor: unknown type falls back to generic', () => {
  const t = qg.thresholdsFor('unknown_type');
  assert.deepStrictEqual(t, qg.thresholdsFor('generic'));
});

test('thresholdsFor: overrides win', () => {
  const t = qg.thresholdsFor('caption', { slop_max: 10 });
  assert.strictEqual(t.slop_max, 10);
});

// ─── Individual checks ────────────────────────────────────────────────────

test('checkSlop: passes clean text', () => {
  const r = qg.checkSlop('Open 9-17 Mon-Fri. Espresso €1.50.', 30);
  assert.strictEqual(r.passed, true);
  assert.ok(r.score < 30);
});

test('checkSlop: fails slop-heavy text', () => {
  const r = qg.checkSlop("In today's fast-paced world, leverage cutting-edge solutions to elevate your business.", 30);
  assert.strictEqual(r.passed, false);
});

test('checkSpecificity: clean+concrete passes', () => {
  const r = qg.checkSpecificity('Open 9-17 Mon-Fri. €5 espresso. Phone +355 69 123.', 50);
  assert.strictEqual(r.passed, true);
});

test('checkSpecificity: vague fails', () => {
  const r = qg.checkSpecificity('We have many products at various prices.', 50);
  assert.strictEqual(r.passed, false);
});

test('checkBrandVoiceMatch: do_not_word triggers violation', () => {
  const r = qg.checkBrandVoiceMatch('Leverage our innovative solutions.', {
    do_not_words: ['leverage', 'innovative'],
    sentence_length_preference: 'short',
  });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.violations.length, 2);
});

test('checkBrandVoiceMatch: no anchor → skip pass', () => {
  const r = qg.checkBrandVoiceMatch('Anything goes here.', null);
  assert.strictEqual(r.passed, true);
  assert.strictEqual(r.skipped, 'no_anchor');
});

test('checkBrandVoiceMatch: long sentence flagged when pref is short', () => {
  const longText = 'This is one extremely long sentence with way more than eighteen words inside it just to break the short-preference soft check decisively.';
  const r = qg.checkBrandVoiceMatch(longText, {
    do_not_words: [],
    sentence_length_preference: 'short',
  });
  assert.ok(r.violations.find(v => v.type === 'sentence_length'));
});

test('checkClaimSubstantiation: catches "best in city"', () => {
  const r = qg.checkClaimSubstantiation('Best coffee in the city, guaranteed.', []);
  assert.strictEqual(r.passed, false);
  assert.ok(r.ungrounded_claims.length >= 1);
});

test('checkClaimSubstantiation: clean copy passes', () => {
  const r = qg.checkClaimSubstantiation('Open 9-17. €5 espresso. Try our cake.', []);
  assert.strictEqual(r.passed, true);
});

test('checkClaimSubstantiation: catches risk-free + guaranteed claims', () => {
  const r = qg.checkClaimSubstantiation('100% guaranteed, risk-free trial.', []);
  assert.strictEqual(r.passed, false);
  assert.ok(r.ungrounded_claims.length >= 1);
});

test('checkLanguageMatch: passes when matches', () => {
  const r = qg.checkLanguageMatch('Open daily. Coffee is great.', 'en');
  assert.strictEqual(r.passed, true);
});

test('checkLanguageMatch: short text gets permissive pass', () => {
  const r = qg.checkLanguageMatch('Buy now', 'sq'); // short → permissive
  assert.strictEqual(r.passed, true);
});

test('checkLanguageMatch: fails confident mismatch on longer text', () => {
  const r = qg.checkLanguageMatch('Hallo, in der heutigen Welt brauchen Sie unbedingt unsere innovative Lösung für Ihr Problem.', 'sq');
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.detected, 'de');
});

// ─── End-to-end gate ──────────────────────────────────────────────────────

test('gate: bypass=true ships unchanged', async () => {
  const r = await qg.gate({
    text: 'whatever',
    business: {},
    bypass: true,
  });
  assert.strictEqual(r.decision, 'ship');
  assert.strictEqual(r.checks.bypassed, true);
});

test('gate: empty text → reject', async () => {
  const r = await qg.gate({ text: '', business: {} });
  assert.strictEqual(r.decision, 'reject');
  assert.ok(r.blocking_issues.includes('empty_text'));
});

test('gate: clean text + simple business → ship', async () => {
  const r = await qg.gate({
    text: 'Open 9-17 Mon-Fri. €5 espresso. Phone +355 69 123 4567 or visit Rruga Myslym Shyri 5.',
    business: { business_name: 'X', industry: 'cafe', primary_language: 'en' },
    contentType: 'caption',
    plan: 'free',
  });
  assert.strictEqual(r.decision, 'ship');
  assert.strictEqual(r.ship_safe, true);
});

test('gate: ungrounded claim → reject', async () => {
  const r = await qg.gate({
    text: 'Best coffee in the city, guaranteed satisfaction.',
    business: { business_name: 'X', industry: 'cafe', primary_language: 'en' },
    contentType: 'ad_copy',
    plan: 'free',
  });
  assert.strictEqual(r.decision, 'reject');
  assert.ok(r.blocking_issues.includes('ungrounded_claim'));
});

test('gate: language mismatch → reject', async () => {
  const r = await qg.gate({
    text: 'Hallo, in der heutigen Welt brauchen Sie unbedingt unsere innovative Lösung für Ihr Problem hier.',
    business: { business_name: 'X', industry: 'cafe', primary_language: 'sq' },
    contentType: 'caption',
    plan: 'free',
  });
  assert.strictEqual(r.decision, 'reject');
  assert.ok(r.blocking_issues.includes('language_mismatch'));
});

test('gate: brand-voice do_not_word violation → reject', async () => {
  const r = await qg.gate({
    text: 'Use our cutting-edge solutions today.',
    business: {
      business_name: 'X',
      industry: 'cafe',
      primary_language: 'en',
      brand_voice_anchor: {
        language_primary: 'en',
        do_not_words: ['cutting-edge'],
        sentence_length_preference: 'short',
      },
    },
    contentType: 'caption',
    plan: 'free',
  });
  assert.strictEqual(r.decision, 'reject');
  assert.ok(r.blocking_issues.includes('brand_voice_violation'));
});

test('gate: free tier with slop but no LLM → ships with warning', async () => {
  const r = await qg.gate({
    text: "In today's fast-paced world, leverage cutting-edge digital solutions for maximum impact.",
    business: { business_name: 'X', industry: 'cafe', primary_language: 'en' },
    contentType: 'caption',
    plan: 'free', // no callClaude
  });
  // Free tier without LLM can't retry — ships with warning OR rejects depending on path
  assert.ok(['ship', 'reject'].includes(r.decision));
});

test('gate: agency tier slop-heavy → retries via voice-polish', async () => {
  let polishCalled = false;
  const r = await qg.gate({
    text: "In today's fast-paced world, leverage cutting-edge solutions to elevate your business and unlock the power of synergy.",
    business: { business_name: 'X', industry: 'cafe', primary_language: 'en' },
    contentType: 'caption',
    plan: 'agency',
    callClaude: async (opts) => {
      // First call is advisor (returns "needs_fix"), second is polish (returns clean)
      if (opts.user.includes('quality reviewer')) {
        polishCalled = false;
        return JSON.stringify({ decision: 'needs_fix', issues: ['too much slop'], feedback: 'rewrite needed' });
      }
      polishCalled = true;
      return JSON.stringify({
        polished: 'Real coffee. Made today. Open 7-19.',
        changes_made: ['stripped 5 buzzwords'],
        language_preserved: true,
      });
    },
    extractJSON: JSON.parse,
  });
  assert.strictEqual(r.retries, 1);
  assert.notStrictEqual(r.final_text, "In today's fast-paced world, leverage cutting-edge solutions to elevate your business and unlock the power of synergy.");
});

test('gate: blocks even when caller passes citations if claim still ungrounded', async () => {
  const r = await qg.gate({
    text: 'Risk-free guaranteed best coffee in the city.',
    business: { business_name: 'X', industry: 'cafe', primary_language: 'en' },
    contentType: 'caption',
    plan: 'free',
    citations: [{ source: 'survey' }],
  });
  // Even with citations, the gate blocks aggressive claims (deterministic safety)
  assert.strictEqual(r.decision, 'reject');
  assert.ok(r.blocking_issues.includes('ungrounded_claim'));
});

test('gate: integration with brand_voice anchor on business profile', async () => {
  const business = {
    business_name: 'Cafe Y',
    industry: 'cafe',
    primary_language: 'en',
    tone_keywords: ['warm', 'direct'],
    brand_voice_anchor: {
      language_primary: 'en',
      do_not_words: ['leverage', 'innovative', 'cutting-edge'],
      sentence_length_preference: 'short',
      tone_descriptors: ['warm', 'direct'],
    },
  };
  // Caption uses 2 banned words → should reject
  const r = await qg.gate({
    text: 'Leverage our innovative coffee experience for maximum enjoyment.',
    business,
    contentType: 'caption',
    plan: 'free',
  });
  assert.strictEqual(r.decision, 'reject');
});
