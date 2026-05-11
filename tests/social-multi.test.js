'use strict';

const test = require('node:test');
const assert = require('node:assert');

const social = require('../services/social-multi');

test('social-multi: SUPPORTED_PLATFORMS does NOT include X or Reddit', () => {
  assert.ok(!social.SUPPORTED_PLATFORMS.includes('x'));
  assert.ok(!social.SUPPORTED_PLATFORMS.includes('twitter'));
  assert.ok(!social.SUPPORTED_PLATFORMS.includes('reddit'));
  // Reasoning: X is pay-to-play $200/mo Basic minimum (research). Reddit is
  // a policy minefield. Both are intentionally NOT supported.
});

test('social-multi: SUPPORTED_PLATFORMS does NOT include google_business_profile', () => {
  assert.ok(!social.SUPPORTED_PLATFORMS.includes('google_business_profile'));
  assert.ok(!social.SUPPORTED_PLATFORMS.includes('gbp'));
  // Reasoning: GBP organic Local Posts API was deprecated 2024 and never
  // restored. We replaced this with GBP Q&A + Reviews monitoring elsewhere.
});

test('social-multi: SUPPORTED_PLATFORMS includes the 7 we actually do', () => {
  const expected = ['linkedin', 'pinterest', 'tiktok', 'youtube', 'threads', 'facebook', 'instagram'];
  for (const p of expected) {
    assert.ok(social.SUPPORTED_PLATFORMS.includes(p), `missing platform: ${p}`);
  }
});

test('social-multi: Ayrshare handles 4 platforms; Meta Graph handles 3', () => {
  // Critical separation — Threads / FB / IG share the Meta App; the rest
  // go through Ayrshare's aggregator until customer scale flips economics.
  assert.deepStrictEqual(social.PLATFORM_VIA_AYRSHARE.sort(), ['linkedin', 'pinterest', 'tiktok', 'youtube']);
  assert.deepStrictEqual(social.PLATFORM_VIA_META_GRAPH.sort(), ['facebook', 'instagram', 'threads']);
});

test('social-multi: every supported platform has an aspect ratio mapping', () => {
  for (const p of social.SUPPORTED_PLATFORMS) {
    assert.ok(social.PLATFORM_ASPECT_RATIO[p], `no aspect ratio for ${p}`);
  }
});

test('adaptContentForPlatform: clamps body to LinkedIn 2900 chars', () => {
  const long = 'x'.repeat(5000);
  const r = social.adaptContentForPlatform({
    platform: 'linkedin',
    content: { body: long },
    mediaUrl: null,
  });
  assert.strictEqual(r.body.length, 2900);
});

test('adaptContentForPlatform: clamps body to Threads 500 chars', () => {
  const long = 'y'.repeat(2000);
  const r = social.adaptContentForPlatform({
    platform: 'threads',
    content: { body: long },
    mediaUrl: null,
  });
  assert.strictEqual(r.body.length, 500);
});

test('adaptContentForPlatform: clamps body to Pinterest 500 chars', () => {
  const long = 'p'.repeat(2000);
  const r = social.adaptContentForPlatform({
    platform: 'pinterest',
    content: { body: long },
    mediaUrl: null,
  });
  assert.strictEqual(r.body.length, 500);
});

test('adaptContentForPlatform: TikTok aspect 9:16 (vertical)', () => {
  const r = social.adaptContentForPlatform({
    platform: 'tiktok',
    content: { body: 'short' },
    mediaUrl: 'https://x',
  });
  assert.strictEqual(r.aspect_ratio, '9:16');
  assert.strictEqual(r.media_url, 'https://x');
});

test('adaptContentForPlatform: LinkedIn aspect 1.91:1 (landscape)', () => {
  const r = social.adaptContentForPlatform({
    platform: 'linkedin',
    content: { body: 'short' },
    mediaUrl: null,
  });
  assert.strictEqual(r.aspect_ratio, '1.91:1');
});

test('listConnectedPlatforms: returns empty when business has no integrations', async () => {
  const deps = {
    sbGet: async () => [{}],
  };
  const r = await social.listConnectedPlatforms({ businessId: 'b1', deps });
  assert.deepStrictEqual(r.connected, []);
  assert.strictEqual(r.ayrshare_enabled, false);
});

test('listConnectedPlatforms: counts FB+IG when present', async () => {
  const deps = {
    sbGet: async () => [
      {
        facebook_page_id: 'fb-1',
        instagram_account_id: 'ig-1',
        ayrshare_profile_key: null,
      },
    ],
  };
  const r = await social.listConnectedPlatforms({ businessId: 'b1', deps });
  assert.ok(r.connected.includes('facebook'));
  assert.ok(r.connected.includes('instagram'));
  assert.ok(!r.connected.includes('linkedin'));
});

test('listConnectedPlatforms: counts Ayrshare-enabled platforms', async () => {
  const deps = {
    sbGet: async () => [
      {
        ayrshare_profile_key: 'ay-key-123',
        ayrshare_connected_platforms: ['linkedin', 'pinterest'],
      },
    ],
  };
  const r = await social.listConnectedPlatforms({ businessId: 'b1', deps });
  assert.strictEqual(r.ayrshare_enabled, true);
  assert.ok(r.connected.includes('linkedin'));
  assert.ok(r.connected.includes('pinterest'));
  assert.ok(!r.connected.includes('tiktok'));
});

test('postNow: rejects when no supported platforms in request', async () => {
  const deps = { sbGet: async () => [{}], sbPost: async () => {} };
  const r = await social.postNow({
    businessId: 'b1',
    platforms: ['x', 'reddit'],
    content: { body: 'hi' },
    deps,
  });
  assert.strictEqual(r.ok, false);
  assert.ok(/no supported platforms/.test(r.reason));
});
