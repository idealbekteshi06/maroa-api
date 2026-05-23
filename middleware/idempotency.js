'use strict';

/**
 * middleware/idempotency.js
 * ----------------------------------------------------------------------------
 * Idempotency-Key middleware for mutating customer-facing routes.
 *
 * Why: webhooks are deduped via (provider, event_id). Customer-facing
 * mutations (POST /api/content/publish, POST /api/social/multi-post, POST
 * /api/ad-campaigns/pause, ...) had no guard. A browser retry on a network
 * blip → content posts twice to IG/TikTok, ad spend doubles, email
 * recipients enrolled twice.
 *
 * Contract (matches Stripe + GitHub + most major APIs):
 *   - Client sends `Idempotency-Key: <opaque-string ≤ 200 chars>`.
 *   - First request: handler runs. Response (status + JSON body) is cached
 *     for 24h keyed by (route, idempotencyKey, userId).
 *   - Retry: same key → returns the cached response. Handler does NOT run.
 *   - Different body with the same key → 409 IDEMPOTENCY_KEY_CONFLICT
 *     (client mistake — same key must = same request).
 *
 * Storage:
 *   - Primary: Supabase `idempotency_keys` table (migration 069). Survives
 *     restart; works across multi-instance deploys.
 *   - Fallback: in-process Map (5k entries, 24h TTL). Used when Supabase
 *     is unreachable so a DB outage doesn't break the API.
 *
 * Scope:
 *   - Required on POST/PUT/PATCH for routes mounted under `require()`.
 *   - GET/DELETE are NOT idempotency-keyed (GET is idempotent by definition;
 *     DELETE is idempotent by spec).
 *   - Webhook routes are explicitly exempt — they have their own dedup.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_KEY_LENGTH = 200;
const MAX_INMEM_ENTRIES = 5_000;

// In-process LRU fallback. Keyed by `${route}:${userId}:${idempotencyKey}`.
const _inMemCache = new Map();

function _cacheSet(key, value) {
  if (_inMemCache.has(key)) _inMemCache.delete(key);
  _inMemCache.set(key, value);
  while (_inMemCache.size > MAX_INMEM_ENTRIES) {
    const oldest = _inMemCache.keys().next().value;
    if (oldest === undefined) break;
    _inMemCache.delete(oldest);
  }
}

function _cacheGet(key) {
  const hit = _inMemCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    _inMemCache.delete(key);
    return null;
  }
  return hit;
}

function _hashRequestBody(body) {
  try {
    const canonical = JSON.stringify(body, Object.keys(body || {}).sort());
    return crypto.createHash('sha256').update(canonical).digest('hex');
  } catch {
    return '';
  }
}

function _looksLikeKey(value) {
  return (
    typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= MAX_KEY_LENGTH &&
    /^[A-Za-z0-9_\-.:]+$/.test(value)
  );
}

/**
 * Factory.
 *
 * @param {object} deps
 * @param {Function} deps.sbGet  Supabase GET helper. Optional — falls back to in-mem.
 * @param {Function} deps.sbPost Supabase POST helper. Optional.
 * @param {Function} deps.sbPatch Supabase PATCH helper. Optional.
 * @param {object}   [deps.logger]
 * @returns {{required: Function, optional: Function}}
 *   - required: 4xx if header missing.
 *   - optional: skips dedup if header missing (for routes during rollout).
 */
function makeIdempotency({ sbGet, sbPost, sbPatch, logger } = {}) {
  async function _readPersisted(key) {
    if (!sbGet) return null;
    try {
      const rows = await sbGet(
        'idempotency_keys',
        `key=eq.${encodeURIComponent(key)}&select=status,response_status,response_body,request_hash,expires_at&limit=1`
      );
      const row = rows && rows[0];
      if (!row) return null;
      if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
      return row;
    } catch (e) {
      logger?.warn?.('idempotency', null, 'persisted read failed', { error: e.message });
      return null;
    }
  }

  async function _writePersisted(key, payload) {
    if (!sbPost) return;
    try {
      await sbPost('idempotency_keys', {
        key,
        status: payload.status, // 'pending' | 'complete' | 'failed'
        response_status: payload.response_status || null,
        response_body: payload.response_body || null,
        request_hash: payload.request_hash || null,
        route: payload.route,
        user_id: payload.user_id || null,
        expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(),
      });
    } catch (e) {
      // Conflict on PK (key) is fine — another worker won the race; we'll
      // re-read the persisted row in the next request.
      if (!/duplicate/i.test(e.message || '')) {
        logger?.warn?.('idempotency', null, 'persisted write failed', { error: e.message });
      }
    }
  }

  async function _updatePersisted(key, patch) {
    if (!sbPatch) return;
    try {
      await sbPatch('idempotency_keys', `key=eq.${encodeURIComponent(key)}`, patch);
    } catch (e) {
      logger?.warn?.('idempotency', null, 'persisted update failed', { error: e.message });
    }
  }

  function _cacheKey(route, userId, idempotencyKey) {
    return `${route}::${userId || 'anon'}::${idempotencyKey}`;
  }

  function _handler({ enforceRequired }) {
    return async function idempotencyMiddleware(req, res, next) {
      const method = (req.method || '').toUpperCase();
      if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return next();

      const headerKey =
        req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || req.headers?.['x-idempotency-key'];

      if (!headerKey) {
        if (enforceRequired) {
          return res.status(400).json({
            error: {
              code: 'IDEMPOTENCY_KEY_REQUIRED',
              message: 'Idempotency-Key header is required for this route.',
            },
          });
        }
        return next();
      }
      if (!_looksLikeKey(headerKey)) {
        return res.status(400).json({
          error: {
            code: 'IDEMPOTENCY_KEY_INVALID',
            message: 'Idempotency-Key must be 8-200 chars of [A-Za-z0-9_-.:].',
          },
        });
      }

      const route = req.route?.path || req.baseUrl + req.path || req.path || 'unknown';
      const userId = req.user?.id || req.body?.userId || req.body?.user_id || null;
      const cacheK = _cacheKey(route, userId, headerKey);
      const requestHash = _hashRequestBody(req.body);

      // 1. Check persisted store first (works across instances).
      const persisted = await _readPersisted(headerKey);
      if (persisted) {
        if (persisted.request_hash && persisted.request_hash !== requestHash) {
          return res.status(409).json({
            error: {
              code: 'IDEMPOTENCY_KEY_CONFLICT',
              message: 'Idempotency-Key was used with a different request body. Use a new key for a new request.',
            },
          });
        }
        if (persisted.status === 'complete' && persisted.response_status) {
          // Return the cached response — short-circuit handler.
          return res.status(persisted.response_status).json(persisted.response_body || {});
        }
        if (persisted.status === 'pending') {
          // Another worker is currently processing the SAME key. Tell client to retry.
          return res.status(409).json({
            error: {
              code: 'IDEMPOTENCY_KEY_IN_FLIGHT',
              message: 'Request with this key is still processing. Retry in a moment.',
            },
          });
        }
      }

      // 2. Check in-process LRU (fast path).
      const memHit = _cacheGet(cacheK);
      if (memHit) {
        if (memHit.requestHash && memHit.requestHash !== requestHash) {
          return res.status(409).json({
            error: {
              code: 'IDEMPOTENCY_KEY_CONFLICT',
              message: 'Idempotency-Key reused with a different body.',
            },
          });
        }
        if (memHit.status === 'complete') {
          return res.status(memHit.responseStatus).json(memHit.responseBody);
        }
      }

      // 3. First-time request — mark pending, run handler, cache result.
      _cacheSet(cacheK, {
        status: 'pending',
        requestHash,
        expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
      });
      _writePersisted(headerKey, {
        status: 'pending',
        request_hash: requestHash,
        route,
        user_id: userId,
      }).catch(() => {});

      // Hook response.json to capture the result.
      const origStatus = res.status.bind(res);
      const origJson = res.json.bind(res);
      let capturedStatus = 200;
      res.status = function (code) {
        capturedStatus = code;
        return origStatus(code);
      };
      res.json = function (body) {
        try {
          _cacheSet(cacheK, {
            status: 'complete',
            requestHash,
            responseStatus: capturedStatus,
            responseBody: body,
            expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
          });
          _updatePersisted(headerKey, {
            status: capturedStatus >= 500 ? 'failed' : 'complete',
            response_status: capturedStatus,
            response_body: body,
          }).catch(() => {});
        } catch {
          /* never block the response */
        }
        return origJson(body);
      };
      next();
    };
  }

  return {
    required: _handler({ enforceRequired: true }),
    optional: _handler({ enforceRequired: false }),
    _cacheKey,
    _hashRequestBody,
  };
}

module.exports = { makeIdempotency, IDEMPOTENCY_TTL_MS, MAX_KEY_LENGTH };
