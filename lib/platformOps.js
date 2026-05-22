'use strict';

/**
 * lib/platformOps.js — operator snapshot (migrations, dispatcher, Inngest).
 */

const fs = require('fs');
const path = require('path');
const internalDispatcher = require('./internalDispatcher');

/** Migration filename → table that must exist when applied (PostgREST probe). */
const CRITICAL_MIGRATION_TABLES = [
  { migration: '079_wf11_smart_routing.sql', table: 'inbox_routing_settings' },
  { migration: '080_quality_gate_runs.sql', table: 'quality_gate_runs' },
];

const CRITICAL_MIGRATIONS = CRITICAL_MIGRATION_TABLES.map((m) => m.migration);

function _migrationFilesystemSnapshot() {
  return CRITICAL_MIGRATIONS.map((filename) => {
    const full = path.join(__dirname, '..', 'migrations', filename);
    return { filename, exists_on_disk: fs.existsSync(full) };
  });
}

function _isMissingTableError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('does not exist') ||
    msg.includes('relation') ||
    msg.includes('404') ||
    msg.includes('42p01')
  );
}

/**
 * Verify critical migrations by probing live tables (not _migrations ledger).
 * Tables may exist when SQL was applied manually or ledger rows were never inserted.
 */
async function probeCriticalMigrations(sbGet) {
  const filesystem = _migrationFilesystemSnapshot();

  if (!sbGet) {
    return {
      ok: null,
      method: 'table_probe',
      filesystem,
      tables: [],
      applied: [],
      missing_in_db: CRITICAL_MIGRATIONS,
    };
  }

  const tables = [];
  const missing_in_db = [];

  for (const { migration, table } of CRITICAL_MIGRATION_TABLES) {
    try {
      await sbGet(table, 'select=id&limit=1');
      tables.push({ migration, table, exists: true });
    } catch (e) {
      if (_isMissingTableError(e)) {
        tables.push({ migration, table, exists: false });
        missing_in_db.push(migration);
        continue;
      }
      return {
        ok: null,
        method: 'table_probe',
        filesystem,
        tables,
        applied: tables.filter((t) => t.exists).map((t) => ({ migration: t.migration, table: t.table })),
        missing_in_db: CRITICAL_MIGRATIONS,
        probe_error: e.message,
      };
    }
  }

  return {
    ok: missing_in_db.length === 0,
    method: 'table_probe',
    filesystem,
    tables,
    applied: tables.filter((t) => t.exists).map((t) => ({ migration: t.migration, table: t.table })),
    missing_in_db,
  };
}

/** @deprecated Use probeCriticalMigrations — kept for existing call sites. */
const probeMigrationsLedger = probeCriticalMigrations;

function getPlatformSnapshot({ inngestFunctionCount = null } = {}) {
  const snap = internalDispatcher.snapshot();
  return {
    generated_at: new Date().toISOString(),
    inngest_functions_registered: inngestFunctionCount,
    internal_dispatcher: snap,
    critical_migrations: CRITICAL_MIGRATIONS,
    critical_migration_tables: CRITICAL_MIGRATION_TABLES.map((m) => m.table),
  };
}

module.exports = {
  probeCriticalMigrations,
  probeMigrationsLedger,
  getPlatformSnapshot,
  CRITICAL_MIGRATIONS,
  CRITICAL_MIGRATION_TABLES,
};
