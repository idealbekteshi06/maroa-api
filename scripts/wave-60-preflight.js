#!/usr/bin/env node
'use strict';

/**
 * scripts/wave-60-preflight.js
 *
 * Pre-deploy / pre-flip check for the Wave 60 agency-grade pipeline.
 * Reports — in one screen — exactly which boxes are still unchecked
 * before the feature flag can be turned on safely.
 *
 * Run:
 *   node scripts/wave-60-preflight.js
 *
 * Exit codes:
 *   0  all checks passed — safe to flip AGENCY_PIPELINE_ENABLED=1
 *   1  some checks failed — see report
 *
 * Reads, never writes. Safe to run against production.
 */

// Load .env if present, but don't hard-require dotenv (some envs ship without).
try {
  require('dotenv').config({ path: '.env' });
} catch {
  // No dotenv available — read .env manually if it exists, otherwise rely on process.env.
  try {
    const dotenvText = require('fs').readFileSync('.env', 'utf8');
    for (const line of dotenvText.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/i);
      if (m && process.env[m[1]] == null) {
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    // No .env file either — assume env already injected (Railway, Doppler, etc.)
  }
}

const fs = require('fs');
const path = require('path');
const https = require('https');

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

function ok(label, detail = '') {
  console.log(`  ${GREEN}✓${RESET} ${label} ${DIM}${detail}${RESET}`);
}
function warn(label, detail = '') {
  console.log(`  ${YELLOW}⚠${RESET} ${label} ${DIM}${detail}${RESET}`);
}
function fail(label, detail = '') {
  console.log(`  ${RED}✗${RESET} ${label} ${DIM}${detail}${RESET}`);
}
function section(title) {
  console.log(`\n${BOLD}${title}${RESET}`);
}

let failures = 0;
let warnings = 0;

// ─── 1. Code surface present ──────────────────────────────────────────────
section('1. Code surface');

const expectedFiles = [
  'services/prompts/methodologies/index.js',
  'services/prompts/channels/index.js',
  'services/prompts/compliance/index.js',
  'services/prompts/specialists/index.js',
  'services/agency-pipeline/index.js',
  'routes/agency-generate.js',
  'migrations/064_agency_pipeline_runs.sql',
];
for (const f of expectedFiles) {
  const p = path.join(process.cwd(), f);
  if (fs.existsSync(p)) ok(f);
  else {
    fail(f, 'MISSING');
    failures++;
  }
}

// ─── 2. Registry counts ───────────────────────────────────────────────────
section('2. Registry counts');

const expectedCounts = { methodologies: 29, channels: 35, compliance: 20, specialists: 7 };

try {
  const counts = {
    methodologies: require('../services/prompts/methodologies').listAllIds().length,
    channels: require('../services/prompts/channels').listAllIds().length,
    compliance: require('../services/prompts/compliance').listAllIds().length,
    specialists: require('../services/prompts/specialists').listAllIds().length,
  };
  for (const [k, expected] of Object.entries(expectedCounts)) {
    if (counts[k] === expected) ok(`${k}: ${counts[k]}/${expected}`);
    else {
      fail(`${k}: ${counts[k]}/${expected}`, 'count mismatch');
      failures++;
    }
  }
} catch (e) {
  fail('registry load', e.message);
  failures++;
}

// ─── 3. Env vars ──────────────────────────────────────────────────────────
section('3. Environment');

const requiredEnv = ['SUPABASE_URL', 'ANTHROPIC_KEY'];
const recommendedEnv = ['OPENAI_API_KEY', 'META_AD_LIBRARY_TOKEN', 'GOOGLE_PLACES_API_KEY', 'SLACK_ALERT_WEBHOOK_URL'];

for (const v of requiredEnv) {
  const has = process.env[v] || process.env[v.replace('_KEY', '_API_KEY')];
  if (has) ok(v);
  else {
    fail(v, 'required for pipeline to run');
    failures++;
  }
}
for (const v of recommendedEnv) {
  if (process.env[v]) ok(v);
  else {
    warn(v, 'recommended (corpus seeding + alerting will degrade)');
    warnings++;
  }
}

const flagOn = String(process.env.AGENCY_PIPELINE_ENABLED || '').match(/^(1|true|yes|on)$/i);
if (flagOn) ok('AGENCY_PIPELINE_ENABLED', '(pipeline route active)');
else warn('AGENCY_PIPELINE_ENABLED', 'feature flag OFF (set to "1" to enable)');

// ─── 4. Migration ledger check ────────────────────────────────────────────
section('4. Migration 064 (agency_pipeline_runs)');

async function checkMigration() {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!sbUrl || !sbKey) {
    warn('skipped', 'Supabase credentials not set');
    warnings++;
    return;
  }
  try {
    const u = new URL(`${sbUrl}/rest/v1/_migrations?filename=like.064%25`);
    const result = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          method: 'GET',
          headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, body: JSON.parse(body) });
            } catch {
              resolve({ status: res.statusCode, body: [] });
            }
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('timeout')));
      req.end();
    });

    if (result.status === 200 && Array.isArray(result.body) && result.body.length > 0) {
      ok('migration 064 applied', result.body[0].filename);
    } else {
      fail('migration 064 NOT in _migrations ledger', `apply migrations/064_agency_pipeline_runs.sql in Supabase SQL editor`);
      failures++;
    }
  } catch (e) {
    warn('could not verify', e.message);
    warnings++;
  }
}

// ─── 5. Table exists check ────────────────────────────────────────────────

async function checkTable() {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!sbUrl || !sbKey) return;
  try {
    const u = new URL(`${sbUrl}/rest/v1/agency_pipeline_runs?select=id&limit=1`);
    const result = await new Promise((resolve) => {
      const req = https.request(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          method: 'GET',
          headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on('error', () => resolve({ status: 0, body: 'network' }));
      req.setTimeout(5000, () => req.destroy());
      req.end();
    });
    if (result.status === 200) ok('agency_pipeline_runs table reachable');
    else if (result.status === 404 || /relation .* does not exist/i.test(result.body)) {
      fail('agency_pipeline_runs table missing', 'apply migration 064');
      failures++;
    } else if (result.status === 401 || result.status === 403) {
      warn('cannot query agency_pipeline_runs', 'RLS or auth — schema may still be applied');
      warnings++;
    } else {
      warn('agency_pipeline_runs check inconclusive', `status=${result.status}`);
      warnings++;
    }
  } catch (e) {
    warn('table probe failed', e.message);
    warnings++;
  }
}

// ─── 6. Optional smoke run ────────────────────────────────────────────────

async function smokeRun() {
  section('6. Smoke run (dry, no LLM)');
  try {
    const { runAgencyPipeline } = require('../services/agency-pipeline');
    const r = await runAgencyPipeline(
      {
        businessId: '00000000-0000-0000-0000-000000000000',
        goal: 'Write an Instagram caption for a café',
        channel: 'instagram-post',
        industry: 'cafe',
      },
      {}
    );
    if (r.ok && r.prompt_segments && r.prompt_segments.length > 5) {
      ok(`dry pipeline OK (${r.prompt_segments.length} prompt segments, specialist=${r.specialist.id})`);
    } else {
      fail('dry pipeline returned unexpected shape');
      failures++;
    }
  } catch (e) {
    fail('dry pipeline crashed', e.message);
    failures++;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

(async () => {
  await checkMigration();
  await checkTable();
  await smokeRun();

  console.log();
  console.log(`${BOLD}Summary${RESET}`);
  console.log(`  ${failures === 0 ? GREEN + 'PASS' + RESET : RED + 'FAIL' + RESET}  ${failures} failure(s), ${warnings} warning(s)`);
  if (failures === 0 && warnings === 0) {
    console.log(`\n  ${GREEN}Safe to flip AGENCY_PIPELINE_ENABLED=1${RESET}\n`);
  } else if (failures === 0) {
    console.log(`\n  ${YELLOW}Safe to enable, but resolve warnings for full quality${RESET}\n`);
  } else {
    console.log(`\n  ${RED}DO NOT enable yet — fix failures above${RESET}\n`);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
