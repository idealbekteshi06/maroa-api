'use strict';

/**
 * lib/securityHeaders.js
 * ---------------------------------------------------------------------------
 * Production-grade security headers as a single Express middleware.
 *
 * Why we don't use Helmet:
 *   - One extra dependency for ~150 lines of header writes
 *   - Helmet's defaults are surprisingly permissive (CSP off by default)
 *   - We want explicit, auditable, version-controlled header values
 *
 * Coverage:
 *   - HSTS                       — forces HTTPS for 1 year
 *   - X-Frame-Options            — clickjacking defense (DENY = no iframes)
 *   - X-Content-Type-Options     — disables MIME sniffing
 *   - Referrer-Policy            — strips referrer on cross-origin
 *   - Content-Security-Policy    — defense-in-depth XSS (API-friendly)
 *   - Permissions-Policy         — disables APIs we don't use
 *   - Cross-Origin-Opener-Policy — Spectre / process-isolation
 *   - X-Permitted-Cross-Domain-Policies — locks down legacy plugins
 *
 * Notes:
 *   - HSTS is gated to production (NODE_ENV=production). In dev we don't
 *     force HTTPS because localhost is HTTP and we'd lock ourselves out.
 *   - CSP for an API server defaults to `default-src 'self'; frame-ancestors 'none'`.
 *     The HTML status page (routes/status-page.js) opts out via res.locals.cspMode='page'.
 *   - All headers are set BEFORE the route handler runs, but they can be
 *     overridden per-route by calling res.setHeader() inside the handler.
 *
 * Public API:
 *   securityHeaders({ env, cspMode }) → Express middleware
 *
 * Where wired: server.js — applied globally just after the request-id
 * middleware so every response (including 404 / error) gets headers.
 * ---------------------------------------------------------------------------
 */

const DEFAULT_HEADERS_PROD = Object.freeze({
  // HTTPS lock-in. 1 year, includes subdomains, preload-ready.
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  // No iframe embedding anywhere (we don't have any legit iframe use case).
  'X-Frame-Options': 'DENY',
  // Browsers must respect Content-Type — no MIME sniffing tricks.
  'X-Content-Type-Options': 'nosniff',
  // Strip referrer when navigating cross-origin so we don't leak request IDs.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Disable powerful APIs we never use server-side. Belt and suspenders;
  // these only matter when the response is HTML, but cheap to ship always.
  'Permissions-Policy': [
    'accelerometer=()',
    'camera=()',
    'geolocation=()',
    'gyroscope=()',
    'magnetometer=()',
    'microphone=()',
    'payment=()',
    'usb=()',
  ].join(', '),
  // Spectre / cross-origin process isolation.
  'Cross-Origin-Opener-Policy': 'same-origin',
  // Lock out legacy Flash / Silverlight cross-domain policies.
  'X-Permitted-Cross-Domain-Policies': 'none',
});

const DEFAULT_HEADERS_DEV = Object.freeze({
  // In dev, skip HSTS so localhost (HTTP) still works.
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Permitted-Cross-Domain-Policies': 'none',
});

/**
 * Two CSP profiles. Picked by `res.locals.cspMode` (default: 'api').
 *
 *   'api'  — for JSON-returning endpoints. Strictest possible.
 *   'page' — for HTML responses (/status, future docs pages). Allows
 *            inline scripts + styles (the status page uses them) but
 *            blocks everything cross-origin.
 *   'off'  — opts out entirely. Use ONLY when a third party (e.g. Paddle
 *            webhook UI sandbox) requires a missing CSP.
 */
const CSP_PROFILES = Object.freeze({
  api: [
    "default-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; '),
  page: [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'", // status page polls /readyz inline
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; '),
  off: null,
});

function securityHeaders({ env, defaultCspMode = 'api' } = {}) {
  const isProd = (env || process.env.NODE_ENV) === 'production';
  const baseHeaders = isProd ? DEFAULT_HEADERS_PROD : DEFAULT_HEADERS_DEV;

  return function securityHeadersMiddleware(req, res, next) {
    // Set base headers.
    for (const [k, v] of Object.entries(baseHeaders)) {
      // Don't clobber what a route already set (route wins).
      if (!res.getHeader(k)) res.setHeader(k, v);
    }

    // CSP is dynamic — picked at response-finalization time so individual
    // routes can opt into 'page' or 'off' via res.locals.cspMode.
    const originalEnd = res.end;
    res.end = function patchedEnd(...args) {
      const mode = res.locals?.cspMode || defaultCspMode;
      const policy = CSP_PROFILES[mode];
      if (policy && !res.getHeader('Content-Security-Policy')) {
        res.setHeader('Content-Security-Policy', policy);
      }
      return originalEnd.apply(this, args);
    };

    next();
  };
}

module.exports = {
  securityHeaders,
  DEFAULT_HEADERS_PROD,
  DEFAULT_HEADERS_DEV,
  CSP_PROFILES,
};
