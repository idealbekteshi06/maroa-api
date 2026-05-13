'use strict';

const test = require('node:test');
const assert = require('node:assert');

const orchestrator = require('../services/voc-scraper/orchestrator');

test('orchestrator: requires businessId + callClaude + sbPost', async () => {
  assert.deepStrictEqual(await orchestrator.runForBusiness({}), { ok: false, reason: 'businessId required' });
  assert.deepStrictEqual(await orchestrator.runForBusiness({ businessId: 'biz1' }), {
    ok: false,
    reason: 'callClaude + sbPost required',
  });
});

test('orchestrator: ignores unknown source names', async () => {
  const r = await orchestrator.runForBusiness({
    businessId: 'biz1',
    sources: { not_a_source: { x: 1 }, also_fake: {} },
    deps: { callClaude: async () => '', sbPost: async () => ({}) },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.totalReviewsFetched, 0);
  assert.strictEqual(Object.keys(r.sources).length, 0);
});

test('orchestrator: dedupes reviews from multiple sources', async () => {
  // Monkey-patch source registry temporarily
  const orig = orchestrator.SOURCE_REGISTRY.manual;
  let callIndex = 0;
  orchestrator.SOURCE_REGISTRY.manual = () => ({
    fetch: async () => {
      callIndex++;
      // Return the same review from both calls — should be deduped
      return {
        ok: true,
        source: 'manual',
        reviews: [
          { text: 'Best espresso ever', rating: 5 },
          { text: 'Best espresso ever', rating: 5 }, // duplicate
        ],
      };
    },
  });

  const claudeCalls = [];
  const fakeClaude = async (args) => {
    claudeCalls.push(args);
    return '{"love_phrases":["best espresso ever"],"pain_phrases":[],"competitor_complaints":[],"jtbd_phrases":[],"trigger_events":[]}';
  };
  const inserts = [];
  const sbPost = async (t, row) => {
    inserts.push({ t, row });
    return { ok: true };
  };

  const r = await orchestrator.runForBusiness({
    businessId: 'biz1',
    sources: { manual: { reviewsText: 'pasted reviews' } },
    deps: { callClaude: fakeClaude, sbPost },
  });
  assert.strictEqual(r.ok, true);
  // Dedup should collapse the 2 identical reviews to 1
  assert.strictEqual(r.totalReviewsFetched, 1);

  // Restore
  orchestrator.SOURCE_REGISTRY.manual = orig;
});

test('orchestrator: fetches competitor reviews and filters to 1-2 stars', async () => {
  // Stub a competitor source that returns mixed ratings
  const origManual = orchestrator.SOURCE_REGISTRY.manual;
  orchestrator.SOURCE_REGISTRY.manual = () => ({
    fetch: async (params) => {
      if (params?.label === 'competitor') {
        return {
          ok: true,
          source: 'manual',
          reviews: [
            { text: 'competitor 1-star: app crashed', rating: 1 },
            { text: 'competitor 5-star: actually good', rating: 5 }, // should be filtered out
            { text: 'competitor unknown rating', rating: null }, // null rating is kept
          ],
        };
      }
      return { ok: true, source: 'manual', reviews: [{ text: 'own 5-star: love it', rating: 5 }] };
    },
  });

  let capturedCompText;
  const fakeClaude = async (args) => {
    if (args.user && args.user.includes('COMPETITOR REVIEWS')) {
      capturedCompText = args.user;
    }
    return '{"love_phrases":[],"pain_phrases":[],"competitor_complaints":["app crashed"],"jtbd_phrases":[],"trigger_events":[]}';
  };

  const r = await orchestrator.runForBusiness({
    businessId: 'biz1',
    sources: { manual: { reviewsText: 'own reviews' } },
    competitor: { manual: { reviewsText: 'comp reviews', label: 'competitor' } },
    deps: { callClaude: fakeClaude, sbPost: async () => ({}) },
  });

  assert.strictEqual(r.ok, true);
  assert.ok(capturedCompText, 'competitor reviews should reach Claude');
  assert.match(capturedCompText, /app crashed/);
  assert.ok(!capturedCompText.includes('actually good'), '5-star competitor review must be filtered out');

  orchestrator.SOURCE_REGISTRY.manual = origManual;
});

test('orchestrator: source that throws does not break the run', async () => {
  const origGoogle = orchestrator.SOURCE_REGISTRY.google_places;
  const origManual = orchestrator.SOURCE_REGISTRY.manual;
  orchestrator.SOURCE_REGISTRY.google_places = () => ({
    fetch: async () => {
      throw new Error('Google API exploded');
    },
  });
  orchestrator.SOURCE_REGISTRY.manual = () => ({
    fetch: async () => ({ ok: true, source: 'manual', reviews: [{ text: 'still works', rating: 5 }] }),
  });

  const fakeClaude = async () =>
    '{"love_phrases":["still works"],"pain_phrases":[],"competitor_complaints":[],"jtbd_phrases":[],"trigger_events":[]}';
  const r = await orchestrator.runForBusiness({
    businessId: 'biz1',
    sources: { google_places: { placeId: 'X' }, manual: { reviewsText: 'r' } },
    deps: { callClaude: fakeClaude, sbPost: async () => ({}) },
  });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.sources.google_places.ok, false);
  assert.match(r.sources.google_places.reason, /Google API exploded/);
  assert.strictEqual(r.sources.manual.ok, true);
  assert.strictEqual(r.totalReviewsFetched, 1);

  orchestrator.SOURCE_REGISTRY.google_places = origGoogle;
  orchestrator.SOURCE_REGISTRY.manual = origManual;
});

test('orchestrator: empty all sources returns ok=true with inserted=0', async () => {
  const origManual = orchestrator.SOURCE_REGISTRY.manual;
  orchestrator.SOURCE_REGISTRY.manual = () => ({
    fetch: async () => ({ ok: true, source: 'manual', reviews: [] }),
  });

  const r = await orchestrator.runForBusiness({
    businessId: 'biz1',
    sources: { manual: { reviewsText: 'nothing' } },
    deps: { callClaude: async () => '', sbPost: async () => ({}) },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.totalReviewsFetched, 0);
  assert.strictEqual(r.inserted, 0);
  assert.match(r.reason, /no reviews/);

  orchestrator.SOURCE_REGISTRY.manual = origManual;
});

// ─── pure helpers ─────────────────────────────────────────────────────────

test('_dedupeReviews: collapses near-identical text by first 80 chars', () => {
  // Need 80+ char shared prefix to test the "first 80" rule
  const prefix80 = 'Best espresso in Tirana, hands down — fresh beans, friendly staff, would highly recommend';
  const out = orchestrator._dedupeReviews([
    { text: prefix80 },
    { text: prefix80 }, // exact dup
    { text: prefix80 + ', and the wifi is fast' }, // dup by first 80 chars
    { text: 'Completely different review' },
  ]);
  assert.strictEqual(out.length, 2);
});

test('_dedupeReviews: handles missing text', () => {
  const out = orchestrator._dedupeReviews([{ text: 'a real review' }, { text: '' }, { text: null }, {}]);
  assert.strictEqual(out.length, 1);
});
