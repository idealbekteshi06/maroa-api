'use strict';

/**
 * middleware/authenticateUserId.js
 * ---------------------------------------------------------------------------
 * Shared auth + ownership middleware for /api/* routes that accept a userId
 * in body/params/query. Replaces the two ad-hoc gates (requireAnyUserId +
 * requireValidUserId) that previously sat in server.js and allowed any
 * well-formed UUID through — the IDOR risk surfaced in the 2026-05-13 audit.
 *
 * Two phases:
 *
 *   1. Bearer token present
 *      - Verify with Supabase admin auth (injected as supabaseAdminGetUser)
 *      - If the request ALSO carries a userId/user_id and it disagrees with
 *        the token's user.id, return 403 FORBIDDEN_OWNERSHIP and increment
 *        auth_idor_blocked_total{route}. This is the IDOR fix.
 *      - Otherwise inject the authenticated user into req.user + back-fill
 *        req.body.userId / req.body.user_id / req.params.userId so existing
 *        handlers work unchanged.
 *
 *   2. No Bearer token (legacy fallback)
 *      - Gated by env.LEGACY_USERID_FALLBACK_ALLOWED. Default OFF in
 *        production. Set to "1" only during a documented migration window
 *        for legacy n8n callers that haven't moved to JWT yet.
 *      - When the flag is OFF: 401 AUTH_REQUIRED.
 *      - When the flag is ON: validates UUID format only AND increments
 *        auth_legacy_fallback_total{route} so we can prove this path is
 *        idle before flipping the flag off permanently.
 *
 * Dep injection makes this testable without a live Supabase client.
 * ---------------------------------------------------------------------------
 */

function makeAuthenticateUserId({
  supabaseAdminGetUser,
  metrics,
  env = process.env,
  apiError,
} = {}) {
  if (typeof apiError !== 'function') {
    // Default apiError shape — mirrors server.js apiError for standalone use.
    apiError = (res, status, code, message) =>
      res.status(status).json({ error: code, message });
  }

  return function authenticateUserId(req, res, next) {
    const authHeader =
      (req.get && req.get('authorization')) || (req.headers && req.headers.authorization) || '';
    const match = String(authHeader).match(/^Bearer\s+(.+)$/i);

    if (match) {
      if (typeof supabaseAdminGetUser !== 'function') {
        return apiError(res, 503, 'AUTH_UNAVAILABLE', 'Auth service not configured');
      }
      return Promise.resolve()
        .then(() => supabaseAdminGetUser(match[1].trim()))
        .then(({ data, error } = {}) => {
          if (error || !data || !data.user) {
            return apiError(res, 401, 'UNAUTHORIZED', 'Invalid auth token');
          }
          const authenticatedId = data.user.id;
          const providedUid =
            (req.body && (req.body.userId || req.body.user_id)) ||
            (req.params && req.params.userId) ||
            (req.query && req.query.userId);
          if (providedUid && providedUid !== authenticatedId) {
            if (metrics && typeof metrics.increment === 'function') {
              try {
                metrics.increment('auth_idor_blocked_total', { route: req.path || 'unknown' });
              } catch {
                /* metrics is best-effort */
              }
            }
            return apiError(
              res,
              403,
              'FORBIDDEN_OWNERSHIP',
              'You do not own this resource (auth user ≠ requested userId)'
            );
          }
          // Inject for downstream handlers.
          req.user = data.user;
          if (!req.params) req.params = {};
          req.params.userId = authenticatedId;
          if (!req.body) req.body = {};
          if (!req.body.userId) req.body.userId = authenticatedId;
          if (!req.body.user_id) req.body.user_id = authenticatedId;
          return next();
        })
        .catch(() => apiError(res, 401, 'UNAUTHORIZED', 'Auth verification failed'));
    }

    // ── Legacy fallback ────────────────────────────────────────────────
    const legacyAllowed = String(env.LEGACY_USERID_FALLBACK_ALLOWED || '').match(
      /^(1|true|yes|on)$/i
    );
    if (!legacyAllowed) {
      return apiError(
        res,
        401,
        'AUTH_REQUIRED',
        'Authentication required (Bearer token). Legacy userId-only access is disabled.'
      );
    }

    const uid =
      (req.body && (req.body.userId || req.body.user_id)) ||
      (req.params && req.params.userId) ||
      (req.query && req.query.userId);
    if (!uid || typeof uid !== 'string' || uid.length < 10) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'Valid user ID required');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uid)) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'user ID must be a valid UUID');
    }
    if (metrics && typeof metrics.increment === 'function') {
      try {
        metrics.increment('auth_legacy_fallback_total', { route: req.path || 'unknown' });
      } catch {
        /* metrics is best-effort */
      }
    }
    return next();
  };
}

module.exports = { makeAuthenticateUserId };
