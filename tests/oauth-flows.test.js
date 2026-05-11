'use strict';

const test = require('node:test');
const assert = require('node:assert');

const meta = require('../services/oauth/meta');
const google = require('../services/oauth/google');
const { limits, makeLimiter } = require('../lib/rateLimiters');

const SECRET = 'test-secret-do-not-leak';
const BIZ_UUID = '11111111-1111-4111-8111-111111111111';
const USER_UUID = '22222222-2222-4222-8222-222222222222';

// ─── Meta OAuth state signing ────────────────────────────────────────────

test('meta-oauth: signState produces base64url string', () => {
  const tok = meta.signState({ businessId: BIZ_UUID, userId: USER_UUID, secret: SECRET });
  assert.strictEqual(typeof tok, 'string');
  assert.ok(tok.length > 20);
  assert.ok(!/[+/=]/.test(tok), 'base64url MUST NOT contain +, /, or = chars');
});

test('meta-oauth: verifyState round-trips correctly', () => {
  const tok = meta.signState({ businessId: BIZ_UUID, userId: USER_UUID, secret: SECRET });
  const v = meta.verifyState(tok, SECRET);
  assert.strictEqual(v?.businessId, BIZ_UUID);
  assert.strictEqual(v?.userId, USER_UUID);
  assert.ok(v?.nonce && v.nonce.length >= 16);
  assert.ok(v?.ts > 0);
});

test('meta-oauth: verifyState rejects tampered tokens', () => {
  const tok = meta.signState({ businessId: BIZ_UUID, userId: USER_UUID, secret: SECRET });
  const tampered = tok.slice(0, -3) + 'AAA';
  assert.strictEqual(meta.verifyState(tampered, SECRET), null);
});

test('meta-oauth: verifyState rejects wrong secret', () => {
  const tok = meta.signState({ businessId: BIZ_UUID, userId: USER_UUID, secret: SECRET });
  assert.strictEqual(meta.verifyState(tok, 'wrong-secret'), null);
});

test('meta-oauth: verifyState rejects expired tokens (>30 min old)', () => {
  const oldTs = Date.now() - 31 * 60 * 1000;
  const tok = meta.signState({ businessId: BIZ_UUID, userId: USER_UUID, ts: oldTs, secret: SECRET });
  assert.strictEqual(meta.verifyState(tok, SECRET), null);
});

test('meta-oauth: verifyState rejects non-UUID businessId/userId', () => {
  // Even with valid HMAC, malformed UUIDs are rejected — defense in depth
  // against an attacker who has the secret but crafted bad ids.
  const bad = meta.signState({ businessId: 'not-a-uuid', userId: USER_UUID, secret: SECRET });
  assert.strictEqual(meta.verifyState(bad, SECRET), null);
});

test('meta-oauth: nonce changes per call (replay resistance)', () => {
  const t1 = meta.signState({ businessId: BIZ_UUID, userId: USER_UUID, secret: SECRET });
  const t2 = meta.signState({ businessId: BIZ_UUID, userId: USER_UUID, secret: SECRET });
  assert.notStrictEqual(t1, t2, 'two calls with same inputs should produce different tokens');
});

test('meta-oauth: SCOPES includes all required permissions', () => {
  const required = ['ads_management', 'ads_read', 'pages_show_list', 'instagram_basic', 'business_management'];
  for (const r of required) {
    assert.ok(meta.SCOPES.includes(r), `Meta SCOPES missing required scope: ${r}`);
  }
});

// ─── Google OAuth state signing ──────────────────────────────────────────

test('google-oauth: signState produces base64url string', () => {
  const tok = google.signState({ businessId: BIZ_UUID, userId: USER_UUID, secret: SECRET });
  assert.strictEqual(typeof tok, 'string');
  assert.ok(!/[+/=]/.test(tok));
});

test('google-oauth: verifyState round-trips correctly', () => {
  const tok = google.signState({ businessId: BIZ_UUID, userId: USER_UUID, secret: SECRET });
  const v = google.verifyState(tok, SECRET);
  assert.strictEqual(v?.businessId, BIZ_UUID);
  assert.strictEqual(v?.userId, USER_UUID);
});

test('google-oauth: verifyState rejects mismatched secret', () => {
  const tok = google.signState({ businessId: BIZ_UUID, userId: USER_UUID, secret: SECRET });
  assert.strictEqual(google.verifyState(tok, 'other-secret'), null);
});

test('google-oauth: meta and google tokens have the same HMAC scheme', () => {
  // Same HMAC scheme means a token signed by Meta verifies for Google
  // (and vice versa). This is intentional — both providers share the
  // same state-secret. Cross-replay is mitigated by separate callback
  // URLs and the userOwnsBusiness check inside each /start handler.
  const tok = meta.signState({ businessId: BIZ_UUID, userId: USER_UUID, secret: SECRET });
  const v = google.verifyState(tok, SECRET);
  assert.strictEqual(v?.businessId, BIZ_UUID);
});

test('google-oauth: SCOPES includes adwords + userinfo', () => {
  assert.ok(google.SCOPES.includes('adwords'));
  assert.ok(google.SCOPES.includes('userinfo.email'));
});

// ─── Shared rate-limiter factory ─────────────────────────────────────────

test('rate-limiters: makeLimiter returns Express middleware', () => {
  const mw = makeLimiter({ windowMs: 1000, max: 5, name: 'test' });
  assert.strictEqual(typeof mw, 'function');
  assert.ok(mw.length >= 2 && mw.length <= 3);
});

test('rate-limiters: pre-configured limits expose all 5 tiers', () => {
  for (const tier of ['fastRead', 'standardMutate', 'expensive', 'veryExpensive', 'crontarget']) {
    assert.strictEqual(typeof limits[tier], 'function', `Missing limiter tier: ${tier}`);
  }
});
