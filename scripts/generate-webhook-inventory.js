#!/usr/bin/env node
'use strict';

/**
 * Scans server.js, routes/, and service registerRoutes modules for Express routes.
 * Writes docs/WEBHOOK_INVENTORY.md
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'WEBHOOK_INVENTORY.md');

const RETIRED = new Set([
  'POST /webhook/master-agent',
  'POST /webhook/master-agent-all',
]);

const INNGEST_ONLY = new Set([
  'POST /webhook/ad-optimizer-daily-audit',
  'POST /webhook/pacing-alerts-evaluate-all',
  'POST /webhook/weekly-scorecard-all',
  'POST /webhook/wf1-run-daily',
  'POST /webhook/wf1-measure-performance',
  'POST /webhook/wf1-overnight-batch-submit',
  'POST /webhook/wf1-overnight-batch-apply-all',
  'POST /webhook/anthropic-batch-reconcile-all',
  'POST /webhook/creative-engine-generate-all',
  'POST /webhook/creative-engine-evaluate-all',
  'POST /webhook/measurement-health-probe-all',
  'POST /webhook/citation-tracker-run-all',
  'POST /webhook/competitor-watch-scan-all',
  'POST /webhook/email-lifecycle-process-due',
  'POST /webhook/wf11-sla-check-all',
  'POST /webhook/wf2-calibration-run-all',
  'POST /webhook/autopilot-brain-run-all',
  'POST /webhook/wf13-run-weekly',
  'POST /webhook/ops-daily-health-all',
  'POST /webhook/ops-weekly-maintenance-all',
  'POST /webhook/ops-growth-engine-all',
  'POST /webhook/ops-analytics-snapshots-all',
  'POST /webhook/ops-monthly-reports-all',
  'POST /webhook/taxonomy-refresh-run',
  'POST /webhook/cold-start-resume',
  'POST /webhook/wf-content-performance-feedback',
]);

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      walk(p, acc);
    } else if (ent.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

function extractRoutes(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const re = /app\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;
  const routes = [];
  let m;
  while ((m = re.exec(text))) {
    routes.push({ method: m[1].toUpperCase(), path: m[2], file: path.relative(ROOT, filePath) });
  }
  return routes;
}

const files = [
  path.join(ROOT, 'server.js'),
  ...walk(path.join(ROOT, 'routes')),
  ...walk(path.join(ROOT, 'services')).filter((f) => f.includes('registerRoutes')),
];

const all = [];
for (const f of files) all.push(...extractRoutes(f));

const byPath = new Map();
for (const r of all) {
  const key = `${r.method} ${r.path}`;
  if (!byPath.has(key)) byPath.set(key, r);
}

const sorted = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));

function classify(r) {
  const key = `${r.method} ${r.path}`;
  if (RETIRED.has(key)) return 'retired';
  if (INNGEST_ONLY.has(key)) return 'inngest';
  if (r.path.startsWith('/api/')) return 'api';
  if (r.path.startsWith('/webhook/wf')) return 'workflow';
  return 'legacy';
}

const lines = [
  '# Webhook & API inventory (generated)',
  '',
  `Generated: ${new Date().toISOString()}`,
  '',
  'Run `node scripts/generate-webhook-inventory.js` after adding routes.',
  '',
  '| Method | Path | Class | Source |',
  '|--------|------|-------|--------|',
];

for (const r of sorted) {
  lines.push(`| ${r.method} | \`${r.path}\` | ${classify(r)} | ${r.file} |`);
}

lines.push('', `**Total routes:** ${sorted.length}`);

fs.writeFileSync(OUT, lines.join('\n'));
console.log(`Wrote ${OUT} (${sorted.length} routes)`);
