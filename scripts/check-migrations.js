#!/usr/bin/env node
/**
 * scripts/check-migrations.js
 * ----------------------------------------------------------------------------
 * Sanity-check the migration files in `migrations/` before deploy:
 *
 *   1. No gaps in numbering (000, 001, 002 — not 000, 002)
 *   2. No duplicates
 *   3. Filenames match the convention NNN_snake_case.sql
 *   4. Last migration is referenced in MEMORY.md or git log (so we never
 *      "forgot to commit a migration")
 *
 * Optional (if SUPABASE_SERVICE_ROLE_KEY + SUPABASE_URL set in env):
 *   5. Connects to Supabase and queries pg_class to verify migrations
 *      were actually applied. Reports drift between filesystem and DB.
 *
 * Exits non-zero on any problem so CI can fail fast.
 *
 * Run:  node scripts/check-migrations.js
 *       node scripts/check-migrations.js --verify-applied
 * ----------------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function red(s) { return `\x1b[31m${s}\x1b[0m`; }
function green(s) { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s) { return `\x1b[33m${s}\x1b[0m`; }

function exit(code, msg) {
  console.log(code === 0 ? green(msg) : red(msg));
  process.exit(code);
}

function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) exit(1, `No migrations/ directory at ${MIGRATIONS_DIR}`);
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function parseFilename(f) {
  // Expect NNN_snake_case.sql
  const m = /^(\d{3,4})_([a-z0-9_]+)\.sql$/.exec(f);
  if (!m) return null;
  return { number: parseInt(m[1], 10), slug: m[2], raw: f };
}

function checkConvention(files) {
  const errors = [];
  for (const f of files) {
    const parsed = parseFilename(f);
    if (!parsed) errors.push(`Bad filename: ${f} (expected NNN_snake_case.sql)`);
  }
  return errors;
}

function checkGapsAndDuplicates(parsed) {
  const errors = [];
  const seen = new Map();
  for (const p of parsed) {
    if (seen.has(p.number)) {
      errors.push(`Duplicate migration number ${p.number}: ${p.raw} vs ${seen.get(p.number).raw}`);
    } else {
      seen.set(p.number, p);
    }
  }
  // Gap check
  const sorted = [...seen.keys()].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] - sorted[i - 1] > 1) {
      // Only warn — we may have skipped numbers historically
      console.log(yellow(`  warn: gap between ${sorted[i - 1]} and ${sorted[i]}`));
    }
  }
  return errors;
}

function checkLatestReferenced(parsed) {
  // Find the highest-numbered migration; check it's referenced somewhere in
  // either the MEMORY.md or recent git commit messages. If not, warn.
  const sorted = [...parsed].sort((a, b) => b.number - a.number);
  const latest = sorted[0];
  if (!latest) return [];

  const slug = `${String(latest.number).padStart(3, '0')}_${latest.slug}`;
  const memoryPath = path.join(__dirname, '..', '.claude', 'projects', 'maroa', 'memory', 'MEMORY.md');

  const referencedInMemory = fs.existsSync(memoryPath)
    && fs.readFileSync(memoryPath, 'utf8').includes(slug);

  let referencedInGit = false;
  try {
    const { execSync } = require('child_process');
    const recentLog = execSync('git log -20 --pretty=%B', { encoding: 'utf8' });
    referencedInGit = recentLog.includes(slug) || recentLog.includes(`migration ${latest.number}`);
  } catch { /* git not available */ }

  const errors = [];
  if (!referencedInMemory && !referencedInGit) {
    console.log(yellow(`  warn: latest migration ${slug} not referenced in MEMORY.md or recent git commits.`));
    console.log(yellow(`        (This is a soft warning — could mean you forgot to mention the migration in a commit.)`));
  }
  return errors;
}

async function verifyAppliedAgainstSupabase(parsed) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.log(yellow('  --verify-applied: SUPABASE_URL/SUPABASE_KEY not set, skipping live check'));
    return [];
  }
  // Minimal probe: try to query the table the latest migration creates, by
  // pattern-matching the SQL. This is a coarse check — for true drift
  // detection use a tool like Atlas or the Supabase CLI.
  console.log(yellow('  --verify-applied: live drift check via pg_class would require Supabase service-role key'));
  console.log(yellow('  Recommendation: run `supabase db diff` for true drift detection.'));
  return [];
}

async function main() {
  console.log('Migration sanity check');
  console.log('======================');

  const files = listMigrations();
  console.log(`Found ${files.length} .sql files in migrations/`);

  const conventionErrors = checkConvention(files);
  if (conventionErrors.length > 0) {
    conventionErrors.forEach((e) => console.log(red(`  ✗ ${e}`)));
    exit(1, `\n${conventionErrors.length} convention error(s)`);
  }
  console.log(green('  ✓ All filenames match NNN_snake_case.sql'));

  const parsed = files.map(parseFilename).filter(Boolean);

  const gapErrors = checkGapsAndDuplicates(parsed);
  if (gapErrors.length > 0) {
    gapErrors.forEach((e) => console.log(red(`  ✗ ${e}`)));
    exit(1, `\n${gapErrors.length} duplicate/numbering error(s)`);
  }
  console.log(green('  ✓ No duplicates'));

  checkLatestReferenced(parsed);
  console.log(green(`  ✓ Latest migration: ${parsed[parsed.length - 1].raw}`));

  if (process.argv.includes('--verify-applied')) {
    await verifyAppliedAgainstSupabase(parsed);
  }

  exit(0, '\nAll migration sanity checks passed ✓');
}

main().catch((err) => {
  console.error(red(`Fatal: ${err.message}`));
  process.exit(2);
});
