'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { hashSecret, verifySecret, newToken } = require('../routes/api-tokens');

test('newToken produces a mroa_-prefixed secret with a 12-char public prefix', () => {
  const { full, prefix } = newToken();
  assert.match(full, /^mroa_[0-9a-f]{64}$/);
  assert.equal(prefix.length, 12);
  assert.ok(full.startsWith(prefix));
});

test('hashSecret produces pbkdf2 envelope; verifySecret matches it', () => {
  const { full } = newToken();
  const stored = hashSecret(full);
  assert.match(stored, /^pbkdf2\$\d+\$[a-f0-9]+\$[a-f0-9]+$/);
  assert.equal(verifySecret(full, stored), true);
});

test('verifySecret rejects wrong secret', () => {
  const { full } = newToken();
  const stored = hashSecret(full);
  const other = newToken().full;
  assert.equal(verifySecret(other, stored), false);
});

test('verifySecret survives malformed input without throwing', () => {
  assert.equal(verifySecret('anything', 'not-a-hash'), false);
  assert.equal(verifySecret('anything', ''), false);
  assert.equal(verifySecret('anything', null), false);
});

test('two new tokens never collide on full or prefix', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const { full, prefix } = newToken();
    assert.equal(seen.has(full), false);
    seen.add(full);
    seen.add(prefix);
  }
});
