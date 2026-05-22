'use strict';

/**
 * lib/platformOps.js — operator snapshot (migrations, dispatcher, Inngest).
 */

const fs = require('fs');
const path = require('path');
const internalDispatcher = require('./internalDispatcher');

const CRITICAL_MIGRATIONS = ['079_wf11_smart_routing.sql', '080_quality_gate_runs.sql'];

async function probeMigrationsLedger(sbGet) {
  const filesystem = CRITICAL_MIGRATIONS.map((filename) => {
    const full = path.join(__dirname, '..', 'migrations', filename);
    return { filename, exists_on_disk: fs.existsSync(full) };
  });

  if (!sbGet) {
    return { ok: null, filesystem, applied: [], missing_in_db: CRITICAL_MIGRATIONS };
  }

  try {
    const inList = CRITICAL_MIGRATIONS.map((f) => encodeURIComponent(f)).join(',');
    const rows = await sbGet('_migrations', `filename=in.(${inList})&select=filename,applied_at`);
    const appliedSet = new Set((rows || []).map((r) => r.filename));
    const missing_in_db = CRITICAL_MIGRATIONS.filter((f) => !appliedSet.has(f));
    return {
      ok: missing_in_db.length === 0,
      filesystem,
      applied: rows || [],
      missing_in_db,
    };
  } catch (e) {
    return {
      ok: null,
      filesystem,
      applied: [],
      missing_in_db: CRITICAL_MIGRATIONS,
      ledger_error: e.message,
    };
  }
}

function getPlatformSnapshot({ inngestFunctionCount = null } = {}) {
  const snap = internalDispatcher.snapshot();
  return {
    generated_at: new Date().toISOString(),
    inngest_functions_registered: inngestFunctionCount,
    internal_dispatcher: snap,
    critical_migrations: CRITICAL_MIGRATIONS,
  };
}

module.exports = {
  probeMigrationsLedger,
  getPlatformSnapshot,
  CRITICAL_MIGRATIONS,
};
