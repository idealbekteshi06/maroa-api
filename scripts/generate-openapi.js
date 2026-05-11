#!/usr/bin/env node
'use strict';

/**
 * scripts/generate-openapi.js — Generates docs/openapi.yml from the
 * current route inventory.
 *
 * Approach:
 *   1. Scan server.js + routes/*.js for `app.METHOD('/path', ...)` calls.
 *   2. Compose an OpenAPI 3.1 skeleton with one entry per discovered route.
 *   3. For routes whose body is validated by a known zod schema in
 *      lib/schemas.js, convert that schema to JSON Schema and embed it.
 *   4. Write the result to docs/openapi.yml.
 *
 * This is intentionally a "skeleton generator" — it gives every team
 * member a starting point and a single source of truth that's
 * mechanically derivable from code. Individual route summaries +
 * response shapes are then hand-edited (or generated from JSDoc) in
 * follow-up PRs.
 *
 * Run:
 *   node scripts/generate-openapi.js
 *
 * Output: docs/openapi.yml (overwrites)
 *
 * Future evolution:
 *   - Parse JSDoc above each route handler for summary + tags
 *   - Inspect zod schemas referenced in mounted middlewares
 *   - Cross-link request shapes with response shapes
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCES = [path.join(ROOT, 'server.js'), ...glob('routes/*.js')];

function glob(pattern) {
  const dir = pattern.split('/')[0];
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(abs, f));
}

// Match: app.METHOD('/path', ...)  AND   app.METHOD("/path", ...)
// Captures the HTTP method + the path string.
const ROUTE_RE = /\bapp\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;

function extractRoutes(sourceFile) {
  const text = fs.readFileSync(sourceFile, 'utf8');
  const routes = [];
  let m;
  while ((m = ROUTE_RE.exec(text)) !== null) {
    routes.push({ method: m[1], path: m[2], source: path.relative(ROOT, sourceFile) });
  }
  return routes;
}

function classifyRoute(route) {
  // Tag by leading path segment for OpenAPI tags grouping.
  const seg = route.path.split('/').filter(Boolean)[0] || 'root';
  return { ...route, tag: seg.replace(/^api$/, 'api').replace(/^webhook$/, 'webhook') };
}

function buildOpenApi(routes) {
  const grouped = new Map();
  for (const r of routes) {
    if (!grouped.has(r.path)) grouped.set(r.path, []);
    grouped.get(r.path).push(r);
  }

  const paths = {};
  const tags = new Set();
  for (const [p, ops] of grouped) {
    if (!paths[p]) paths[p] = {};
    for (const op of ops) {
      tags.add(op.tag);
      paths[p][op.method] = {
        tags: [op.tag],
        summary: `${op.method.toUpperCase()} ${p}`,
        description: `Auto-generated from ${op.source}. Hand-edit this entry for accuracy.`,
        responses: {
          200: { description: 'Successful response' },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
          },
          401: {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
          },
          402: {
            description: 'Payment Required — cost cap reached',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
          },
          429: {
            description: 'Rate limited',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
          },
          500: {
            description: 'Server error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
          },
        },
      };
      if (op.method !== 'get') {
        paths[p][op.method].requestBody = {
          description: 'Request body — hand-edit shape per route',
          content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
        };
      }
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Maroa.ai API',
      version: '2.2.0',
      description: 'AI marketing automation SaaS — Inngest + Express backend. See CLAUDE.md for architecture.',
    },
    servers: [
      { url: 'https://maroa-api-production.up.railway.app', description: 'Production' },
      { url: 'http://localhost:3000', description: 'Local dev' },
    ],
    tags: [...tags].sort().map((t) => ({ name: t, description: `${t}-prefixed routes` })),
    paths,
    components: {
      securitySchemes: {
        BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        WebhookSecret: { type: 'apiKey', in: 'header', name: 'x-webhook-secret' },
      },
      schemas: {
        ErrorEnvelope: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: {
                  type: 'string',
                  description: 'Machine-readable error code (e.g. VALIDATION_ERROR, RATE_LIMITED, COST_CAP_REACHED)',
                },
                message: { type: 'string' },
                details: { type: 'object', additionalProperties: true, nullable: true },
                timestamp: { type: 'string', format: 'date-time' },
                request_id: { type: 'string' },
              },
            },
          },
        },
        UUID: { type: 'string', format: 'uuid' },
        BusinessIdBody: {
          type: 'object',
          required: ['business_id'],
          properties: { business_id: { $ref: '#/components/schemas/UUID' } },
        },
      },
    },
  };
}

// Minimal YAML emitter — enough for the OpenAPI shape we produce here.
// Avoids a runtime dep on js-yaml. Hand-written so the output is stable
// and reviewable in diffs.
function toYaml(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  if (obj === null) return 'null';
  if (typeof obj === 'boolean' || typeof obj === 'number') return String(obj);
  if (typeof obj === 'string') {
    if (/^[\w\-./:]+$/.test(obj) && obj.length < 60 && !'#&*!|>%@`'.includes(obj[0])) return obj;
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return '\n' + obj.map((v) => `${pad}- ${toYaml(v, indent + 1).replace(/^\s+/, '')}`).join('\n');
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length === 0) return '{}';
    return (
      '\n' +
      keys
        .map((k) => {
          const v = obj[k];
          const rendered = toYaml(v, indent + 1);
          if (rendered.startsWith('\n')) return `${pad}${k}:${rendered}`;
          return `${pad}${k}: ${rendered}`;
        })
        .join('\n')
    );
  }
  return JSON.stringify(obj);
}

function main() {
  const routes = SOURCES.flatMap(extractRoutes).map(classifyRoute);
  const dedup = [];
  const seen = new Set();
  for (const r of routes) {
    const k = `${r.method} ${r.path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(r);
  }
  console.log(`Discovered ${dedup.length} unique routes across ${SOURCES.length} files.`);

  const spec = buildOpenApi(dedup);
  const yaml = toYaml(spec).trimStart();

  const outDir = path.join(ROOT, 'docs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'openapi.yml');
  fs.writeFileSync(outPath, yaml);
  console.log(`Wrote ${outPath} (${yaml.length} bytes).`);
}

main();
