#!/usr/bin/env node

'use strict';

/**
 * scripts/cost-report.js
 * ----------------------------------------------------------------------------
 * Daily cost report. Pulls llm_cost_logs from Supabase, computes spend per
 * business / per skill / per model, alerts if anomalies.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_KEY=... node scripts/cost-report.js
 *
 * Recommended cron:
 *   Every day at 09:00 UTC → run + post summary to Slack/email
 *
 * Alert thresholds (env-overridable):
 *   COST_ALERT_DAILY_USD=20    — total spend > $20/day
 *   COST_ALERT_PER_BIZ_USD=2   — single business > $2/day
 *   COST_ALERT_SPIKE_PCT=200   — today vs 7d avg > 200%
 * ----------------------------------------------------------------------------
 */

const https = require('https');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const COST_ALERT_DAILY_USD = Number(process.env.COST_ALERT_DAILY_USD) || 20;
const COST_ALERT_PER_BIZ_USD = Number(process.env.COST_ALERT_PER_BIZ_USD) || 2;
const COST_ALERT_SPIKE_PCT = Number(process.env.COST_ALERT_SPIKE_PCT) || 200;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('FAIL: SUPABASE_URL + SUPABASE_KEY required');
  process.exit(1);
}

function sbGet(table, query) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function fmt(amount) {
  return `$${Number(amount).toFixed(2)}`;
}

(async () => {
  const todayISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Last 24h
  const todayRows = await sbGet('llm_cost_logs', `created_at=gte.${todayISO}&order=created_at.desc&limit=50000&select=*`)
    .catch(() => []);

  // Last 7 days
  const weekRows = await sbGet('llm_cost_logs', `created_at=gte.${sevenDaysAgo}&order=created_at.desc&limit=200000&select=cost_usd,created_at`)
    .catch(() => []);

  const todayTotal = todayRows.reduce((s, r) => s + Number(r.cost_usd || 0), 0);
  const weekTotal = weekRows.reduce((s, r) => s + Number(r.cost_usd || 0), 0);
  const dailyAvg7d = weekTotal / 7;

  // Per-business breakdown
  const byBusiness = new Map();
  for (const r of todayRows) {
    byBusiness.set(r.business_id, (byBusiness.get(r.business_id) || 0) + Number(r.cost_usd || 0));
  }

  // Per-skill breakdown
  const bySkill = new Map();
  for (const r of todayRows) {
    bySkill.set(r.skill, (bySkill.get(r.skill) || 0) + Number(r.cost_usd || 0));
  }

  // Per-model breakdown
  const byModel = new Map();
  for (const r of todayRows) {
    byModel.set(r.model, (byModel.get(r.model) || 0) + Number(r.cost_usd || 0));
  }

  // Print report
  console.log('═══════════════ Maroa Daily Cost Report ═══════════════');
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log('');
  console.log(`Last 24h spend:  ${fmt(todayTotal)}`);
  console.log(`Last 7d spend:   ${fmt(weekTotal)}`);
  console.log(`7d daily avg:    ${fmt(dailyAvg7d)}`);
  console.log(`24h calls:       ${todayRows.length}`);
  console.log(`Avg cost/call:   ${todayRows.length ? fmt(todayTotal / todayRows.length) : 'N/A'}`);

  console.log('\n── Top 10 businesses by 24h cost ──');
  [...byBusiness.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([bid, cost]) => console.log(`  ${bid.slice(0, 8)}...: ${fmt(cost)}`));

  console.log('\n── By skill (24h) ──');
  [...bySkill.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([s, cost]) => console.log(`  ${s.padEnd(25)} ${fmt(cost)}`));

  console.log('\n── By model (24h) ──');
  [...byModel.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([m, cost]) => console.log(`  ${m.padEnd(25)} ${fmt(cost)}`));

  // Alerts
  console.log('\n── ALERTS ──');
  let alerted = false;

  if (todayTotal > COST_ALERT_DAILY_USD) {
    console.log(`🚨 ALERT: 24h spend ${fmt(todayTotal)} exceeds threshold ${fmt(COST_ALERT_DAILY_USD)}`);
    alerted = true;
  }

  for (const [bid, cost] of byBusiness) {
    if (cost > COST_ALERT_PER_BIZ_USD) {
      console.log(`🚨 ALERT: Business ${bid.slice(0, 8)} spent ${fmt(cost)} (>${fmt(COST_ALERT_PER_BIZ_USD)})`);
      alerted = true;
    }
  }

  const spikePct = dailyAvg7d > 0 ? ((todayTotal - dailyAvg7d) / dailyAvg7d) * 100 : 0;
  if (spikePct > COST_ALERT_SPIKE_PCT) {
    console.log(`🚨 ALERT: Today is ${spikePct.toFixed(0)}% above 7d avg`);
    alerted = true;
  }

  if (!alerted) console.log('✅ No alerts. Within budget.');
})().catch(e => {
  console.error('Cost report failed:', e.message);
  process.exit(1);
});
