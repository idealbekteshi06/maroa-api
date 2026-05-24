'use strict';

/**
 * Shared CORS origin allowlist — used by server.js and tests.
 */

const ALLOWED_ORIGINS = [
  'https://maroa-ai-marketing-automator.lovable.app',
  'https://maroa-ai-marketing-automator.vercel.app',
  'https://maroa.ai',
  'https://www.maroa.ai',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://localhost:8080',
];

// Preview deployments live under our own project namespace, so the wildcards
// are scoped to hostnames that contain the "maroa" project token. Without this
// scoping, any attacker-controlled *.vercel.app / *.lovable.app origin would be
// reflected back with credentials:true. If a preview host doesn't match, add it
// to ALLOWED_ORIGINS explicitly rather than widening these patterns.
function isCorsOriginAllowed(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (/^https:\/\/[a-z0-9-]*maroa[a-z0-9-]*\.vercel\.app$/i.test(origin)) return true;
  if (/^https:\/\/[a-z0-9-]*maroa[a-z0-9-]*\.lovable\.app$/i.test(origin)) return true;
  return false;
}

module.exports = { ALLOWED_ORIGINS, isCorsOriginAllowed };
