#!/usr/bin/env node
// scripts/apply-migrations.mjs
// ---------------------------------------------------------------------------
// Opt-in migration runner — turns "paste each migrations/NNN_*.sql into the
// Supabase SQL editor" into one command:  npm run db:migrate
//
//   DATABASE_URL=postgresql://...supabase.co:5432/postgres npm run db:migrate
//   npm run db:migrate -- --dry-run     # list pending, apply nothing
//
// The app talks to Supabase via PostgREST, which cannot run DDL — hence there
// is no in-app auto-runner. This script connects DIRECTLY to Postgres using a
// connection string you provide (Supabase → Project Settings → Database →
// Connection string). It is SAFE: opt-in (only runs when invoked), takes a
// session advisory lock so two runners can't race, applies each migration that
// isn't already in the `_migrations` ledger (in filename order), and records
// each applied file + sha256 checksum. Migrations that manage their own
// BEGIN/COMMIT (086, 087, …) stay atomic; on the first failure it stops.
//
// It does NOT run on boot or deploy and does nothing without DATABASE_URL, so
// it cannot break the running server.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const DRY_RUN = process.argv.includes('--dry-run');
const LOCK_KEY = 4_891_207; // arbitrary fixed key for pg_advisory_lock

const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '';
if (!connectionString) {
  console.error(
    'DATABASE_URL not set. Provide the Supabase direct-connection string, e.g.\n' +
      '  DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres npm run db:migrate'
  );
  process.exit(1);
}

let Client;
try {
  ({ Client } = await import('pg'));
} catch {
  console.error("The 'pg' package is not installed. Run `npm install` (it is a declared dependency) and retry.");
  process.exit(1);
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

// Numbered migration files only (NNN_*.sql), in order. Skips RESERVED/non-sql.
function pendingFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

const client = new Client({
  connectionString,
  // Supabase requires TLS; the managed cert chain isn't always in the local store.
  ssl: { rejectUnauthorized: false },
});

let locked = false;
try {
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   text PRIMARY KEY,
      checksum   text,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  locked = true;

  const appliedRows = await client.query('SELECT filename FROM _migrations');
  const already = new Set(appliedRows.rows.map((r) => r.filename));

  const all = pendingFiles();
  const pending = all.filter((f) => !already.has(f));

  if (!pending.length) {
    console.log(`Up to date — ${all.length} migrations, 0 pending.`);
  } else if (DRY_RUN) {
    console.log(`DRY RUN — ${pending.length} pending migration(s):`);
    for (const f of pending) console.log(`  • ${f}`);
  } else {
    console.log(`Applying ${pending.length} migration(s)...`);
    let applied = 0;
    for (const filename of pending) {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
      try {
        await client.query(sql); // file manages its own BEGIN/COMMIT if present
        await client.query(
          `INSERT INTO _migrations (filename, checksum, applied_at)
           VALUES ($1, $2, now())
           ON CONFLICT (filename) DO UPDATE SET checksum = excluded.checksum, applied_at = now()`,
          [filename, sha256(sql)]
        );
        applied += 1;
        console.log(`  ✓ ${filename}`);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`  ✗ ${filename} — ${e.message}`);
        console.error('Stopping. Fix the migration and re-run; already-applied files are skipped.');
        process.exitCode = 1;
        break;
      }
    }
    console.log(`Done — ${applied}/${pending.length} applied.`);
  }
} catch (e) {
  console.error('Migration run failed:', e.message);
  process.exitCode = 1;
} finally {
  if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
  await client.end().catch(() => {});
}
