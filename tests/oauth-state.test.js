'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { signOAuthState, verifyOAuthState } = require('../lib/oauthState');

const SECRET = 'test-secret-at-least-16-chars-long';
const BIZ = '11111111-1111-4111-8111-111111111111';

test('sign/verify round-trips and binds business + platform', () => {
  const state = signOAuthState({ businessId: BIZ, platform: 'twitter', secret: SECRET });
  const v = verifyOAuthState(state, SECRET, { platform: 'twitter' });
  assert.ok(v);
  assert.strictEqual(v.businessId, BIZ);
  assert.strictEqual(v.platform, 'twitter');
});

test('rejects wrong secret', () => {
  const state = signOAuthState({ businessId: BIZ, platform: 'twitter', secret: SECRET });
  assert.strictEqual(verifyOAuthState(state, 'other-secret', { platform: 'twitter' }), null);
});

test('rejects platform mismatch (no cross-provider replay)', () => {
  const state = signOAuthState({ businessId: BIZ, platform: 'twitter', secret: SECRET });
  assert.strictEqual(verifyOAuthState(state, SECRET, { platform: 'tiktok' }), null);
});

test('rejects tampered payload', () => {
  const state = signOAuthState({ businessId: BIZ, platform: 'twitter', secret: SECRET });
  const raw = Buffer.from(state, 'base64url').toString('utf8').split('|');
  raw[0] = '22222222-2222-4222-8222-222222222222'; // swap business id, keep sig
  const tampered = Buffer.from(raw.join('|')).toString('base64url');
  assert.strictEqual(verifyOAuthState(tampered, SECRET, { platform: 'twitter' }), null);
});

test('rejects expired state', () => {
  const old = Date.now() - 31 * 60 * 1000;
  const state = signOAuthState({ businessId: BIZ, platform: 'twitter', ts: old, secret: SECRET });
  assert.strictEqual(verifyOAuthState(state, SECRET, { platform: 'twitter', maxAgeMs: 30 * 60 * 1000 }), null);
});

test('rejects non-uuid business id', () => {
  const state = signOAuthState({ businessId: 'not-a-uuid', platform: 'twitter', secret: SECRET });
  assert.strictEqual(verifyOAuthState(state, SECRET, { platform: 'twitter' }), null);
});

test('rejects empty / malformed input', () => {
  assert.strictEqual(verifyOAuthState('', SECRET), null);
  assert.strictEqual(verifyOAuthState('garbage', SECRET), null);
  assert.strictEqual(
    verifyOAuthState(signOAuthState({ businessId: BIZ, platform: 'twitter', secret: SECRET }), ''),
    null
  );
});
