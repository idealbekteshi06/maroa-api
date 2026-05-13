'use strict';

/**
 * tests/channels-deep-modules.test.js
 *
 * Wave 60 Session 3 — deeper assertions on a representative channel from
 * each category. Verifies that applyToDraft catches real anti-patterns and
 * that format rules (length, char limits) are enforced.
 */

const test = require('node:test');
const assert = require('node:assert');

const registry = require('../services/prompts/channels');

// ─── X (Twitter) post ─────────────────────────────────────────────────────

test('x-post: catches >35-word overrun', () => {
  const draft = Array(50).fill('word').join(' ');
  const r = registry.applyChannel({ channelId: 'x-post', draft });
  const block = r.fixes.find((f) => f.severity === 'block');
  assert.ok(block, 'expected a block fix for 50-word X post');
});

test('x-post: catches engagement bait', () => {
  const draft = 'A short opinion. Retweet if you agree.';
  const r = registry.applyChannel({ channelId: 'x-post', draft });
  assert.ok(r.fixes.some((f) => /retweet if/i.test(f.issue) || /anti-pattern/i.test(f.issue)));
});

test('x-post: clean short post scores well', () => {
  const draft = 'Most marketing advice is reverse-engineered survivorship bias.';
  const r = registry.applyChannel({ channelId: 'x-post', draft });
  assert.ok(r.score >= 0.7, `expected score >= 0.7, got ${r.score}`);
});

// ─── Instagram Reels ──────────────────────────────────────────────────────

test('instagram-reels: catches long opening line', () => {
  const draft = 'In this video I am going to walk you through everything you need to know about this topic step by step';
  const r = registry.applyChannel({ channelId: 'instagram-reels', draft });
  assert.ok(r.fixes.some((f) => f.severity === 'block' && /hook/i.test(f.issue)));
});

test('instagram-reels: clean short hook scores well', () => {
  const draft = [
    'Three things I wish I knew sooner.',
    'First, you do not need expensive gear, your phone is enough.',
    'Then, batch your filming on Sunday so the week stays clean.',
    'Finally, post the same idea three different ways.',
    'The third version is the one that always wins.',
    'Try it this week and tell me what worked.',
  ].join('\n');
  const r = registry.applyChannel({ channelId: 'instagram-reels', draft });
  assert.ok(r.score >= 0.6, `expected score >= 0.6, got ${r.score}`);
});

// ─── LinkedIn post ────────────────────────────────────────────────────────

test('linkedin-post: catches promo language', () => {
  const draft = 'Here is something useful for you to think about today. Buy now to get our discount.';
  const r = registry.applyChannel({ channelId: 'linkedin-post', draft });
  assert.ok(r.fixes.some((f) => /anti-pattern/i.test(f.issue) || /buy now/i.test(f.issue)));
});

test('linkedin-post: catches engagement bait', () => {
  const draft = 'A reasonable observation about the topic. Agree?';
  const r = registry.applyChannel({ channelId: 'linkedin-post', draft });
  assert.ok(r.fixes.some((f) => /anti-pattern/i.test(f.issue)));
});

// ─── Meta image ad ────────────────────────────────────────────────────────

test('meta-ads-image: catches personal-attribute violation', () => {
  const draft = "You're overweight. Try our solution today.";
  const r = registry.applyChannel({ channelId: 'meta-ads-image', draft });
  assert.ok(r.fixes.some((f) => /anti-pattern/i.test(f.issue)));
});

test('meta-ads-image: catches over-length copy', () => {
  const draft = 'a'.repeat(300);
  const r = registry.applyChannel({ channelId: 'meta-ads-image', draft });
  assert.ok(r.fixes.some((f) => f.severity === 'block' && /chars/i.test(f.issue)));
});

// ─── Google Search ad ─────────────────────────────────────────────────────

test('google-ads-search: catches all-caps anti-pattern', () => {
  const draft = 'ALL CAPS HEADLINE here for click here service today';
  const r = registry.applyChannel({ channelId: 'google-ads-search', draft });
  assert.ok(r.fixes.some((f) => /anti-pattern/i.test(f.issue)));
});

// ─── Cold email ───────────────────────────────────────────────────────────

test('email-cold: catches template tells', () => {
  const draft = 'Hope this finds you well. Quick question — I wanted to ask if you have 15 minutes next week.';
  const r = registry.applyChannel({ channelId: 'email-cold', draft });
  assert.ok(r.fixes.some((f) => /anti-pattern/i.test(f.issue)));
});

test('email-cold: catches overlong body', () => {
  const draft = Array(200).fill('word').join(' ');
  const r = registry.applyChannel({ channelId: 'email-cold', draft });
  assert.ok(r.fixes.some((f) => f.severity === 'block'));
});

// ─── SMS ──────────────────────────────────────────────────────────────────

test('sms: requires opt-out', () => {
  const draft = 'Brand: 20% off this weekend only. https://x.co/y';
  const r = registry.applyChannel({ channelId: 'sms', draft });
  assert.ok(r.fixes.some((f) => f.severity === 'block' && /opt-out/i.test(f.issue)));
});

test('sms: clean compliant message passes', () => {
  const draft = 'Brand: 20% off this weekend only. https://x.co/y Reply STOP to opt out';
  const r = registry.applyChannel({ channelId: 'sms', draft });
  const blocks = r.fixes.filter((f) => f.severity === 'block');
  assert.strictEqual(blocks.length, 0);
});

test('sms: catches over-160-char message', () => {
  const draft = 'a'.repeat(200) + ' Reply STOP to opt out';
  const r = registry.applyChannel({ channelId: 'sms', draft });
  assert.ok(r.fixes.some((f) => f.severity === 'block' && /chars/i.test(f.issue)));
});

// ─── Push notification ────────────────────────────────────────────────────

test('push-notification: catches over-140-char message', () => {
  const draft = 'a'.repeat(200);
  const r = registry.applyChannel({ channelId: 'push-notification', draft });
  assert.ok(r.fixes.some((f) => f.severity === 'block'));
});

// ─── Blog SEO ─────────────────────────────────────────────────────────────

test('blog-seo: catches AI-tell phrases', () => {
  const draft = Array(1300).fill('word').join(' ') + ' In today\'s digital landscape, you can unleash the power of marketing.';
  const r = registry.applyChannel({ channelId: 'blog-seo', draft });
  assert.ok(r.fixes.some((f) => /anti-pattern/i.test(f.issue)));
});

// ─── Sales page ───────────────────────────────────────────────────────────

test('sales-page: catches vague superlatives', () => {
  const draft = Array(1600).fill('word').join(' ') + ' This will change your life and unlock world-class results.';
  const r = registry.applyChannel({ channelId: 'sales-page', draft });
  assert.ok(r.fixes.some((f) => /anti-pattern/i.test(f.issue)));
});

// ─── Review response ──────────────────────────────────────────────────────

test('review-response: catches boilerplate language', () => {
  const draft = 'Hi customer, we appreciate your feedback. Thank you for your business.';
  const r = registry.applyChannel({ channelId: 'review-response', draft });
  assert.ok(r.fixes.some((f) => /anti-pattern/i.test(f.issue)));
});

// ─── generateFromSpec produces hook patterns + segments ───────────────────

test('generateFromSpec: every channel produces hook + format prompt segments', () => {
  for (const id of registry.listAllIds()) {
    const segs = registry.getChannelPromptSegments(id);
    assert.ok(segs.length >= 2, `${id} returned too few segments: ${segs.length}`);
    assert.ok(segs.some((s) => /SURFACE:/.test(s)), `${id} missing SURFACE: segment`);
  }
});
