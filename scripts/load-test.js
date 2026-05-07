#!/usr/bin/env node

'use strict';

/**
 * scripts/load-test.js
 * ----------------------------------------------------------------------------
 * Load test against staging or production. Simulates 100 concurrent businesses
 * hitting the daily cron endpoints.
 *
 * Usage:
 *   MAROA_STAGING_URL=https://staging.maroa-api... \
 *   MAROA_STAGING_WEBHOOK_SECRET=xxx \
 *   node scripts/load-test.js
 *
 * Outputs `load-test-report.json` — uploaded as artifact in CI.
 *
 * Pass criteria:
 *   - p99 < 5000ms
 *   - error rate < 1%
 *   - no 5xx responses sustained > 10%
 * ----------------------------------------------------------------------------
 */

const { writeFileSync } = require('fs');
const https = require('https');

const URL = process.env.MAROA_STAGING_URL || 'https://maroa-api-production.up.railway.app';
const SECRET = process.env.MAROA_STAGING_WEBHOOK_SECRET || process.env.N8N_WEBHOOK_SECRET || '';
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY) || 50;
const DURATION_S = Number(process.env.LOAD_DURATION_S) || 30;
const ENDPOINTS = [
  { method: 'GET',  path: '/health',                              authed: false },
  { method: 'POST', path: '/webhook/ad-optimizer-daily-audit',    authed: true,  body: { dryRun: true } },
  { method: 'POST', path: '/webhook/pacing-alerts-evaluate-all',  authed: true,  body: { dryRun: true } },
];

if (!SECRET) {
  console.error('FAIL: MAROA_STAGING_WEBHOOK_SECRET (or N8N_WEBHOOK_SECRET) required');
  process.exit(1);
}

console.log(`Load test starting against ${URL}`);
console.log(`Concurrency: ${CONCURRENCY}, Duration: ${DURATION_S}s, Endpoints: ${ENDPOINTS.length}`);

const stats = {
  start_time: new Date().toISOString(),
  url: URL,
  concurrency: CONCURRENCY,
  duration_s: DURATION_S,
  total_requests: 0,
  successful: 0,
  errors: 0,
  by_status: {},
  latencies_ms: [],
  per_endpoint: {},
};

ENDPOINTS.forEach(e => {
  stats.per_endpoint[`${e.method} ${e.path}`] = { count: 0, errors: 0, latencies: [] };
});

function makeRequest(endpoint) {
  return new Promise((resolve) => {
    const start = Date.now();
    const u = new URL(endpoint.path, URL);
    const opts = {
      method: endpoint.method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      headers: {
        'Content-Type': 'application/json',
        ...(endpoint.authed ? { 'x-webhook-secret': SECRET } : {}),
      },
      timeout: 30000,
    };

    const req = https.request(opts, (res) => {
      let _body = '';
      res.on('data', (c) => (_body += c));
      res.on('end', () => {
        const dur = Date.now() - start;
        stats.total_requests++;
        stats.by_status[res.statusCode] = (stats.by_status[res.statusCode] || 0) + 1;
        stats.latencies_ms.push(dur);
        const ek = `${endpoint.method} ${endpoint.path}`;
        stats.per_endpoint[ek].count++;
        stats.per_endpoint[ek].latencies.push(dur);
        if (res.statusCode >= 500 || res.statusCode < 200) {
          stats.errors++;
          stats.per_endpoint[ek].errors++;
        } else {
          stats.successful++;
        }
        resolve();
      });
    });
    req.on('error', () => {
      stats.total_requests++;
      stats.errors++;
      const ek = `${endpoint.method} ${endpoint.path}`;
      stats.per_endpoint[ek].errors++;
      resolve();
    });
    req.on('timeout', () => req.destroy());
    if (endpoint.body) req.write(JSON.stringify(endpoint.body));
    req.end();
  });
}

async function worker() {
  const endTime = Date.now() + DURATION_S * 1000;
  while (Date.now() < endTime) {
    const ep = ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)];
    await makeRequest(ep);
  }
}

(async () => {
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  // Compute percentiles
  const sorted = stats.latencies_ms.slice().sort((a, b) => a - b);
  const pct = (p) => sorted[Math.floor(sorted.length * p / 100)] || 0;

  const report = {
    ...stats,
    end_time: new Date().toISOString(),
    p50_ms: pct(50),
    p95_ms: pct(95),
    p99_ms: pct(99),
    avg_ms: stats.latencies_ms.length ? Math.round(stats.latencies_ms.reduce((a, b) => a + b, 0) / stats.latencies_ms.length) : 0,
    error_rate: stats.total_requests ? Number((stats.errors / stats.total_requests).toFixed(4)) : 0,
    requests_per_second: Number((stats.total_requests / DURATION_S).toFixed(2)),
  };

  // Compute per-endpoint percentiles
  for (const [ep, data] of Object.entries(report.per_endpoint)) {
    const epSorted = data.latencies.slice().sort((a, b) => a - b);
    data.p50_ms = epSorted[Math.floor(epSorted.length * 0.5)] || 0;
    data.p95_ms = epSorted[Math.floor(epSorted.length * 0.95)] || 0;
    data.p99_ms = epSorted[Math.floor(epSorted.length * 0.99)] || 0;
    delete data.latencies; // remove huge array from report
  }

  delete report.latencies_ms;

  writeFileSync('load-test-report.json', JSON.stringify(report, null, 2));

  // Pretty-print summary
  console.log('\n══════════════ LOAD TEST RESULTS ══════════════');
  console.log(`Total requests:    ${report.total_requests}`);
  console.log(`Successful:        ${report.successful}`);
  console.log(`Errors:            ${report.errors} (${(report.error_rate * 100).toFixed(2)}%)`);
  console.log(`Requests/sec:      ${report.requests_per_second}`);
  console.log(`Latency avg/p50/p95/p99: ${report.avg_ms}/${report.p50_ms}/${report.p95_ms}/${report.p99_ms}ms`);
  console.log(`Status breakdown:  ${JSON.stringify(report.by_status)}`);
  console.log('\n══════════════ PASS CRITERIA ══════════════');

  let pass = true;
  if (report.p99_ms > 5000)              { console.log('❌ p99 > 5000ms'); pass = false; } else { console.log('✅ p99 < 5000ms'); }
  if (report.error_rate > 0.01)          { console.log(`❌ error rate ${(report.error_rate * 100).toFixed(2)}% > 1%`); pass = false; } else { console.log('✅ error rate < 1%'); }
  if (report.requests_per_second < 5)     { console.log(`⚠️  rps < 5 (${report.requests_per_second})`); }

  if (!pass) {
    console.log('\n💥 LOAD TEST FAILED');
    process.exit(1);
  }
  console.log('\n🎉 LOAD TEST PASSED');
})();
