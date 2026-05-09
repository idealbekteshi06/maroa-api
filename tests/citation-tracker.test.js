'use strict';

const test = require('node:test');
const assert = require('node:assert');

const tracker = require('../services/citation-tracker');

// ─── buildSeedPrompts ─────────────────────────────────────────────────────

test('citation-tracker: buildSeedPrompts produces ~18 prompts', () => {
  const prompts = tracker.buildSeedPrompts({
    business: {
      business_name: 'Acme Dental Clinic',
      industry: 'dental clinic',
      location: 'Austin TX',
      competitors: ['Best Smile', 'Smile Co'],
    },
  });
  assert.ok(prompts.length >= 12);
  assert.ok(prompts.length <= tracker.PROMPTS_PER_BUSINESS);
});

test('citation-tracker: buildSeedPrompts includes location-aware queries', () => {
  const prompts = tracker.buildSeedPrompts({
    business: {
      business_name: 'Acme Plumbing',
      industry: 'plumber',
      location: 'Denver',
      competitors: [],
    },
  });
  assert.ok(prompts.some((p) => p.prompt_text.includes('Denver')));
  assert.ok(prompts.some((p) => p.prompt_intent === 'local_search'));
});

test('citation-tracker: buildSeedPrompts includes vs prompts when competitors set', () => {
  const prompts = tracker.buildSeedPrompts({
    business: {
      business_name: 'BrandX',
      industry: 'saas b2b',
      competitors: ['CompetitorA', 'CompetitorB'],
    },
  });
  assert.ok(prompts.some((p) => p.prompt_text.includes('vs CompetitorA')));
  assert.ok(prompts.some((p) => p.prompt_intent === 'vs'));
});

test('citation-tracker: buildSeedPrompts includes industry-specific intents (dental)', () => {
  const prompts = tracker.buildSeedPrompts({
    business: { business_name: 'X', industry: 'dental clinic', competitors: [] },
  });
  assert.ok(prompts.some((p) => /insurance|questions/i.test(p.prompt_text)));
});

test('citation-tracker: buildSeedPrompts includes industry-specific intents (saas)', () => {
  const prompts = tracker.buildSeedPrompts({
    business: { business_name: 'X', industry: 'saas b2b', competitors: [] },
  });
  assert.ok(prompts.some((p) => p.prompt_text.includes('2026') || p.prompt_text.includes('platform')));
});

test('citation-tracker: buildSeedPrompts handles missing inputs gracefully', () => {
  const prompts = tracker.buildSeedPrompts({ business: { industry: '' } });
  assert.ok(Array.isArray(prompts));
  assert.ok(prompts.length > 0);
});

// ─── parseCitationResult ─────────────────────────────────────────────────

test('parseCitationResult: brand cited via URL host match', () => {
  const r = tracker.parseCitationResult({
    responseText: 'Some response.',
    citedUrls: ['https://nytimes.com', 'https://acmedental.com/about', 'https://wikipedia.org'],
    competitorNames: [],
    brandName: 'Acme Dental',
    brandUrl: 'https://acmedental.com',
  });
  assert.strictEqual(r.brand_cited, true);
  assert.strictEqual(r.brand_position, 2);
  assert.strictEqual(r.brand_url_cited, 'https://acmedental.com/about');
});

test('parseCitationResult: brand cited via mention-only when not in URLs', () => {
  const r = tracker.parseCitationResult({
    responseText: 'I would recommend Acme Dental for your needs.',
    citedUrls: ['https://nytimes.com', 'https://wikipedia.org'],
    competitorNames: [],
    brandName: 'Acme Dental',
    brandUrl: null,
  });
  assert.strictEqual(r.brand_cited, true);
  assert.strictEqual(r.brand_position, null);
});

test('parseCitationResult: brand NOT cited when neither URL nor text mentions it', () => {
  const r = tracker.parseCitationResult({
    responseText: 'Some other dentists exist.',
    citedUrls: ['https://nytimes.com'],
    competitorNames: [],
    brandName: 'Acme Dental',
    brandUrl: 'https://acmedental.com',
  });
  assert.strictEqual(r.brand_cited, false);
});

test('parseCitationResult: detects competitor citations', () => {
  const r = tracker.parseCitationResult({
    responseText: 'Some answer.',
    citedUrls: ['https://acmedental.com', 'https://bestsmile.com/services'],
    competitorNames: ['Best Smile', 'Pearly Whites'],   // distinct, no substring overlap
    brandName: 'Acme Dental',
    brandUrl: 'https://acmedental.com',
  });
  assert.strictEqual(r.brand_cited, true);
  assert.strictEqual(r.competitor_citations.length, 1);
  assert.strictEqual(r.competitor_citations[0].name, 'Best Smile');
});

test('parseCitationResult: handles empty citedUrls gracefully', () => {
  const r = tracker.parseCitationResult({
    responseText: '',
    citedUrls: null,
    competitorNames: [],
    brandName: 'X',
    brandUrl: null,
  });
  assert.strictEqual(r.brand_cited, false);
  assert.deepStrictEqual(r.cited_urls, []);
});

// ─── computeShareOfVoice + detectCitationGaps (with mocked sbGet) ────────

test('computeShareOfVoice: empty data returns 0 share', async () => {
  const deps = { sbGet: async () => [] };
  const r = await tracker.computeShareOfVoice({ businessId: 'b1', days: 7, deps });
  assert.strictEqual(r.runs, 0);
  assert.strictEqual(r.brand_cite_rate, 0);
});

test('computeShareOfVoice: computes brand share correctly', async () => {
  // 10 runs, brand cited 4 times, competitor X cited 6 times
  const rows = [];
  for (let i = 0; i < 10; i += 1) {
    rows.push({
      brand_cited: i < 4,
      competitor_citations: i >= 4 ? [{ name: 'CompetitorX', position: 1 }] : [],
    });
  }
  const deps = { sbGet: async () => rows };
  const r = await tracker.computeShareOfVoice({ businessId: 'b1', days: 7, deps });
  assert.strictEqual(r.runs, 10);
  assert.strictEqual(Math.round(r.brand_cite_rate * 100), 40);
  assert.strictEqual(Math.round(r.share_of_voice.brand * 100), 40);
  assert.strictEqual(Math.round(r.share_of_voice.CompetitorX * 100), 60);
});

test('detectCitationGaps: returns prompts where only competitors got cited', async () => {
  const rows = [
    { prompt_text: 'A', engine: 'chatgpt', competitor_citations: [{ name: 'C1' }], observed_at: '2026-05-01' },
    { prompt_text: 'B', engine: 'perplexity', competitor_citations: [], observed_at: '2026-05-01' },
    { prompt_text: 'C', engine: 'chatgpt', competitor_citations: [{ name: 'C2' }, { name: 'C3' }], observed_at: '2026-05-01' },
  ];
  const deps = { sbGet: async () => rows };
  const r = await tracker.detectCitationGaps({ businessId: 'b1', days: 7, deps });
  assert.strictEqual(r.gap_count, 2);
  assert.strictEqual(r.gaps.length, 2);
  assert.deepStrictEqual(r.gaps.map((g) => g.prompt_text), ['A', 'C']);
});

test('citation-tracker: free tier is plan-gated out', async () => {
  const deps = {
    sbGet: async (table) => {
      if (table === 'businesses') return [{ business_name: 'X', plan: 'free' }];
      return [];
    },
    sbPost: async () => {},
    logger: { warn: () => {} },
  };
  const r = await tracker.runDailyForBusiness({ businessId: 'b1', deps });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ran, 0);
  assert.ok(/not eligible/.test(r.reason));
});
