'use strict';

const test = require('node:test');
const assert = require('node:assert');

const classifier = require('../services/public-pretrainer/classifier');
const qualityScorer = require('../services/public-pretrainer/quality-scorer');

// ─── classifier.parseClassifierOutput ─────────────────────────────────────

test('parseClassifierOutput: parses well-formed JSON', () => {
  const out = classifier.parseClassifierOutput(
    '{"industry":"cafe","format":"meta_ad","language":"en","confidence":0.85}'
  );
  assert.strictEqual(out.industry, 'cafe');
});

test('parseClassifierOutput: strips markdown fences', () => {
  const out = classifier.parseClassifierOutput(
    '```json\n{"industry":"gym_fitness","format":"meta_ad","confidence":0.9}\n```'
  );
  assert.strictEqual(out.industry, 'gym_fitness');
});

test('parseClassifierOutput: returns null on garbage', () => {
  assert.strictEqual(classifier.parseClassifierOutput('not json'), null);
  assert.strictEqual(classifier.parseClassifierOutput(''), null);
  assert.strictEqual(classifier.parseClassifierOutput(null), null);
});

// ─── classifier.classify ──────────────────────────────────────────────────

test('classifier.classify: throws without callClaude', async () => {
  await assert.rejects(classifier.classify({ row: { body: 'x' } }), /callClaude required/);
});

test('classifier.classify: returns null on empty body', async () => {
  const r = await classifier.classify({ callClaude: async () => '', row: { body: '' } });
  assert.strictEqual(r, null);
});

test('classifier.classify: returns parsed classification on success', async () => {
  const fakeClaude = async () =>
    '{"industry":"cafe","format":"meta_ad","language":"en","confidence":0.9,"notes":"clear cafe ad"}';
  const r = await classifier.classify({
    callClaude: fakeClaude,
    row: { body: 'Best espresso in town', page_name: 'Blue Bottle' },
  });
  assert.strictEqual(r.industry, 'cafe');
  assert.strictEqual(r.format, 'meta_ad');
  assert.strictEqual(r.confidence, 0.9);
});

test('classifier.classify: snaps unknown industry to smb_general', async () => {
  const fakeClaude = async () => '{"industry":"made_up_industry","format":"meta_ad","confidence":0.8}';
  const r = await classifier.classify({
    callClaude: fakeClaude,
    row: { body: 'some marketing copy' },
  });
  assert.strictEqual(r.industry, 'smb_general');
  // Confidence penalized for the snap
  assert.ok(r.confidence < 0.8);
});

test('classifier.classify: falls back gracefully when callClaude throws', async () => {
  const fakeClaude = async () => {
    throw new Error('rate limited');
  };
  const r = await classifier.classify({
    callClaude: fakeClaude,
    row: { body: 'x' },
    formatHint: 'email',
  });
  assert.strictEqual(r.industry, 'smb_general');
  assert.strictEqual(r.format, 'email');
  assert.strictEqual(r.confidence, 0);
});

test('classifier.classify: malformed JSON falls back to smb_general', async () => {
  const r = await classifier.classify({
    callClaude: async () => 'this is not json',
    row: { body: 'x' },
    formatHint: 'meta_ad',
  });
  assert.strictEqual(r.industry, 'smb_general');
  assert.strictEqual(r.confidence, 0);
});

// ─── quality-scorer ────────────────────────────────────────────────────────

test('quality-scorer: returns FLOOR for invalid row', () => {
  const { qualityScore } = qualityScorer.score(null);
  assert.strictEqual(qualityScore, qualityScorer.FLOOR);
});

test('quality-scorer: long-running ads score higher', () => {
  const baseRow = { body: 'A clear, specific ad with concrete value prop' };
  const longRun = qualityScorer.score({ ...baseRow, runtime_days: 120 });
  const shortRun = qualityScorer.score({ ...baseRow, runtime_days: 5 });
  assert.ok(longRun.qualityScore > shortRun.qualityScore, 'long-running should score higher');
});

test('quality-scorer: specificity (real numbers) lifts score', () => {
  const generic = qualityScorer.score({ body: 'A great product for everyone' });
  const specific = qualityScorer.score({
    body: 'Used by 12,847 founders. Saved them 6 hours/week. $19/mo.',
  });
  assert.ok(specific.qualityScore > generic.qualityScore);
});

test('quality-scorer: AI-tell phrases reduce score', () => {
  const clean = qualityScorer.score({
    body: 'Get the new shoes that runners actually wear during marathon training',
  });
  const tellHeavy = qualityScorer.score({
    body: 'Revolutionize your workflow by leveraging cutting-edge AI to seamlessly unlock potential',
  });
  assert.ok(clean.qualityScore >= tellHeavy.qualityScore);
});

test('quality-scorer: brand-curated lookup boosts score', () => {
  const expertBrandsLookup = [{ name: 'Starbucks', qualityScore: 0.85 }];
  const branded = qualityScorer.score({ body: 'A new fall menu', page_name: 'Starbucks' }, { expertBrandsLookup });
  const unbranded = qualityScorer.score({
    body: 'A new fall menu',
    page_name: 'Random Local Spot',
  });
  assert.ok(branded.qualityScore > unbranded.qualityScore);
});

test('quality-scorer: review rating contributes to score', () => {
  const fiveStar = qualityScorer.score({ body: 'Loved this place', rating: 5 });
  const twoStar = qualityScorer.score({ body: 'Was disappointed', rating: 2 });
  assert.ok(fiveStar.qualityScore > twoStar.qualityScore);
});

test('quality-scorer: scores are clamped to [FLOOR, CEIL]', () => {
  // Stack all signals high
  const r = qualityScorer.score(
    {
      body: 'Used by 12,847 founders. Saved 6 hours/week. $19/mo. 50% off limited time',
      page_name: 'Starbucks',
      runtime_days: 365,
      rating: 5,
      source: 'manual_curation',
    },
    { expertBrandsLookup: [{ name: 'Starbucks', qualityScore: 0.95 }] }
  );
  assert.ok(r.qualityScore <= qualityScorer.CEIL);
  assert.ok(r.qualityScore >= qualityScorer.FLOOR);
});

test('quality-scorer: signals object is populated', () => {
  const r = qualityScorer.score({
    body: 'great body 1000+ users',
    runtime_days: 90,
    source: 'meta_ad_library',
  });
  assert.ok(r.signals);
  assert.ok(typeof r.signals.runtime === 'number');
  assert.ok(typeof r.signals.content === 'number');
});

test('quality-scorer: toOutcomeLabel maps to high/medium/low', () => {
  assert.strictEqual(qualityScorer.toOutcomeLabel(0.85), 'high');
  assert.strictEqual(qualityScorer.toOutcomeLabel(0.6), 'medium');
  assert.strictEqual(qualityScorer.toOutcomeLabel(0.3), 'low');
});
