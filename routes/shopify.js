'use strict';

/**
 * routes/shopify.js
 * ----------------------------------------------------------------------------
 * Store connection API — customer pastes their store URL (Shopify or any
 * product site) and Maroa ingests the catalog + markets it automatically.
 *
 *   POST /api/store/connect     { business_id, store_url }  → ingest catalog
 *   GET  /api/store/products    ?business_id=&limit=        → list products
 *   POST /api/store/sync        { business_id }             → re-fetch catalog
 *   POST /api/store/automation  { business_id, enabled }    → arm autopilot
 *
 * Security: /api/* is NOT behind the global /webhook owner middleware, so
 * every route re-verifies that the JWT caller OWNS the business_id
 * (businesses.user_id === req.user.id) — same pattern as routes/onboarding.js.
 * All PostgREST filter inputs are UUID-validated + encodeURIComponent'd.
 * ----------------------------------------------------------------------------
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function register({ app, shopify, requireAnyUserId, businessForUser, apiError, sbGet, log, express }) {
  if (!app || !shopify || !requireAnyUserId || !sbGet || !apiError) {
    log?.('/api/store', null, 'register skipped — missing dependencies');
    return;
  }
  void businessForUser; // ownership is checked against the explicit business_id, not "first business"

  const jsonBody = express ? express.json({ limit: '8kb' }) : (_req, _res, next) => next();

  /**
   * Verify the caller owns business_id. Returns the business row, or null
   * after having written the error response.
   */
  async function ownedBusiness(req, res, businessId) {
    const userId = req.user?.id;
    if (!userId) {
      apiError(res, 401, 'UNAUTHORIZED', 'Sign in first');
      return null;
    }
    if (!UUID_RE.test(String(businessId || ''))) {
      apiError(res, 400, 'VALIDATION_ERROR', 'invalid business_id');
      return null;
    }
    let row = null;
    try {
      const rows = await sbGet('businesses', `id=eq.${encodeURIComponent(businessId)}&select=id,user_id&limit=1`);
      row = rows?.[0] || null;
    } catch (err) {
      log?.('/api/store', businessId, 'ownership lookup failed', { error: err.message });
      apiError(res, 500, 'INTERNAL_ERROR', 'lookup failed');
      return null;
    }
    if (!row) {
      apiError(res, 404, 'NOT_FOUND', 'business not found');
      return null;
    }
    if (row.user_id !== userId) {
      apiError(res, 403, 'FORBIDDEN', 'You do not own this business');
      return null;
    }
    return row;
  }

  // ─── POST /api/store/connect ──────────────────────────────────────────────
  app.post('/api/store/connect', requireAnyUserId, jsonBody, async (req, res) => {
    try {
      const { business_id: businessId, store_url: storeUrl } = req.body || {};
      if (!(await ownedBusiness(req, res, businessId))) return;
      if (!storeUrl || typeof storeUrl !== 'string') {
        return apiError(res, 400, 'VALIDATION_ERROR', 'store_url is required');
      }
      const result = await shopify.connectStore({ businessId, storeUrl });
      if (!result.ok) {
        const status = result.reason === 'invalid_url' ? 400 : 422;
        return apiError(res, status, 'STORE_CONNECT_FAILED', result.reason || 'connect failed');
      }
      return res.json(result);
    } catch (err) {
      log?.('/api/store/connect', null, 'failed', { error: err.message });
      return apiError(res, 500, 'INTERNAL_ERROR', 'store connect failed');
    }
  });

  // ─── GET /api/store/products ──────────────────────────────────────────────
  app.get('/api/store/products', requireAnyUserId, async (req, res) => {
    try {
      const businessId = String(req.query.business_id || '');
      if (!(await ownedBusiness(req, res, businessId))) return;
      const products = await shopify.getProducts({ businessId, limit: req.query.limit });
      return res.json({ ok: true, count: products.length, products });
    } catch (err) {
      log?.('/api/store/products', null, 'failed', { error: err.message });
      return apiError(res, 500, 'INTERNAL_ERROR', 'products read failed');
    }
  });

  // ─── POST /api/store/sync ─────────────────────────────────────────────────
  app.post('/api/store/sync', requireAnyUserId, jsonBody, async (req, res) => {
    try {
      const businessId = req.body?.business_id;
      if (!(await ownedBusiness(req, res, businessId))) return;
      const result = await shopify.syncStore({ businessId });
      if (!result.ok) return apiError(res, 422, 'STORE_SYNC_FAILED', result.reason || 'sync failed');
      return res.json(result);
    } catch (err) {
      log?.('/api/store/sync', null, 'failed', { error: err.message });
      return apiError(res, 500, 'INTERNAL_ERROR', 'store sync failed');
    }
  });

  // ─── POST /api/store/automation ───────────────────────────────────────────
  // Arms content autopilot only — ads_live consent is a separate flow (095).
  app.post('/api/store/automation', requireAnyUserId, jsonBody, async (req, res) => {
    try {
      const { business_id: businessId, enabled } = req.body || {};
      if (!(await ownedBusiness(req, res, businessId))) return;
      if (typeof enabled !== 'boolean' && enabled !== 'true' && enabled !== 'false') {
        return apiError(res, 400, 'VALIDATION_ERROR', 'enabled must be a boolean');
      }
      const result = await shopify.setAutomation({ businessId, enabled });
      return res.json(result);
    } catch (err) {
      log?.('/api/store/automation', null, 'failed', { error: err.message });
      return apiError(res, 500, 'INTERNAL_ERROR', 'automation toggle failed');
    }
  });

  log?.('/api/store', null, 'store routes registered');
}

module.exports = { register };
