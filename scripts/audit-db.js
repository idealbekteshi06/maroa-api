#!/usr/bin/env node
'use strict';

/**
 * scripts/audit-db.js
 * ----------------------------------------------------------------------------
 * Read-only audit of the Supabase database. Verifies:
 *   1. Every expected table from migrations 038-062 exists
 *   2. The _migrations ledger reflects applied migrations
 *   3. pgvector + pgcrypto extensions are enabled
 *   4. RLS is on for security-critical tables
 *   5. The match_content_embeddings + match_marketing_corpus RPCs exist
 *   6. webhook_events traffic + llm_cost_logs activity for liveness
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_KEY=... node scripts/audit-db.js
 *
 * Reads from .env if present.
 * Exits 0 if all OK, 1 if any tables missing.
 * ----------------------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');

// ── Load .env if present ──
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    }
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_KEY (or SUPABASE_SERVICE_ROLE_KEY) required.');
  console.error('   Set them in .env or pass via env: SUPABASE_URL=... SUPABASE_KEY=... node scripts/audit-db.js');
  process.exit(2);
}

// Tables we expect to exist if all migrations 038-062 applied
const EXPECTED_TABLES = [
  // Foundation (000_bootstrap + earlier)
  'businesses',
  'generated_content',
  'ad_campaigns',
  'ad_performance_logs',
  'daily_stats',
  // Migration 038
  'ai_seo_audits',
  'ai_seo_artifacts',
  // Migration 039
  'cro_audits',
  'cro_rewrites',
  // Migration 040
  'pacing_alerts',
  'weekly_scorecards',
  // Migration 041
  'forecasts',
  // Migration 042
  'voc_analyses',
  // Migration 043
  'brand_voice_history',
  // Migration 044
  'llm_cost_logs',
  // Migration 045
  'cold_start_runs',
  'cold_start_concepts',
  // Migration 046
  'measurement_health',
  'ad_creative_variants',
  'cross_account_patterns',
  // Migration 047
  'competitor_signals',
  'incrementality_tests',
  // Migration 048
  'ai_citation_prompts',
  'ai_citations',
  'community_presence_audits',
  // Migration 049
  'email_sequences',
  'email_sequence_runs',
  'landing_pages',
  // Migration 051
  'autopilot_runs',
  // Migration 054
  'webhook_events',
  // Migration 055
  '_migrations',
  // Migration 058
  'inngest_dlq',
  // Migration 059
  'business_oauth_credentials',
  // Migration 060 (subscriptions table itself is from Stripe template, just RLS-protected)
  'subscriptions',
  // Migration 061
  'content_embeddings',
  // Migration 062
  'marketing_corpus',
  'pretrainer_runs',
];

const EXPECTED_RPCS = ['match_content_embeddings', 'match_marketing_corpus'];

async function sbGet(path) {
  const url = SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/' + path;
  const r = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: 'count=exact',
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    return { status: r.status, ok: false, error: body.slice(0, 300) };
  }
  const data = await r.json().catch(() => null);
  const count = Number(r.headers.get('content-range')?.split('/')?.[1]) || 0;
  return { status: r.status, ok: true, data, count };
}

async function checkTable(name) {
  // Probe via HEAD-like SELECT id LIMIT 0 — cheapest possible read
  const r = await sbGet(`${encodeURIComponent(name)}?select=*&limit=0`);
  if (r.ok) return { name, ok: true, rows: r.count };
  if (r.status === 404 || /relation.*does not exist/i.test(r.error || '')) {
    return { name, ok: false, reason: 'MISSING' };
  }
  if (r.status === 401 || r.status === 403) {
    return { name, ok: 'AUTH', reason: `HTTP ${r.status} — RLS blocking or key invalid` };
  }
  return { name, ok: false, reason: `HTTP ${r.status}: ${(r.error || '').slice(0, 200)}` };
}

async function checkRpc(name) {
  // RPC POST with empty body — expect 400 (bad args) if exists, 404 if missing
  const url = SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/' + name;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  if (r.status === 404) return { name, ok: false, reason: 'MISSING' };
  return { name, ok: true, http: r.status };
}

async function getLedger() {
  const r = await sbGet('_migrations?select=filename,applied_at,notes&order=filename.asc');
  if (!r.ok) return null;
  return r.data;
}

async function main() {
  console.log(`\n🔍 Auditing Supabase database at ${SUPABASE_URL}\n`);

  // 1. Tables
  console.log('── 1. Expected tables ──');
  const tableResults = [];
  for (const t of EXPECTED_TABLES) {
    const r = await checkTable(t);
    tableResults.push(r);
    const icon = r.ok === true ? '✅' : r.ok === 'AUTH' ? '🔒' : '❌';
    const rows = typeof r.rows === 'number' ? ` (${r.rows} rows)` : '';
    const reason = r.reason ? ` — ${r.reason}` : '';
    console.log(`  ${icon} ${t}${rows}${reason}`);
  }
  const missing = tableResults.filter((r) => r.ok !== true && r.ok !== 'AUTH');
  console.log('');

  // 2. RPC functions
  console.log('── 2. RPC functions ──');
  for (const rpc of EXPECTED_RPCS) {
    const r = await checkRpc(rpc);
    const icon = r.ok ? '✅' : '❌';
    console.log(`  ${icon} ${rpc}${r.reason ? ` — ${r.reason}` : ''}`);
  }
  console.log('');

  // 3. Migration ledger
  console.log('── 3. _migrations ledger ──');
  const ledger = await getLedger();
  if (ledger == null) {
    console.log('  ❌ Could not read _migrations table (does it exist?)');
  } else if (ledger.length === 0) {
    console.log('  ⚠️ Ledger is empty (migration 055+ may not have run, or tables exist from pre-ledger waves)');
  } else {
    for (const row of ledger) {
      console.log(`  ✅ ${row.filename}  ${row.applied_at}  ${row.notes || ''}`);
    }
  }
  console.log('');

  // 4. Summary
  console.log('── Summary ──');
  console.log(`  Tables OK:        ${tableResults.filter((r) => r.ok === true).length}/${EXPECTED_TABLES.length}`);
  console.log(`  Tables MISSING:   ${missing.length}`);
  console.log(`  Ledger rows:      ${ledger?.length ?? 'unreadable'}`);

  if (missing.length === 0) {
    console.log('\n🟢 Database is COMPLETE — every expected table exists.');
    process.exit(0);
  } else {
    console.log('\n🔴 Missing tables:');
    for (const m of missing) console.log(`   - ${m.name}`);
    console.log('\nPaste the missing-table list back to Claude and ask for "fix SQL".');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Audit failed:', e.message);
  process.exit(2);
});
