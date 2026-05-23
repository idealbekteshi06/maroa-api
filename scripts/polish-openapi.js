#!/usr/bin/env node
'use strict';

/**
 * Post-process docs/openapi.yml:
 * - Replace auto-generated placeholder descriptions
 * - Remove Pinecone references (Postgres / pgvector memory)
 */

const fs = require('fs');
const path = require('path');

const OPENAPI_PATH = path.join(__dirname, '..', 'docs', 'openapi.yml');

const PLACEHOLDER_RE = /Auto-generated from [\w./-]+\. Hand-edit this entry for accuracy\./g;

function describeRoute(method, routePath) {
  const m = method.toLowerCase();
  const p = routePath;

  if (p === '/healthz') return 'Liveness probe — returns 200 when the Node process is up.';
  if (p === '/readyz') return 'Readiness probe — checks Supabase and soft dependencies before routing traffic.';
  if (p === '/health')
    return 'Minimal public health status; pass x-orchestrator-secret for operator integration summary.';
  if (p === '/') return 'API root metadata (service name, version, doc links).';
  if (p === '/metrics') {
    return 'Prometheus metrics scrape endpoint. Requires METRICS_SCRAPE_TOKEN (x-metrics-token or Bearer).';
  }
  if (p === '/api/billing/plans') return 'Public plan catalog (starter $25, growth $59, agency $99).';
  if (p.startsWith('/webhook/paddle')) return 'Paddle billing webhook — HMAC-signed, idempotent via webhook_events.';
  if (p.startsWith('/webhook/stripe')) return 'Legacy Stripe webhook — raw body HMAC verification.';
  if (p.startsWith('/webhook/oauth/')) return 'OAuth start/callback for ad platform connections.';
  if (p.startsWith('/webhook/')) {
    return `Maroa automation webhook (${m.toUpperCase()} ${p}). Typically requires x-webhook-secret and business ownership when business_id is present.`;
  }
  if (p.startsWith('/api/')) {
    return `Authenticated dashboard API (${m.toUpperCase()} ${p}). Requires Supabase JWT unless documented as public.`;
  }
  return `Maroa API endpoint (${m.toUpperCase()} ${p}).`;
}

function polishDescriptions(yaml) {
  let out = yaml.replace(PLACEHOLDER_RE, '').replace(/description: ""/g, 'description: "See summary."');

  out = out.replace(/Pinecone/gi, (match) => {
    if (match === 'Pinecone') return 'Postgres (pgvector)';
    return 'postgres (pgvector)';
  });

  // Re-fill descriptions on operation blocks that still say "See summary." only
  const lines = out.split('\n');
  const result = [];
  let currentPath = null;
  let currentMethod = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pathMatch = /^ {2}(\/[^:]+):$/.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1];
      currentMethod = null;
      result.push(line);
      continue;
    }
    const methodMatch = /^ {4}(get|post|put|patch|delete):$/.exec(line);
    if (methodMatch && currentPath) {
      currentMethod = methodMatch[1];
      result.push(line);
      continue;
    }
    if (line.includes('description: "See summary."') && currentPath && currentMethod) {
      const desc = describeRoute(currentMethod, currentPath).replace(/"/g, '\\"');
      result.push(`      description: "${desc}"`);
      continue;
    }
    if (line.includes('description:') && line.includes('postgres (pgvector)')) {
      result.push(line.replace(/postgres \(pgvector\)/gi, 'Postgres pgvector performance memory'));
      continue;
    }
    result.push(line);
  }

  return result.join('\n');
}

function main() {
  const raw = fs.readFileSync(OPENAPI_PATH, 'utf8');
  if (!raw.includes('version: 2.3.0')) {
    console.warn('[polish-openapi] expected info.version 2.3.0');
  }
  const polished = polishDescriptions(raw);
  const remainingPlaceholder = (
    polished.match(/Auto-generated from [\w./-]+\. Hand-edit this entry for accuracy\./g) || []
  ).length;
  const remainingPinecone = (polished.match(/Pinecone/gi) || []).length;
  fs.writeFileSync(OPENAPI_PATH, polished);
  console.log(`[polish-openapi] wrote ${OPENAPI_PATH}`);
  console.log(`[polish-openapi] remaining placeholders=${remainingPlaceholder} pinecone=${remainingPinecone}`);
  if (remainingPlaceholder || remainingPinecone) process.exit(1);
}

main();
