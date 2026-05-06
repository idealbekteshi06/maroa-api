'use strict';

const test = require('node:test');
const assert = require('node:assert');
const voc = require('../services/prompts/voc');
const cl = voc.clusterer;

// ─── Clusterer ─────────────────────────────────────────────────────────────

test('normalizeReviews: flattens heterogeneous sources to one shape', () => {
  const out = cl.normalizeReviews({
    google: [{ review_id: 'g1', snippet: 'Great coffee in Tirana!', rating: 5, iso_date: '2026-04-01', user: { name: 'John Doe' } }],
    facebook: [{ id: 'f1', recommendation_text: 'Best service ever', recommendation_type: 'positive', created_time: '2026-04-02', reviewer: { name: 'Maria S' } }],
    instagram: [{ id: 'i1', text: 'Loved the latte!', timestamp: '2026-04-03', username: 'fan_123' }],
    email: [{ id: 'e1', body: 'Thanks for the quick reply', received_at: '2026-04-04' }],
  });
  assert.strictEqual(out.length, 4);
  assert.ok(out.every(r => r.text && r.text.length > 0));
  assert.ok(out.every(r => r.lang));
  assert.ok(out.every(r => r.author === 'anonymized' || /\w/.test(r.author)));
});

test('normalizeReviews: drops too-short text', () => {
  const out = cl.normalizeReviews({ google: [{ review_id: 'g1', snippet: 'ok', rating: 5 }] });
  assert.strictEqual(out.length, 0);
});

test('anonymizeAuthor: first name + last initial', () => {
  assert.strictEqual(cl.anonymizeAuthor('John Doe'), 'John D.');
  assert.strictEqual(cl.anonymizeAuthor('Maria Garcia Lopez'), 'Maria L.');
  assert.strictEqual(cl.anonymizeAuthor('Single'), 'Single');
});

test('sentimentBucket: rating overrides text', () => {
  assert.strictEqual(cl.sentimentBucket(5, 'awful'), 'positive');
  assert.strictEqual(cl.sentimentBucket(1, 'great'), 'negative');
  assert.strictEqual(cl.sentimentBucket(3, 'whatever'), 'neutral');
});

test('sentimentBucket: text fallback when no rating', () => {
  assert.strictEqual(cl.sentimentBucket(null, 'I love this place — best coffee ever'), 'positive');
  assert.strictEqual(cl.sentimentBucket(null, 'Terrible service, never again'), 'negative');
});

test('sentimentBucket: multilingual sentiment cues (Albanian + Spanish)', () => {
  assert.strictEqual(cl.sentimentBucket(null, 'Faleminderit, shumë mirë!'), 'positive');
  assert.strictEqual(cl.sentimentBucket(null, 'Gracias, recomiendo'), 'positive');
});

test('dedupeQuotes: removes near-identical quotes (>0.7 Jaccard)', () => {
  const dedup = cl.dedupeQuotes([
    'The coffee here is amazing and the service is great',
    'The coffee here is amazing and the service is great too',
    'Completely different experience, would not recommend',
  ]);
  assert.strictEqual(dedup.length, 2);
});

test('topKeywords: ignores stopwords, returns frequency-sorted', () => {
  const reviews = [
    { text: 'coffee espresso latte coffee great' },
    { text: 'coffee great barista friendly' },
    { text: 'espresso strong delicious' },
  ];
  const k = cl.topKeywords(reviews, 5);
  assert.ok(k.length > 0);
  assert.strictEqual(k[0].word, 'coffee');
  assert.strictEqual(k[0].freq, 3);
  // Stopwords like 'the', 'and' should not appear
  assert.ok(!k.find(x => x.word === 'the'));
});

test('detectCompetitorMentions: counts + extracts contexts', () => {
  const reviews = [
    { text: 'Better than Mojo Cafe, hands down', source: 'google', rating: 5 },
    { text: 'I prefer here over Latte House', source: 'facebook', rating: 4 },
    { text: 'Not as good as Mojo Cafe', source: 'google', rating: 2 },
    { text: 'Great latte', source: 'google', rating: 5 },
  ];
  const m = cl.detectCompetitorMentions(reviews, ['Mojo Cafe', 'Latte House']);
  assert.strictEqual(m.length, 2);
  const mojo = m.find(x => x.competitor === 'Mojo Cafe');
  assert.strictEqual(mojo.frequency, 2);
});

test('sampleForLlm: caps to N with most-recent priority', () => {
  const reviews = Array.from({ length: 100 }, (_, i) => ({
    text: `review ${i}`,
    created_at: new Date(Date.now() - i * 86400000).toISOString(),
  }));
  const sample = cl.sampleForLlm(reviews, 30);
  assert.strictEqual(sample.length, 30);
});

// ─── End-to-end synthesis ──────────────────────────────────────────────────

test('synthesizeVoc: refuses on <5 reviews', async () => {
  let claudeCalled = false;
  const r = await voc.synthesizeVoc({
    business: { business_name: 'X', plan: 'agency' },
    google: [{ review_id: 'g1', snippet: 'great place to be honest' }],
    plan: 'agency',
    callClaude: async () => { claudeCalled = true; return '{}'; },
    extractJSON: JSON.parse,
  });
  assert.strictEqual(claudeCalled, false);
  assert.strictEqual(r.short_circuited, true);
  assert.match(r.short_circuit_reason, /5 reviews/);
});

test('synthesizeVoc: free tier with <20 reviews skips LLM', async () => {
  let claudeCalled = false;
  const reviews = Array.from({ length: 8 }, (_, i) => ({
    review_id: `g${i}`, snippet: `Review ${i} about coffee that is great`, rating: 5,
  }));
  const r = await voc.synthesizeVoc({
    business: { business_name: 'X', plan: 'free' },
    google: reviews,
    plan: 'free',
    callClaude: async () => { claudeCalled = true; return '{}'; },
    extractJSON: JSON.parse,
  });
  assert.strictEqual(claudeCalled, false, 'free tier <20 reviews skips LLM');
  assert.ok(r.caveats.some(c => /Free tier/.test(c)));
});

test('synthesizeVoc: agency tier produces full LLM-merged synthesis', async () => {
  const reviews = Array.from({ length: 30 }, (_, i) => ({
    review_id: `g${i}`,
    snippet: i % 3 === 0 ? 'Best coffee in Tirana, parking is hard though' : 'Great latte and friendly staff',
    rating: i % 5 === 0 ? 3 : 5,
    iso_date: new Date(Date.now() - i * 86400000).toISOString(),
    user: { name: `Customer ${i}` },
  }));
  const r = await voc.synthesizeVoc({
    business: { business_name: 'Cafe Petit', plan: 'agency', location: 'Tirana, Albania' },
    google: reviews,
    plan: 'agency',
    callClaude: async () => JSON.stringify({
      pain_points: [
        { theme: 'Parking is hard', frequency: 10, severity: 'medium', verbatim_quotes: ['parking is hard though'], languages: ['en'] },
      ],
      jtbd_signals: [{ job: 'Quick coffee fix between meetings', evidence_quotes: ['Best coffee in Tirana'] }],
      persona_refinement: { demographics_observed: 'Local professionals', common_use_cases: ['Morning espresso'], vocabulary_clusters: ['parking', 'latte', 'espresso'] },
      competitor_mentions: [],
      recommendations_for_marketing: ['Use phrase "best coffee in Tirana" in next ad headline.'],
      caveats: [],
    }),
    extractJSON: JSON.parse,
  });
  assert.strictEqual(r.short_circuited, false);
  assert.strictEqual(r.data_quality, 'limited'); // 30 reviews
  assert.strictEqual(r.primary_language, 'sq');  // Tirana → Albanian
  assert.ok(r.pain_points.length > 0);
  assert.ok(r.recommendations_for_marketing.length > 0);
  assert.ok(r.sentiment);
});

test('synthesizeVoc: handles malformed LLM output gracefully', async () => {
  const reviews = Array.from({ length: 25 }, (_, i) => ({
    review_id: `g${i}`, snippet: 'Coffee is great here in this lovely cafe', rating: 4,
  }));
  const r = await voc.synthesizeVoc({
    business: { business_name: 'X', plan: 'growth' },
    google: reviews,
    plan: 'growth',
    callClaude: async () => 'not valid json at all',
    extractJSON: (s) => { throw new Error('parse error'); },
  });
  assert.strictEqual(r.short_circuited, false);
  assert.ok(r.caveats.some(c => /LLM/i.test(c)));
});
