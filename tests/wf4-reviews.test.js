'use strict';

// First behavioral coverage for WF4 (reviews) — previously zero tests
// (flagged in CLAUDE.md test-coverage gaps). Focuses on the 2026-07 quality
// gate on generateResponse: review replies are the most public text Maroa
// writes, so rejected drafts must be dropped, polished text must replace the
// original, and gate failures must fail open.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const BIZ = '11111111-1111-4111-8111-111111111111';
const REVIEW = '22222222-2222-4222-8222-222222222222';

// Intercept the quality-gate require so we control verdicts per draft.
const gatePath = require.resolve('../services/prompts/quality-gate');
let gateImpl = null;
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (gateImpl && parent && parent.filename && parent.filename.includes(path.join('services', 'wf4'))) {
    if (request.includes('quality-gate')) return { gate: gateImpl };
  }
  return realLoad.apply(this, arguments);
};
test.after(() => {
  Module._load = realLoad;
});

function makeWf4({ drafts, gate }) {
  gateImpl = gate;
  delete require.cache[require.resolve('../services/wf4')];
  const createWf4 = require('../services/wf4');
  const posts = [];
  const wf4 = createWf4({
    sbGet: async (table) => {
      if (table === 'reviews')
        return [
          {
            id: REVIEW,
            business_id: BIZ,
            rating: 5,
            body: 'Great service!',
            category: 'positive',
            urgency: 'low',
            platform: 'google',
            topics: ['service'],
            language: 'en',
            sentiment: 0.9,
            reviewer_name: 'Jane',
            authenticity: { score: 92, isSuspicious: false },
          },
        ];
      if (table === 'businesses') return [{ id: BIZ, business_name: 'Test Biz', plan: 'growth' }];
      if (table === 'business_profiles') return [];
      return [];
    },
    sbPost: async (table, row) => {
      if (table === 'review_responses') posts.push(row);
      return { id: 'resp_1', ...row };
    },
    sbPatch: async () => ({}),
    callClaude: async () => JSON.stringify({ drafts }),
    extractJSON: (raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    sendEmail: async () => ({}),
    sendWhatsApp: async () => ({}),
  });
  return { wf4, posts };
}

test('generateResponse: gate-rejected drafts are dropped, polished text replaces original', async () => {
  const { wf4, posts } = makeWf4({
    drafts: [
      { body: 'Slop-heavy generic reply', signatureName: 'A' },
      { body: 'Genuine specific thank-you', signatureName: 'B' },
    ],
    gate: async ({ text }) =>
      text.includes('Slop')
        ? { decision: 'reject', final_text: null }
        : { decision: 'ship', final_text: 'Genuine specific thank-you — polished.' },
  });
  const result = await wf4.generateResponse({ businessId: BIZ, reviewId: REVIEW });
  assert.strictEqual(posts.length, 1, 'rejected draft dropped');
  assert.strictEqual(posts[0].body, 'Genuine specific thank-you — polished.', 'gate final_text wins');
  assert.ok(result);
});

test('generateResponse: never drops ALL drafts (human reviews before publish)', async () => {
  const { posts, wf4 } = makeWf4({
    drafts: [{ body: 'Only draft', signatureName: 'A' }],
    gate: async () => ({ decision: 'reject', final_text: null }),
  });
  await wf4.generateResponse({ businessId: BIZ, reviewId: REVIEW });
  assert.strictEqual(posts.length, 1, 'all-rejected keeps originals for human review');
  assert.strictEqual(posts[0].body, 'Only draft');
});

test('generateResponse: gate crash fails open — draft ships unmodified', async () => {
  const { posts, wf4 } = makeWf4({
    drafts: [{ body: 'Fine reply', signatureName: 'A' }],
    gate: async () => {
      throw new Error('gate exploded');
    },
  });
  await wf4.generateResponse({ businessId: BIZ, reviewId: REVIEW });
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].body, 'Fine reply');
});

test('quality-gate exposes tuned review_response thresholds', () => {
  gateImpl = null;
  delete require.cache[gatePath];
  const { DEFAULT_THRESHOLDS } = require('../services/prompts/quality-gate');
  const t = DEFAULT_THRESHOLDS.review_response;
  assert.ok(t, 'review_response thresholds exist');
  assert.ok(t.slop_max <= 25, 'strictest slop tolerance — public text');
  assert.strictEqual(t.psychology_min, 0, 'no persuasion requirement on gratitude');
});
