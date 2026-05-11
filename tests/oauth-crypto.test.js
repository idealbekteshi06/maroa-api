'use strict';

/**
 * tests/oauth-crypto.test.js
 *
 * Verifies lib/oauthCrypto.js — the AES-256-GCM at-rest encryption
 * layer for OAuth tokens. Critical security path — if this breaks,
 * customers can't connect Meta/Google/etc.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

// Need to set the key BEFORE requiring the module (it reads once).
process.env.OAUTH_TOKEN_ENC_KEY = crypto.randomBytes(32).toString('hex');

// Bypass require cache so we get a fresh module with the env-set key
delete require.cache[require.resolve('../lib/oauthCrypto')];
const oauthCrypto = require('../lib/oauthCrypto');

test('isEnabled: true when 64-char hex key is set', () => {
  assert.strictEqual(oauthCrypto.isEnabled(), true);
});

test('encrypt → decrypt round-trips for ASCII tokens', () => {
  const plain = 'sk-ant-api03-2wwBU3RhNG_fake_test_token_value';
  const blob = oauthCrypto.encrypt(plain);
  assert.ok(blob.startsWith('v1:'));
  const decrypted = oauthCrypto.decrypt(blob);
  assert.strictEqual(decrypted, plain);
});

test('encrypt → decrypt round-trips for UTF-8 tokens', () => {
  const plain = 'token_with_unicode_💼_chars_中文';
  const blob = oauthCrypto.encrypt(plain);
  const decrypted = oauthCrypto.decrypt(blob);
  assert.strictEqual(decrypted, plain);
});

test('encrypt: returns null on null / empty / undefined input', () => {
  assert.strictEqual(oauthCrypto.encrypt(null), null);
  assert.strictEqual(oauthCrypto.encrypt(undefined), null);
  assert.strictEqual(oauthCrypto.encrypt(''), null);
});

test('decrypt: returns null on null / empty input', () => {
  assert.strictEqual(oauthCrypto.decrypt(null), null);
  assert.strictEqual(oauthCrypto.decrypt(undefined), null);
  assert.strictEqual(oauthCrypto.decrypt(''), null);
});

test('encrypt: each call produces a different blob (fresh IV)', () => {
  const plain = 'same-plaintext';
  const b1 = oauthCrypto.encrypt(plain);
  const b2 = oauthCrypto.encrypt(plain);
  assert.notStrictEqual(b1, b2, 'IV must be fresh per encryption');
  assert.strictEqual(oauthCrypto.decrypt(b1), plain);
  assert.strictEqual(oauthCrypto.decrypt(b2), plain);
});

test('blob format: v1:iv_hex(24):tag_hex(32):ciphertext_hex(>=0)', () => {
  const blob = oauthCrypto.encrypt('test');
  const parts = blob.split(':');
  assert.strictEqual(parts.length, 4);
  assert.strictEqual(parts[0], 'v1');
  assert.strictEqual(parts[1].length, 24); // 12 bytes IV = 24 hex
  assert.strictEqual(parts[2].length, 32); // 16 bytes tag = 32 hex
  assert.ok(parts[3].length > 0);
});

test('decrypt: throws on malformed blob', () => {
  assert.throws(() => oauthCrypto.decrypt('not-a-valid-blob'), /malformed blob/i);
  assert.throws(() => oauthCrypto.decrypt('v1:nope'), /malformed blob/i);
  assert.throws(() => oauthCrypto.decrypt('v999:aa:bb:cc'), /unsupported scheme/i);
});

test('decrypt: throws on tampered ciphertext (GCM auth tag mismatch)', () => {
  const blob = oauthCrypto.encrypt('original-token');
  const parts = blob.split(':');
  // Flip a hex char in the ciphertext
  const ct = parts[3];
  const tampered = `v1:${parts[1]}:${parts[2]}:${ct.replace(/^./, ct[0] === 'a' ? 'b' : 'a')}`;
  assert.throws(() => oauthCrypto.decrypt(tampered), /decrypt failed/);
});

test('decrypt: throws on tampered IV', () => {
  const blob = oauthCrypto.encrypt('original-token');
  const parts = blob.split(':');
  const tamperedIv = parts[1].replace(/^./, parts[1][0] === 'a' ? 'b' : 'a');
  const tampered = `v1:${tamperedIv}:${parts[2]}:${parts[3]}`;
  assert.throws(() => oauthCrypto.decrypt(tampered), /decrypt failed/);
});

test('encryptIfEnabled: returns the *_enc patch shape when key is set', () => {
  const patch = oauthCrypto.encryptIfEnabled('meta_access_token', 'EAAfaketokenvalue');
  assert.ok(patch.meta_access_token_enc);
  assert.ok(patch.meta_access_token_enc.startsWith('v1:'));
});

test('encryptIfEnabled: empty object when value is null', () => {
  assert.deepStrictEqual(oauthCrypto.encryptIfEnabled('meta_access_token', null), {});
  assert.deepStrictEqual(oauthCrypto.encryptIfEnabled('meta_access_token', ''), {});
  assert.deepStrictEqual(oauthCrypto.encryptIfEnabled('meta_access_token', undefined), {});
});

test('readToken: prefers _enc column, falls back to legacy plaintext', () => {
  const plain = 'EAA-plaintext-fallback';
  const encBlob = oauthCrypto.encrypt('EAA-encrypted-value');

  // Both populated → returns decrypted enc
  const row1 = { meta_access_token: plain, meta_access_token_enc: encBlob };
  assert.strictEqual(oauthCrypto.readToken(row1, 'meta_access_token'), 'EAA-encrypted-value');

  // Only legacy populated → returns legacy
  const row2 = { meta_access_token: plain, meta_access_token_enc: null };
  assert.strictEqual(oauthCrypto.readToken(row2, 'meta_access_token'), plain);

  // Only enc populated → returns decrypted
  const row3 = { meta_access_token: null, meta_access_token_enc: encBlob };
  assert.strictEqual(oauthCrypto.readToken(row3, 'meta_access_token'), 'EAA-encrypted-value');

  // Neither → null
  const row4 = { meta_access_token: null, meta_access_token_enc: null };
  assert.strictEqual(oauthCrypto.readToken(row4, 'meta_access_token'), null);
});

test('readToken: handles null/undefined row gracefully', () => {
  assert.strictEqual(oauthCrypto.readToken(null, 'meta_access_token'), null);
  assert.strictEqual(oauthCrypto.readToken(undefined, 'meta_access_token'), null);
});

test('readToken: THROWS on corrupted enc blob (no silent downgrade)', () => {
  // SECURITY: post-2026-05-11 adversarial review — if `_enc` is populated
  // but decrypt fails, we MUST throw rather than fall back to legacy.
  // The fallback was a crypto downgrade vector.
  const row = {
    meta_access_token: 'attacker-controlled-plaintext',
    meta_access_token_enc: 'v1:badly:formed:blob',
  };
  assert.throws(() => oauthCrypto.readToken(row, 'meta_access_token'), /decrypt failed|malformed/);
});

test('readToken: returns legacy ONLY when _enc is null (pre-backfill transition)', () => {
  // Legacy fallback still works for the transition period — when the row
  // hasn't been backfilled yet and `_enc` is null/empty. Once migration
  // 060 drops the legacy columns this code path goes away entirely.
  assert.strictEqual(
    oauthCrypto.readToken({ meta_access_token: 'legit-legacy', meta_access_token_enc: null }, 'meta_access_token'),
    'legit-legacy'
  );
  assert.strictEqual(
    oauthCrypto.readToken({ meta_access_token: 'legit-legacy', meta_access_token_enc: '' }, 'meta_access_token'),
    'legit-legacy'
  );
});
