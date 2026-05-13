'use strict';

/**
 * tests/channels-registry.test.js
 *
 * Wave 60 Session 3 — verifies the channel-native format registry contract.
 *   - 35 channel modules load cleanly
 *   - Every module exports the required shape
 *   - listChannels filters work
 *   - applyChannel runs without throwing on a sample draft
 *   - getChannelPromptSegments returns non-empty for every channel
 */

const test = require('node:test');
const assert = require('node:assert');

const registry = require('../services/prompts/channels');

const EXPECTED_COUNT = 35;
const REQUIRED_EXPORTS = [
  'id',
  'name',
  'category',
  'surface_type',
  'source_citation',
  'format_rules',
  'hook_patterns',
  'anti_patterns',
  'applicability',
  'invariants',
  'manipulation_risk',
  'applyToDraft',
  'generateFromSpec',
];

const VALID_CATEGORIES = ['social', 'paid-ads', 'owned', 'web', 'commerce'];
const VALID_SURFACE_TYPES = [
  'short_video',
  'long_video',
  'feed_post',
  'story',
  'ad_image',
  'ad_video',
  'search_result',
  'long_form',
  'email',
  'sms',
  'landing',
  'listing',
  'message',
  'notification',
];

// ─── Module loading ───────────────────────────────────────────────────────

test('channels: listAllIds returns 35 channel IDs', () => {
  assert.strictEqual(registry.listAllIds().length, EXPECTED_COUNT);
});

test('channels: every ID maps to a loadable module', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getChannel(id);
    assert.ok(mod, `${id} failed to load`);
    assert.notStrictEqual(mod, registry.NULL_MODULE, `${id} resolved to NULL_MODULE`);
  }
});

test('channels: getChannel returns null for unknown id', () => {
  assert.strictEqual(registry.getChannel('does-not-exist'), null);
});

// ─── Shape invariant for ALL modules ──────────────────────────────────────

for (const field of REQUIRED_EXPORTS) {
  test(`channels: every module exports "${field}"`, () => {
    for (const id of registry.listAllIds()) {
      const mod = registry.getChannel(id);
      assert.ok(mod[field] !== undefined && mod[field] !== null, `${id} missing "${field}"`);
    }
  });
}

test('channels: every module has valid category', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getChannel(id);
    assert.ok(
      VALID_CATEGORIES.includes(mod.category),
      `${id} has invalid category "${mod.category}"`
    );
  }
});

test('channels: every module has valid surface_type', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getChannel(id);
    assert.ok(
      VALID_SURFACE_TYPES.includes(mod.surface_type),
      `${id} has invalid surface_type "${mod.surface_type}"`
    );
  }
});

test('channels: every module ID matches its filename / kebab-case', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getChannel(id);
    assert.strictEqual(mod.id, id, `${id} self-reports id "${mod.id}"`);
    assert.ok(/^[a-z0-9-]+$/.test(mod.id), `${id} not kebab-case`);
  }
});

test('channels: every module has at least one hook pattern', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getChannel(id);
    assert.ok(
      Array.isArray(mod.hook_patterns) && mod.hook_patterns.length > 0,
      `${id} has no hook_patterns`
    );
  }
});

test('channels: every module has at least one invariant', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getChannel(id);
    assert.ok(
      Array.isArray(mod.invariants) && mod.invariants.length > 0,
      `${id} has no invariants`
    );
  }
});

test('channels: manipulation_risk is 0-10', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getChannel(id);
    assert.ok(
      typeof mod.manipulation_risk === 'number' &&
        mod.manipulation_risk >= 0 &&
        mod.manipulation_risk <= 10,
      `${id} manipulation_risk out of range: ${mod.manipulation_risk}`
    );
  }
});

// ─── Filters ──────────────────────────────────────────────────────────────

test('channels: listChannels(category=social) returns 12 channels', () => {
  const social = registry.listChannels({ category: 'social' });
  assert.strictEqual(social.length, 12);
  for (const m of social) assert.strictEqual(m.category, 'social');
});

test('channels: listChannels(category=paid-ads) returns 7 channels', () => {
  const ads = registry.listChannels({ category: 'paid-ads' });
  assert.strictEqual(ads.length, 7);
});

test('channels: listChannels(category=owned) returns 7 channels', () => {
  const owned = registry.listChannels({ category: 'owned' });
  assert.strictEqual(owned.length, 7);
});

test('channels: listChannels(category=web) returns 6 channels', () => {
  const web = registry.listChannels({ category: 'web' });
  assert.strictEqual(web.length, 6);
});

test('channels: listChannels(category=commerce) returns 3 channels', () => {
  const commerce = registry.listChannels({ category: 'commerce' });
  assert.strictEqual(commerce.length, 3);
});

test('channels: listChannels(surface_type=short_video) returns 3 channels', () => {
  const shortVideo = registry.listChannels({ surface_type: 'short_video' });
  // tiktok + instagram-reels + youtube-shorts
  assert.strictEqual(shortVideo.length, 3);
  const ids = new Set(shortVideo.map((m) => m.id));
  for (const expected of ['tiktok', 'instagram-reels', 'youtube-shorts']) {
    assert.ok(ids.has(expected), `expected ${expected} in short_video set`);
  }
});

// ─── applyChannel + getChannelPromptSegments ──────────────────────────────

test('channels: applyChannel works on every channel without throwing', () => {
  const draft = 'This is a sample post with some content about a thing for testing.';
  for (const id of registry.listAllIds()) {
    const r = registry.applyChannel({ channelId: id, draft });
    assert.ok(typeof r.score === 'number', `${id} applyChannel returned no score`);
    assert.ok(Array.isArray(r.fixes), `${id} applyChannel returned no fixes array`);
  }
});

test('channels: applyChannel returns error for unknown channel', () => {
  const r = registry.applyChannel({ channelId: 'does-not-exist', draft: 'hi' });
  assert.ok(r.error, 'expected an error for unknown channel');
});

test('channels: applyChannel on empty draft scores 0', () => {
  const r = registry.applyChannel({ channelId: 'x-post', draft: '' });
  assert.strictEqual(r.score, 0);
});

test('channels: getChannelPromptSegments returns non-empty array for every channel', () => {
  for (const id of registry.listAllIds()) {
    const segs = registry.getChannelPromptSegments(id);
    assert.ok(Array.isArray(segs), `${id} did not return array`);
    assert.ok(segs.length > 0, `${id} returned empty segments`);
  }
});

test('channels: getChannelPromptSegments returns [] for unknown channel', () => {
  const segs = registry.getChannelPromptSegments('does-not-exist');
  assert.deepStrictEqual(segs, []);
});

// ─── Stage-rules alignment ────────────────────────────────────────────────
// Channel IDs used in stage-rules.js should all be registered here.

test('channels: stage-rules referenced channel IDs are all registered', () => {
  const stageRulesChannels = [
    'tiktok',
    'instagram-reels',
    'youtube-shorts',
    'x-post',
    'meta-ads-video',
    'instagram-post',
    'linkedin-post',
    'blog-seo',
    'email-cold',
    'email-nurture',
    'landing-page-long',
    'linkedin-article',
    'sales-page',
    'email-promo',
    'blog-thought-leadership',
    'webinar',
    'meta-ads-image',
    'sms',
    'whatsapp',
    'email-retention',
    'instagram-stories',
  ];
  const allIds = new Set(registry.listAllIds());
  for (const id of stageRulesChannels) {
    assert.ok(allIds.has(id), `stage-rules references "${id}" but channel not registered`);
  }
});
