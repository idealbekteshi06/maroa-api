#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

/**
 * Run all Maroa data seeds in order.
 * Usage: SUPABASE_URL=... SUPABASE_KEY=... node scripts/seed-all.js
 */

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const STEPS = [
  { name: 'industry benchmarks', script: 'seed-industry-benchmarks.js' },
  { name: 'cafe marketing corpus', script: 'seed-cafe-corpus.js' },
  { name: 'synthetic clients', script: 'seed-synthetic-clients.js' },
];

function run(script) {
  const full = path.join(__dirname, script);
  console.log(`\n[seed-all] → ${script}`);
  const args = [full];
  if (process.argv.includes('--dry-run')) args.push('--dry-run');
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (r.status !== 0) {
    throw new Error(`${script} exited ${r.status}`);
  }
}

async function verify() {
  const { getSeedConfig, sbSelect } = require('./lib/seedSupabase');
  if (!getSeedConfig().ok) {
    console.warn('[seed-all] skip verify — no Supabase env');
    return;
  }
  const benchmarks = await sbSelect('industry_benchmarks', 'select=industry');
  const seeds = await sbSelect('businesses', 'business_name=like.SEED_*&select=business_name');
  const corpus = await sbSelect('marketing_corpus', 'source=eq.manual_curation&select=id&limit=5');
  console.log('\n[seed-all] verify:');
  console.log(`  industry_benchmarks: ${Array.isArray(benchmarks) ? benchmarks.length : 0}`);
  console.log(`  SEED_ businesses: ${Array.isArray(seeds) ? seeds.length : 0}`);
  console.log(`  cafe corpus sample: ${Array.isArray(corpus) ? corpus.length : 0}+ rows`);
}

async function main() {
  for (const step of STEPS) {
    run(step.script);
  }
  await verify();
  console.log('\n[seed-all] complete');
}

main().catch((e) => {
  console.error('[seed-all] failed:', e.message);
  process.exit(1);
});
