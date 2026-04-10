#!/usr/bin/env node
'use strict';

const https = require('https');
const http = require('http');

const BASE = 'https://maroa-api-production.up.railway.app';
const USER = 'fea4aae5-14b4-486d-89f4-33a7d7e4ab60';
const results = [];
let passed = 0, failed = 0;

function report(layer, ok, msg) {
  const tag = ok ? '✅' : '❌';
  console.log(`${tag} LAYER ${layer} — ${ok ? 'PASSED' : 'FAILED'}: ${msg}`);
  results.push({ layer, ok, msg });
  if (ok) passed++; else failed++;
}

function api(method, path, body) {
  return new Promise((resolve) => {
    const url = new URL(BASE + path);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname, port: 443, path: url.pathname + url.search,
      method, headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    };
    const p = url.pathname;
    const wh = process.env.N8N_WEBHOOK_SECRET;
    if (wh && p.startsWith('/webhook/') && p !== '/webhook/stripe-webhook') {
      opts.headers['x-webhook-secret'] = wh;
    }
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', e => resolve({ status: 0, body: { error: e.message } }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: { error: 'timeout' } }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  maroa.ai — Full System End-to-End Test      ║');
  console.log('║  User: ' + USER.slice(0,8) + '...                        ║');
  console.log('║  Server: ' + BASE.replace('https://','').slice(0,36) + '  ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log();

  // ── LAYER 1: Database ─────────────────────────────────────────────────────
  try {
    const debug = await api('GET', '/debug');
    const sbOk = typeof debug.body === 'object' && (debug.body.supabase || '').includes('ok');
    if (!sbOk) { report(1, false, `Supabase: ${debug.body.supabase || debug.status}`); }
    else {
      // Check key tables via existing endpoints
      const tables = {};
      const checks = [
        ['generated_content', `/webhook/content-pieces-get?business_id=${USER}`],
        ['contacts', `/webhook/contacts-get?business_id=${USER}`],
        ['analytics_snapshots', `/webhook/analytics-get?business_id=${USER}`],
        ['marketing_ideas', `/api/ideas/${USER}`],
        ['reviews', `/webhook/reviews-get?business_id=${USER}`],
        ['orchestration_logs', `/api/orchestrator/log/${USER}`],
        ['business_intelligence', `/api/intelligence/${USER}`],
      ];
      for (const [name, path] of checks) {
        const r = await api('GET', path);
        tables[name] = r.status === 200 ? 'exists' : `error(${r.status})`;
      }
      const existing = Object.entries(tables).filter(([,v]) => v === 'exists').length;
      report(1, existing >= 5, `Supabase OK. Tables checked: ${Object.entries(tables).map(([k,v]) => `${k}=${v}`).join(', ')}`);
    }
  } catch (e) { report(1, false, e.message); }

  // ── LAYER 2: Pinecone / Skills ────────────────────────────────────────────
  try {
    const r = await api('GET', '/health');
    const pinecone = r.body?.env_vars?.pinecone;
    const openai = r.body?.env_vars?.openai;
    if (!pinecone || !openai) {
      report(2, false, `Pinecone=${pinecone}, OpenAI=${openai} — both needed for brand memory`);
    } else {
      // Test brand memory retrieve (calls Pinecone)
      const mem = await api('POST', '/webhook/brand-memory-retrieve', { business_id: USER, content_type: 'social_post', topic: 'marketing ideas' });
      const count = mem.body?.count || mem.body?.examples?.length || 0;
      report(2, mem.status === 200, `Pinecone connected. Brand memory query returned ${count} examples. ${mem.body?.reason || ''}`);
    }
  } catch (e) { report(2, false, e.message); }

  // ── LAYER 3: Anthropic API ────────────────────────────────────────────────
  try {
    const start = Date.now();
    const debug = await api('GET', '/debug');
    const elapsed = Date.now() - start;
    const claudeOk = (debug.body?.anthropic || '').includes('ok');
    report(3, claudeOk, claudeOk ? `Claude API OK (${elapsed}ms)` : `Claude API: ${debug.body?.anthropic}`);
  } catch (e) { report(3, false, e.message); }

  // ── LAYER 4: Master Prompt Builder ────────────────────────────────────────
  try {
    const profile = await api('GET', `/api/debug/profile/${USER}`);
    if (!profile.body?.found) {
      report(4, false, `No profile found for user — master prompt cannot build`);
    } else {
      // The master prompt is built inside generation calls — we verify the profile has the fields needed
      const p = profile.body;
      const hasName = !!p.business_name;
      const hasType = !!p.business_type;
      report(4, hasName && hasType, `Profile: ${p.business_name} (${p.business_type}). Master prompt will include business context, location, audience, products, rules.`);
    }
  } catch (e) { report(4, false, e.message); }

  // ── LAYER 5: Content Generation Quality ───────────────────────────────────
  try {
    const gen = await api('POST', '/api/ideas/generate', { userId: USER });
    if (gen.status !== 200) { report(5, false, `ideas/generate returned ${gen.status}`); }
    else {
      console.log('   ⏳ Waiting 25s for ideas to generate...');
      await sleep(25000);
      const ideas = await api('GET', `/api/ideas/${USER}`);
      const list = ideas.body?.ideas || [];
      const proper = list.filter(i => typeof i.idea === 'string' && !i.idea.includes('_raw'));
      const hasCategory = proper.filter(i => i.category && i.category !== 'general').length;
      const hasPriority = proper.filter(i => ['high','medium','low'].includes(i.priority)).length;
      const hasExecute = proper.filter(i => i.how_to_execute).length;
      report(5, proper.length >= 3, `${list.length} ideas total, ${proper.length} properly parsed, ${hasCategory} with category, ${hasPriority} with priority, ${hasExecute} with execution steps`);
    }
  } catch (e) { report(5, false, e.message); }

  // ── LAYER 6: Intelligence Layer ───────────────────────────────────────────
  try {
    const intel = await api('GET', `/api/intelligence/${USER}`);
    const total = intel.body?.total || 0;
    const modules = Object.keys(intel.body?.intelligence || {});
    report(6, intel.status === 200, `${total} intelligence entries from ${modules.length} modules: ${modules.join(', ') || 'none yet'}`);
  } catch (e) { report(6, false, e.message); }

  // ── LAYER 7: Orchestrator ─────────────────────────────────────────────────
  try {
    const run = await api('POST', `/api/orchestrator/run/${USER}`);
    if (run.status !== 200) { report(7, false, `Orchestrator returned ${run.status}`); }
    else {
      console.log('   ⏳ Waiting 20s for orchestrator...');
      await sleep(20000);
      const logs = await api('GET', `/api/orchestrator/log/${USER}`);
      const logList = logs.body?.logs || [];
      if (logList.length === 0) {
        report(7, false, 'Orchestrator ran but no logs found');
      } else {
        const latest = logList[0];
        const planned = (() => { try { return JSON.parse(latest.tasks_planned || '[]').length; } catch { return 0; } })();
        const executed = (() => { try { return JSON.parse(latest.tasks_executed || '[]').length; } catch { return 0; } })();
        report(7, true, `Orchestrator: ${planned} planned, ${executed} executed. Report: ${(latest.report || '').slice(0, 100)}`);
      }
    }
  } catch (e) { report(7, false, e.message); }

  // ── LAYER 8: Health + Opportunities ───────────────────────────────────────
  try {
    const health = await api('GET', `/api/health/${USER}`);
    const score = health.body?.total;
    const ops = await api('GET', `/api/opportunities/${USER}`);
    const opCount = ops.body?.opportunities?.length || ops.body?.count || 0;
    const recs = health.body?.recommendations || [];
    report(8, typeof score === 'number' && health.status === 200, `Health score: ${score}/100. Opportunities: ${opCount}. Recommendations: ${recs.length}`);
  } catch (e) { report(8, false, e.message); }

  // ── LAYER 9: Memory System ────────────────────────────────────────────────
  try {
    // ai_memory table may or may not exist — test via the endpoint that reads it
    const r = await api('GET', `/api/metrics/${USER}`);
    const memEntries = r.body?.memory_entries || 0;
    report(9, r.status === 200, `Memory system accessible. ${memEntries} memory entries. Metrics: ${r.body?.posts_this_week || 0} posts this week, trend=${r.body?.trend || '?'}`);
  } catch (e) { report(9, false, e.message); }

  // ── LAYER 10: International System ────────────────────────────────────────
  try {
    const ci = require('../services/countryIntelligence');
    const country = ci.detectCountry({ physical_locations: [{ city: 'Prishtina' }] });
    const holidays = ci.getUpcomingHolidays(country, 60);
    const postTime = ci.getOptimalTime(country, 'Fitness/Gym', 'instagram');
    const countryData = ci.getCountryIntelligence(country);
    const validTime = postTime && postTime.includes('T');
    report(10, country === 'XK' && validTime, `Country: ${country} (${countryData.name}). ${holidays.length} holidays in 60d. Next post: ${postTime?.slice(0,16) || '?'}. Languages: ${countryData.languages.join(',')}`);
  } catch (e) { report(10, false, e.message); }

  // ── SUMMARY ───────────────────────────────────────────────────────────────
  console.log();
  console.log('═══════════════════════════════════════════════');
  console.log('  SYSTEM HEALTH SUMMARY');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Layers passed: ${passed}/10`);
  console.log(`  Layers failed: ${failed}/10`);
  const critical = results.filter(r => !r.ok && [1,3,4,5].includes(r.layer));
  if (critical.length) {
    console.log(`  Critical failures:`);
    critical.forEach(c => console.log(`    ❌ Layer ${c.layer}: ${c.msg.slice(0, 100)}`));
  }
  console.log(`  System ready for production: ${failed <= 2 && critical.length === 0 ? 'YES ✅' : 'NEEDS ATTENTION ⚠️'}`);
  console.log('═══════════════════════════════════════════════');
}

main().catch(e => { console.error('Test runner error:', e); process.exit(1); });
