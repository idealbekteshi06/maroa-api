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

// Preview deployments are matched by the FULL project-name prefix, not a
// free-floating "maroa" substring. The old patterns (/.*maroa.*\.vercel\.app/)
// matched any attacker-registered host containing "maroa" (e.g.
// maroa-attacker.vercel.app, evilmaroa.lovable.app) and reflected it back with
// credentials:true. Anchoring to the exact project slug closes that. If a
// preview host doesn't match, add it to ALLOWED_ORIGINS explicitly.
const PREVIEW_PATTERNS = [
  /^https:\/\/maroa-ai-marketing-automator(-[a-z0-9-]+)?\.vercel\.app$/i,
  /^https:\/\/maroa-ai-marketing-automator(-[a-z0-9-]+)?\.lovable\.app$/i,
];
function isCorsOriginAllowed(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return PREVIEW_PATTERNS.some((re) => re.test(origin));
}

module.exports = { ALLOWED_ORIGINS, isCorsOriginAllowed };
