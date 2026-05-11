'use strict';

/**
 * lib/tracing.js
 * ----------------------------------------------------------------------------
 * Distributed-tracing helper. Three small pieces:
 *
 *   1. requestIdMiddleware — assigns each incoming request a stable
 *      `x-request-id` (uses upstream header if present, otherwise mints one),
 *      attaches it to req.requestId, and sets the response header so the
 *      caller can trace the request end-to-end.
 *
 *   2. withTracing(routeName, handler) — wraps a route handler so every log
 *      line + Sentry breadcrumb + error capture is automatically tagged with
 *      requestId + routeName. Eliminates boilerplate.
 *
 *   3. childCorrelation(req) — returns headers to forward to internal
 *      service-to-service calls so the requestId propagates across all hops
 *      (Inngest → /webhook/... → external API → DB).
 *
 * Why this matters: a customer reports "yesterday at 3:42 PM my ad audit
 * crashed." Without correlation IDs, we sift Railway logs by timestamp +
 * guesswork. With them, we grep `x-request-id: <id>` and instantly see
 * every log, breadcrumb, and exception that touched that one request.
 *
 * Cost: ~zero. One UUID per request, one header pass-through, one Sentry tag.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');

// Try to load Sentry — graceful no-op if not installed (e.g., local dev)
const Sentry = (() => {
  try { return require('@sentry/node'); } catch { return null; }
})();

const REQUEST_ID_HEADER = 'x-request-id';

function newRequestId() {
  // ULID-style: timestamp + random. Sortable by time, collision-safe.
  return `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Express middleware. Mount EARLY in the stack — before all routes — so
 * every downstream handler has req.requestId available.
 */
function requestIdMiddleware(req, res, next) {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const requestId = (typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128)
    ? incoming
    : newRequestId();
  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  // Attach to Sentry scope so breadcrumbs + exceptions are tagged
  if (Sentry?.configureScope) {
    Sentry.configureScope((scope) => {
      scope.setTag('request_id', requestId);
      scope.setContext('request', {
        method: req.method,
        path: req.path,
        // Don't include body — may contain PII
      });
    });
  }
  next();
}

/**
 * Wraps a route handler so logs/breadcrumbs/errors get auto-tagged.
 * Usage:
 *   app.post('/webhook/foo', withTracing('/webhook/foo', async (req, res) => { ... }))
 */
function withTracing(routeName, handler) {
  return async function tracedHandler(req, res) {
    const startedAt = Date.now();
    if (Sentry?.addBreadcrumb) {
      Sentry.addBreadcrumb({
        category: 'route',
        message: `${req.method} ${routeName}`,
        level: 'info',
        data: { request_id: req.requestId },
      });
    }
    try {
      await handler(req, res);
      const ms = Date.now() - startedAt;
      if (ms > 5000 && console?.warn) {
        // Slow route — warn so we notice in logs
        console.warn(JSON.stringify({
          level: 'warn',
          msg: 'slow_route',
          route: routeName,
          request_id: req.requestId,
          duration_ms: ms,
        }));
      }
    } catch (err) {
      if (Sentry?.captureException) {
        Sentry.captureException(err, {
          tags: { route: routeName, request_id: req.requestId },
        });
      }
      console.error(JSON.stringify({
        level: 'error',
        msg: 'route_threw',
        route: routeName,
        request_id: req.requestId,
        error: err.message,
        stack: err.stack?.split('\n').slice(0, 5).join(' | '),
      }));
      if (!res.headersSent) {
        res.status(500).json({
          error: { code: 'INTERNAL_ERROR', message: 'Internal error', request_id: req.requestId },
        });
      }
    }
  };
}

/**
 * Returns the request-correlation headers a callee should pass through
 * when making internal service-to-service HTTP calls.
 */
function childCorrelation(req) {
  return req?.requestId ? { [REQUEST_ID_HEADER]: req.requestId } : {};
}

module.exports = {
  requestIdMiddleware,
  withTracing,
  childCorrelation,
  newRequestId,
  REQUEST_ID_HEADER,
};
