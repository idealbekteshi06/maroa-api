'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertOAuthEncKeyInProduction } = require('../lib/env');

test('assertOAuthEncKeyInProduction exits when key missing in production', () => {
  const origExit = process.exit;
  let exitCode = null;
  process.exit = (code) => {
    exitCode = code;
    throw new Error('process.exit called');
  };
  const origError = console.error;
  console.error = () => {};

  try {
    assert.throws(
      () =>
        assertOAuthEncKeyInProduction({
          NODE_ENV: 'production',
          OAUTH_TOKEN_ENC_KEY: '',
        }),
      /process\.exit/
    );
    assert.strictEqual(exitCode, 1);
  } finally {
    process.exit = origExit;
    console.error = origError;
  }
});

test('assertOAuthEncKeyInProduction allows valid hex key', () => {
  assertOAuthEncKeyInProduction({
    NODE_ENV: 'production',
    OAUTH_TOKEN_ENC_KEY: 'a'.repeat(64),
  });
});

test('assertOAuthEncKeyInProduction skips in non-production', () => {
  assertOAuthEncKeyInProduction({
    NODE_ENV: 'development',
    OAUTH_TOKEN_ENC_KEY: '',
  });
});
