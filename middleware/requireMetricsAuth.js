'use strict';

const crypto = require('crypto');

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Protect /metrics — set METRICS_SCRAPE_TOKEN or ORCHESTRATOR_SECRET in Railway.
 * Pass x-metrics-token header or Authorization: Bearer <token>.
 */
function requireMetricsAuth(req, res, next) {
  const expected = (process.env.METRICS_SCRAPE_TOKEN || process.env.ORCHESTRATOR_SECRET || '').trim();
  if (!expected) {
    return res.status(503).json({
      error: { code: 'NOT_CONFIGURED', message: 'METRICS_SCRAPE_TOKEN not set' },
    });
  }
  const provided = (
    req.get('x-metrics-token') ||
    (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
  );
  if (!provided || !timingSafeEqual(provided, expected)) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or missing metrics token' },
    });
  }
  return next();
}

module.exports = { requireMetricsAuth };
