'use strict';

// Schema-contract tests — read the ACTUAL migration SQL + the writer source
// (not a mocked sbPost) so the class of bug that hid the WF1 virality writer
// can't recur: migration 087 re-declared `content_performance` (already
// created by 024 with a different shape) via `CREATE TABLE IF NOT EXISTS` — a
// silent no-op — so every gen-time insert failed on missing/NOT-NULL columns
// and was swallowed by a .catch(). Migration 089 moved virality writes to
// their own table; these tests enforce the writer/schema agree.
//
// NOTE: a repo-wide "no two migrations redefine a table" sweep was considered
// but the codebase has 8 PRE-EXISTING differing re-CREATE pairs (workspaces,
// analytics_snapshots, email_sequences, review_requests, reviews,
// business_profiles, lead_scores, content_performance) where real columns were
// added by later ALTER TABLE. Auditing/whitelisting all 8 is out of Wave 1
// scope (flagged as a follow-up), so these tests target the fixed feature.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const ENGINE_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'wf1', 'engine.js'), 'utf8');

function allMigrationSql() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
}

test('schema-contract: content_virality_predictions is created with the columns the WF1 writer inserts', () => {
  const sql = allMigrationSql();
  const block = sql.match(/CREATE TABLE[^;]*content_virality_predictions[\s\S]*?\n\)\s*;/i);
  assert.ok(block, 'content_virality_predictions must be created in a migration');
  const writerColumns = [
    'business_id',
    'content_id',
    'virality_score',
    'predicted_engagement',
    'hook_strength',
    'retention_risk',
    'raw',
  ];
  const missing = writerColumns.filter((c) => !new RegExp(`\\b${c}\\b`).test(block[0]));
  assert.deepStrictEqual(missing, [], `content_virality_predictions missing writer columns: ${missing.join(', ')}`);
});

test('schema-contract: WF1 virality writer targets content_virality_predictions, never content_performance', () => {
  assert.match(
    ENGINE_SRC,
    /sbPost\(\s*['"]content_virality_predictions['"]/,
    'WF1 engine must write content_virality_predictions'
  );
  assert.ok(
    !/sbPost\(\s*['"]content_performance['"]/.test(ENGINE_SRC),
    'WF1 engine must NOT write content_performance (collides with migration 024 NOT NULL columns → silent insert failure)'
  );
});

test('schema-contract: content_performance retains its migration-024 measurement shape (not overwritten)', () => {
  // The 024 measurement table must still be the one with NOT NULL post_id —
  // proving we did not try to repurpose it for gen-time predictions.
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '024_wf1_content_engine.sql'), 'utf8');
  const block = sql.match(/CREATE TABLE[^;]*content_performance[\s\S]*?\n\)\s*;/i);
  assert.ok(block, '024 content_performance block must exist');
  assert.match(
    block[0],
    /post_id\s+UUID\s+NOT NULL/i,
    '024 content_performance keeps post_id NOT NULL (measurement table)'
  );
});
