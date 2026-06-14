'use strict';

const test = require('node:test');
const assert = require('node:assert');

const voc = require('../services/voc-scraper');

// ─── parseExtractedVoc ──────────────────────────────────────────────────────

test('voc-scraper: parses well-formed extraction', () => {
  const out = voc.parseExtractedVoc(
    JSON.stringify({
      love_phrases: ['saved me three hours', 'finally something that just works'],
      pain_phrases: ['crying in the parking lot', "could not get my mom's birthday right"],
      competitor_complaints: ['support never responded', 'app crashed during checkout'],
      jtbd_phrases: ['remember birthdays without thinking'],
      trigger_events: ['missed my dad birthday two years in a row'],
    })
  );
  assert.strictEqual(out.love_phrases.length, 2);
  assert.strictEqual(out.pain_phrases.length, 2);
  assert.strictEqual(out.competitor_complaints.length, 2);
  assert.match(out.love_phrases[0], /saved me/);
});

test('voc-scraper: strips markdown fences', () => {
  const out = voc.parseExtractedVoc(
    '```json\n{"love_phrases":["good"],"pain_phrases":[],"competitor_complaints":[],"jtbd_phrases":[],"trigger_events":[]}\n```'
  );
  assert.strictEqual(out.love_phrases[0], 'good');
});

test('voc-scraper: returns null on garbage', () => {
  assert.strictEqual(voc.parseExtractedVoc('not json'), null);
  assert.strictEqual(voc.parseExtractedVoc(''), null);
  assert.strictEqual(voc.parseExtractedVoc(null), null);
});

test('voc-scraper: clamps array sizes + truncates long phrases', () => {
  const long = 'x'.repeat(500);
  const huge = Array.from({ length: 50 }, (_, i) => `phrase ${i}`);
  const out = voc.parseExtractedVoc(
    JSON.stringify({
      love_phrases: huge,
      pain_phrases: [long],
      competitor_complaints: [],
      jtbd_phrases: [],
      trigger_events: [],
    })
  );
  assert.strictEqual(out.love_phrases.length, voc.MAX_PHRASES_PER_CATEGORY);
  assert.ok(out.pain_phrases[0].length <= 200);
});

test('voc-scraper: de-dupes phrases across categories', () => {
  const out = voc.parseExtractedVoc(
    JSON.stringify({
      love_phrases: ['exactly what i needed', 'EXACTLY WHAT I NEEDED'],
      pain_phrases: ['exactly what i needed'],
      competitor_complaints: [],
      jtbd_phrases: [],
      trigger_events: [],
    })
  );
  // After dedup, the phrase should appear only once total
  const all = [...out.love_phrases, ...out.pain_phrases].map((p) => p.toLowerCase());
  const unique = new Set(all);
  assert.strictEqual(all.length, unique.size);
});

// ─── extractFromText ────────────────────────────────────────────────────────

test('voc-scraper: extractFromText returns null on empty input', async () => {
  let called = false;
  const fakeClaude = async () => {
    called = true;
    return '';
  };
  const out = await voc.extractFromText({ callClaude: fakeClaude, reviewsText: '' });
  assert.strictEqual(out, null);
  assert.strictEqual(called, false);
});

test('voc-scraper: extractFromText passes reviews + competitor reviews to Claude', async () => {
  const captured = [];
  const fakeClaude = async (args) => {
    captured.push(args);
    return JSON.stringify({
      love_phrases: ['x'],
      pain_phrases: [],
      competitor_complaints: ['y'],
      jtbd_phrases: [],
      trigger_events: [],
    });
  };
  await voc.extractFromText({
    callClaude: fakeClaude,
    reviewsText: 'Five stars, this app saved my life',
    competitorReviewsText: 'One star, the other app crashed',
    businessId: 'biz1',
  });
  assert.match(captured[0].user, /REVIEWS OF THE BUSINESS/);
  assert.match(captured[0].user, /this app saved my life/);
  assert.match(captured[0].user, /COMPETITOR REVIEWS/);
  assert.match(captured[0].user, /the other app crashed/);
  assert.match(captured[0].model, /haiku/);
  assert.strictEqual(captured[0].extra.skipBrandVoice, true);
});

test('voc-scraper: extractFromText returns null when Claude throws', async () => {
  const out = await voc.extractFromText({
    callClaude: async () => {
      throw new Error('rate limited');
    },
    reviewsText: 'reviews here',
  });
  assert.strictEqual(out, null);
});

// ─── persistInsights ────────────────────────────────────────────────────────

test('voc-scraper: persistInsights writes one row per non-empty category', async () => {
  const inserts = [];
  const sbPost = async (table, row) => {
    inserts.push({ table, row });
    return { ok: true };
  };
  const out = await voc.persistInsights({
    sbPost,
    businessId: 'biz1',
    extracted: {
      love_phrases: ['saved my morning'],
      pain_phrases: ['felt overwhelmed'],
      competitor_complaints: [],
      jtbd_phrases: ['help me wake up'],
      trigger_events: [],
    },
  });
  assert.strictEqual(out.inserted, 3, '3 categories had phrases — 3 rows inserted');
  for (const i of inserts) {
    assert.strictEqual(i.table, 'customer_insights');
    assert.strictEqual(i.row.user_id, 'biz1');
    assert.ok(i.row.actionable_suggestion);
    assert.ok(
      ['love_phrase', 'pain_point', 'competitor_complaint', 'jtbd', 'trigger_event'].includes(i.row.insight_type)
    );
  }
});

test('voc-scraper: persistInsights survives sbPost throwing on individual rows', async () => {
  let calls = 0;
  const sbPost = async () => {
    calls++;
    if (calls === 2) throw new Error('row 2 failed');
    return { ok: true };
  };
  const out = await voc.persistInsights({
    sbPost,
    businessId: 'biz1',
    extracted: {
      love_phrases: ['a'],
      pain_phrases: ['b'],
      competitor_complaints: ['c'],
      jtbd_phrases: ['d'],
      trigger_events: ['e'],
    },
  });
  assert.strictEqual(out.inserted, 4, '4 of 5 should succeed; row 2 dropped silently');
});

test('voc-scraper: persistInsights returns 0 inserts when missing args', async () => {
  const sbPost = async () => ({ ok: true });
  assert.deepStrictEqual(await voc.persistInsights({}), { inserted: 0 });
  assert.deepStrictEqual(await voc.persistInsights({ sbPost }), { inserted: 0 });
  assert.deepStrictEqual(await voc.persistInsights({ sbPost, businessId: 'b' }), { inserted: 0 });
});

// ─── ingestReviews orchestrator ─────────────────────────────────────────────

test('voc-scraper: ingestReviews end-to-end with stubbed Claude', async () => {
  const inserts = [];
  const sbPost = async (t, row) => {
    inserts.push({ t, row });
    return { ok: true };
  };
  const fakeClaude = async () =>
    JSON.stringify({
      love_phrases: ['this thing actually works'],
      pain_phrases: ['was about to give up'],
      competitor_complaints: ['other app charged me twice'],
      jtbd_phrases: ['remember birthdays'],
      trigger_events: ['missed mom birthday'],
    });
  const out = await voc.ingestReviews({
    callClaude: fakeClaude,
    sbPost,
    businessId: 'biz1',
    // Every extracted phrase must appear verbatim in the source (grounding):
    reviewsText:
      '5 stars: this thing actually works! I was about to give up on apps like this. It finally helps me remember birthdays — I missed mom birthday last year.',
    competitorReviewsText: '1 star: other app charged me twice and never refunded.',
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.totalPhrases, 5);
  assert.strictEqual(out.inserted, 5);
  assert.strictEqual(inserts.length, 5);
});

test('voc-scraper: drops invented phrases not present in source reviews (grounding)', async () => {
  // Claude returns one real phrase and one hallucinated one; only the grounded
  // phrase survives — the never-invent-quotes rule is enforced, not just asked.
  const fakeClaude = async () =>
    JSON.stringify({
      love_phrases: ['this thing actually works', 'best app I have ever used in my life'],
      pain_phrases: [],
      competitor_complaints: [],
      jtbd_phrases: [],
      trigger_events: [],
    });
  const out = await voc.extractFromText({
    callClaude: fakeClaude,
    reviewsText: '5 stars: this thing actually works!',
  });
  assert.deepStrictEqual(out.love_phrases, ['this thing actually works']);
});

test('voc-scraper: ingestReviews returns ok=false on extraction failure', async () => {
  const fakeClaude = async () => 'not json';
  const out = await voc.ingestReviews({
    callClaude: fakeClaude,
    sbPost: async () => ({ ok: true }),
    businessId: 'biz1',
    reviewsText: 'some reviews',
  });
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /extraction/);
});

test('voc-scraper: ingestReviews returns ok=true + inserted=0 when extraction is empty', async () => {
  const fakeClaude = async () =>
    JSON.stringify({
      love_phrases: [],
      pain_phrases: [],
      competitor_complaints: [],
      jtbd_phrases: [],
      trigger_events: [],
    });
  const out = await voc.ingestReviews({
    callClaude: fakeClaude,
    sbPost: async () => ({ ok: true }),
    businessId: 'biz1',
    reviewsText: 'some reviews with no signal',
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.inserted, 0);
});

test('voc-scraper: ingestReviews requires businessId + reviewsText', async () => {
  const out = await voc.ingestReviews({});
  assert.strictEqual(out.ok, false);
});
