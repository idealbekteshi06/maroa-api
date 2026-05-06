'use strict';

const test = require('node:test');
const assert = require('node:assert');

const bv = require('../services/prompts/brand-voice');

// ─── Industry defaults ────────────────────────────────────────────────────

test('industry defaults: cafe gets warm casual voice', () => {
  const d = bv.industryDefaults.defaultsForIndustry('cafe');
  assert.ok(d.tone_descriptors.includes('warm'));
  assert.strictEqual(d.voice_register, 'casual-conversational');
  assert.ok(d.do_words.includes('fresh'));
  assert.ok(d.do_not_words.includes('leverage'));
});

test('industry defaults: dental gets professional reassuring voice', () => {
  const d = bv.industryDefaults.defaultsForIndustry('dental');
  assert.strictEqual(d.formality_level, 7);
  assert.strictEqual(d.humor_level, 1);
  assert.strictEqual(d.voice_register, 'professional');
});

test('industry defaults: SaaS gets practical no-buzzword voice', () => {
  const d = bv.industryDefaults.defaultsForIndustry('saas');
  assert.ok(d.do_not_words.includes('synergy'));
  assert.ok(d.do_not_words.includes('disruptive'));
  assert.ok(d.do_words.includes('ship'));
});

test('industry defaults: fuzzy match (kafja → cafe, palestra → gym)', () => {
  const c = bv.industryDefaults.defaultsForIndustry('kafja shqiptare');
  assert.ok(c.tone_descriptors.includes('warm'));
  const g = bv.industryDefaults.defaultsForIndustry('palestra');
  assert.ok(g.tone_descriptors.includes('motivating') || g.tone_descriptors.includes('direct'));
});

test('industry defaults: unknown industry → generic fallback', () => {
  const f = bv.industryDefaults.defaultsForIndustry('zorglblats');
  assert.ok(f.do_not_words.includes('leverage'));
  assert.strictEqual(f.voice_register, 'professional-conversational');
});

// ─── buildAnchor ──────────────────────────────────────────────────────────

test('buildAnchor: minimal business → low confidence + industry defaults', () => {
  const a = bv.buildAnchor({
    business: { business_name: 'X', industry: 'cafe' },
  });
  assert.strictEqual(a.confidence, 'minimal');
  assert.ok(a.tone_descriptors.includes('warm'));
  assert.ok(a.derived_from.includes('industry-defaults'));
});

test('buildAnchor: onboarding tone_keywords merge with industry defaults', () => {
  const a = bv.buildAnchor({
    business: {
      business_name: 'Cafe Petit',
      industry: 'cafe',
      tone_keywords: ['playful', 'cheeky'],
      primary_language: 'sq',
      operation_model: 'location_based',
    },
  });
  assert.ok(a.tone_descriptors.includes('playful'));
  assert.ok(a.tone_descriptors.includes('cheeky'));
  assert.strictEqual(a.confidence, 'low');
  assert.ok(a.derived_from.includes('onboarding'));
  assert.strictEqual(a.language_primary, 'sq');
});

test('buildAnchor: VOC analysis lifts confidence to high + adds verbatim phrases', () => {
  const voc = {
    id: 'voc-123',
    total_reviews_analyzed: 50,
    pain_points: [
      {
        theme: 'Parking',
        verbatim_quotes: ['parking is hard but coffee is fresh', 'love the espresso every morning'],
      },
    ],
  };
  const a = bv.buildAnchor({
    business: { business_name: 'X', industry: 'cafe', tone_keywords: ['warm'], primary_language: 'en' },
    vocAnalysis: voc,
  });
  assert.strictEqual(a.confidence, 'high');
  assert.ok(a.derived_from.find(s => s.startsWith('voc-analysis')));
  // VOC verbatim phrases extracted into do_words
  const hasVocPhrase = a.do_words.some(w => ['parking', 'fresh', 'espresso', 'morning', 'love'].includes(w));
  assert.ok(hasVocPhrase, `expected VOC phrase in do_words, got: ${a.do_words.join(',')}`);
});

test('buildAnchor: address-as adapts to language + formality', () => {
  const dental = bv.buildAnchor({
    business: { business_name: 'Dr X', industry: 'dental', primary_language: 'de' },
  });
  // dental formality_level = 7 → formal Sie
  assert.match(dental.audience_addresses_as, /Sie \(formal\)/);

  const cafe = bv.buildAnchor({
    business: { business_name: 'Y', industry: 'cafe', primary_language: 'es' },
  });
  // cafe formality = 3 → informal tú
  assert.match(cafe.audience_addresses_as, /tú/);
});

test('buildAnchor: never_do words split + added to do_not_words', () => {
  const a = bv.buildAnchor({
    business: {
      business_name: 'X',
      industry: 'cafe',
      never_do: 'cheap, fast food, gimmicky',
      primary_language: 'en',
    },
  });
  assert.ok(a.do_not_words.includes('cheap'));
  assert.ok(a.do_not_words.includes('fast'));
});

test('buildAnchor: manual overrides win + flag in derived_from', () => {
  const a = bv.buildAnchor({
    business: { business_name: 'X', industry: 'cafe', primary_language: 'en' },
    manualOverrides: { humor_level: 9, voice_register: 'formal' },
  });
  assert.strictEqual(a.humor_level, 9);
  assert.strictEqual(a.voice_register, 'formal');
  assert.ok(a.derived_from.includes('manual-override'));
});

test('buildAnchor: exemplar paragraph in business primary_language', () => {
  const en = bv.buildAnchor({ business: { business_name: 'X', industry: 'cafe', primary_language: 'en', operation_model: 'location_based' } });
  const sq = bv.buildAnchor({ business: { business_name: 'X', industry: 'cafe', primary_language: 'sq', operation_model: 'location_based' } });
  const de = bv.buildAnchor({ business: { business_name: 'X', industry: 'cafe', primary_language: 'de', operation_model: 'location_based' } });
  assert.match(en.exemplar_paragraph, /since 2018/);
  assert.match(sq.exemplar_paragraph, /2018/);
  assert.match(de.exemplar_paragraph, /seit 2018/);
});

// ─── formatAnchorForPrompt ────────────────────────────────────────────────

test('formatAnchorForPrompt: produces compact prompt block with key fields', () => {
  const anchor = bv.buildAnchor({
    business: { business_name: 'Cafe Petit', industry: 'cafe', tone_keywords: ['warm'], primary_language: 'en' },
  });
  const block = bv.formatAnchorForPrompt(anchor);
  assert.match(block, /BRAND VOICE/);
  assert.match(block, /Tone:/);
  assert.match(block, /USE these words/);
  assert.match(block, /AVOID these words/);
  assert.match(block, /Sample of how this brand speaks/);
});

test('formatAnchorForPrompt: low-confidence anchor surfaces NOTE', () => {
  const anchor = bv.buildAnchor({
    business: { business_name: 'X', industry: 'cafe' }, // no onboarding, no VOC
  });
  const block = bv.formatAnchorForPrompt(anchor);
  assert.match(block, /confidence is LOW/i);
});

test('formatAnchorForPrompt: handles null anchor gracefully', () => {
  assert.strictEqual(bv.formatAnchorForPrompt(null), '');
});

// ─── isStale ──────────────────────────────────────────────────────────────

test('isStale: missing regenerated_at returns true', () => {
  assert.strictEqual(bv.isStale(null), true);
  assert.strictEqual(bv.isStale({}), true);
});

test('isStale: fresh anchor returns false', () => {
  const a = bv.buildAnchor({ business: { business_name: 'X', industry: 'cafe' } });
  assert.strictEqual(bv.isStale(a), false);
});

test('isStale: 91-day-old anchor returns true', () => {
  const old = bv.buildAnchor({ business: { business_name: 'X', industry: 'cafe' } });
  old.regenerated_at = new Date(Date.now() - 91 * 86400000).toISOString();
  assert.strictEqual(bv.isStale(old), true);
});

// ─── mergeManualOverrides ─────────────────────────────────────────────────

test('mergeManualOverrides: manual fields win + derived_from updated', () => {
  const auto = bv.buildAnchor({ business: { business_name: 'X', industry: 'cafe' } });
  const merged = bv.mergeManualOverrides(auto, { tone_descriptors: ['edgy', 'punk'] });
  assert.deepStrictEqual(merged.tone_descriptors, ['edgy', 'punk']);
  assert.ok(merged.derived_from.includes('manual-override'));
});
