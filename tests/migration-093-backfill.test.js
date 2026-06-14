'use strict';

// Safety-property checks for migration 093 (businesses.user_id backfill).
// The live behavior runs in Postgres; these assert the SQL keeps the
// guarantees the fix depends on: idempotent (NULL-only), schema-tolerant
// (guarded), email-sourced, and NOT uniqueness-constrained.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SQL = fs.readFileSync(path.join(__dirname, '..', 'migrations', '093_backfill_business_user_id.sql'), 'utf8');

test('093: idempotent — only updates rows where user_id IS NULL', () => {
  assert.match(SQL, /UPDATE\s+public\.businesses/i);
  assert.match(SQL, /WHERE\s+b\.user_id\s+IS\s+NULL/i);
});

test('093: schema-tolerant — guards businesses, its columns, and auth.users', () => {
  assert.match(SQL, /to_regclass\(\s*'public\.businesses'\s*\)/i);
  assert.match(SQL, /to_regclass\(\s*'auth\.users'\s*\)/i);
  assert.match(SQL, /information_schema\.columns/i);
});

test('093: sources user_id from the row email matched to auth.users', () => {
  assert.match(SQL, /FROM\s+auth\.users/i);
  assert.match(SQL, /lower\(\s*b\.email\s*\)\s*=\s*lower\(\s*u\.email\s*\)/i);
});

test('093: does NOT add a unique constraint on user_id (agencies own many businesses)', () => {
  assert.doesNotMatch(SQL, /unique[^\n]*businesses[^\n]*user_id/i);
});
