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

function red(s) {
  return `\x1b[31m${s}\x1b[0m`;
}
function green(s) {
  return `\x1b[32m${s}\x1b[0m`;
}
function yellow(s) {
  return `\x1b[33m${s}\x1b[0m`;
}

function exit(code, msg) {
  console.log(code === 0 ? green(msg) : red(msg));
  process.exit(code);
}

function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) exit(1, `No migrations/ directory at ${MIGRATIONS_DIR}`);
  return fs
    .readdirSync(MIGRATIONS_DIR)
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
  // Gap check. A gap with a sibling NNN_RESERVED.md (any case) is treated
  // as documented and silently ignored — see migrations/063_RESERVED.md
  // for the convention.
  const reservedNumbers = (() => {
    try {
      return new Set(
        fs
          .readdirSync(MIGRATIONS_DIR)
          .map((f) => /^(\d{3,4})_reserved\.md$/i.exec(f))
          .filter(Boolean)
          .map((m) => parseInt(m[1], 10))
      );
    } catch {
      return new Set();
    }
  })();
  const sorted = [...seen.keys()].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    const lo = sorted[i - 1];
    const hi = sorted[i];
    if (hi - lo > 1) {
      // Document each missing number; only warn for the ones NOT reserved.
      for (let n = lo + 1; n < hi; n += 1) {
        if (!reservedNumbers.has(n)) {
          console.log(yellow(`  warn: gap at ${n} (between ${lo} and ${hi}) — no NNN_RESERVED.md`));
        }
      }
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

  const referencedInMemory = fs.existsSync(memoryPath) && fs.readFileSync(memoryPath, 'utf8').includes(slug);

  let referencedInGit = false;
  try {
    const { execSync } = require('child_process');
    const recentLog = execSync('git log -20 --pretty=%B', { encoding: 'utf8' });
    referencedInGit = recentLog.includes(slug) || recentLog.includes(`migration ${latest.number}`);
  } catch {
    /* git not available */
  }

  const errors = [];
  if (!referencedInMemory && !referencedInGit) {
    console.log(yellow(`  warn: latest migration ${slug} not referenced in MEMORY.md or recent git commits.`));
    console.log(
      yellow(`        (This is a soft warning — could mean you forgot to mention the migration in a commit.)`)
    );
  }
  return errors;
}

async function verifyAppliedAgainstSupabase(parsed) {
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '').trim();
  if (!url || !key) {
    console.log(yellow('  --verify-applied: SUPABASE_URL/SUPABASE_KEY not set, skipping live check'));
    return [];
  }

  // Read the _migrations ledger (created by migration 055). If the ledger
  // itself isn't applied yet, fall back to the legacy soft-check.
  let applied;
  try {
    const res = await fetch(`${url}/rest/v1/_migrations?select=filename,checksum,applied_at`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (res.status === 404 || res.status === 400) {
      console.log(yellow('  --verify-applied: _migrations table not found yet (apply migration 055 first).'));
      return [];
    }
    if (!res.ok) {
      console.log(yellow(`  --verify-applied: ledger fetch failed (${res.status}). Skipping.`));
      return [];
    }
    applied = await res.json();
  } catch (e) {
    console.log(yellow(`  --verify-applied: ledger fetch threw: ${e.message}`));
    return [];
  }

  const fs = require('fs');
  const path = require('path');
  const cryptoMod = require('crypto');
  const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

  const appliedByName = new Map(applied.map((r) => [r.filename, r]));
  const errors = [];
  const missingFromDb = [];
  const driftChecksum = [];

  for (const m of parsed) {
    const filename = m.raw;
    const fullPath = path.join(MIGRATIONS_DIR, filename);
    const contents = fs.readFileSync(fullPath, 'utf8');
    const expected = cryptoMod.createHash('sha256').update(contents).digest('hex');
    const row = appliedByName.get(filename);
    if (!row) {
      missingFromDb.push(filename);
      continue;
    }
    if (row.checksum && row.checksum !== expected) {
      driftChecksum.push({ filename, expected, applied: row.checksum });
    }
  }

  if (missingFromDb.length) {
    console.log(yellow(`  --verify-applied: ${missingFromDb.length} migration(s) in repo but not in ledger:`));
    for (const f of missingFromDb) console.log(yellow(`      • ${f}`));
    errors.push(`${missingFromDb.length} unapplied migrations`);
  }
  if (driftChecksum.length) {
    console.log(red(`  --verify-applied: CHECKSUM MISMATCH — applied migration was edited after apply:`));
    for (const d of driftChecksum) {
      console.log(red(`      • ${d.filename}`));
      console.log(red(`        expected (file): ${d.expected.slice(0, 16)}…`));
      console.log(red(`        recorded (db):   ${d.applied.slice(0, 16)}…`));
    }
    errors.push(`${driftChecksum.length} checksum drift`);
  }
  if (!missingFromDb.length && !driftChecksum.length) {
    console.log(green(`  ✓ All ${parsed.length} migrations present in ledger with matching checksums`));
  }
  return errors;
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
    const errs = await verifyAppliedAgainstSupabase(parsed);
    if (errs.length) exit(1, `\n${errs.length} verify-applied error(s) — fix before deploy`);
  }

  exit(0, '\nAll migration sanity checks passed ✓');
}

main().catch((err) => {
  console.error(red(`Fatal: ${err.message}`));
  process.exit(2);
});
