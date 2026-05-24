'use strict';

/**
 * lib/assertBusinessOwner.js — tenant isolation for business_id / :businessId.
 *
 * Service-role Supabase bypasses RLS; callers must verify JWT users own the
 * business row before reading or mutating tenant data.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function extractBusinessId(req) {
  return (
    req.params?.businessId ||
    req.params?.business_id ||
    req.body?.business_id ||
    req.body?.businessId ||
    req.query?.business_id ||
    req.query?.businessId
  );
}

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

// Agency / Freelancer mode: a business the JWT user does not directly own
// (businesses.user_id) is still accessible if it is attached as an active
// client (client_relationships) to a workspace the user is a member of
// (workspace_members). Mirrors the access model in lib/workspaces.js.
async function userHasWorkspaceAccess(sbGet, userId, businessId) {
  if (typeof sbGet !== 'function' || !isUuid(userId) || !isUuid(businessId)) return false;
  try {
    const rels = await sbGet(
      'client_relationships',
      `business_id=eq.${encodeURIComponent(businessId)}&status=neq.offboarded&select=workspace_id`
    );
    const wsIds = [...new Set((rels || []).map((r) => r.workspace_id).filter(Boolean))];
    if (!wsIds.length) return false;
    const inList = wsIds.map((id) => encodeURIComponent(id)).join(',');
    const members = await sbGet(
      'workspace_members',
      `workspace_id=in.(${inList})&user_id=eq.${encodeURIComponent(userId)}&select=workspace_id&limit=1`
    );
    return Array.isArray(members) && members.length > 0;
  } catch {
    return false;
  }
}

/**
 * Verify businesses.user_id === req.user.id. Resolves when OK; sends 4xx and
 * returns false when denied. Webhook-secret callers skip (req.authSource).
 */
async function assertBusinessOwner(req, res, businessId, { sbGet, apiError, logger } = {}) {
  if (req.authSource === 'webhook') return true;
  const jwtUserId = req.user?.id;
  if (!jwtUserId) {
    apiError(res, 401, 'UNAUTHORIZED', 'JWT required to access this business');
    return false;
  }
  if (!businessId || !isUuid(businessId)) {
    apiError(res, 400, 'VALIDATION_ERROR', 'business_id must be a valid UUID');
    return false;
  }
  if (typeof sbGet !== 'function') {
    apiError(res, 503, 'SERVICE_UNAVAILABLE', 'Database not configured');
    return false;
  }
  try {
    const rows = await sbGet('businesses', `id=eq.${encodeURIComponent(businessId)}&select=id,user_id&limit=1`);
    const row = rows?.[0];
    if (!row) {
      apiError(res, 403, 'BUSINESS_NOT_FOUND', 'business_id not found');
      return false;
    }
    // Direct owner (solo accounts).
    if (row.user_id && String(row.user_id) === String(jwtUserId)) {
      req.verifiedBusinessId = businessId;
      return true;
    }
    // Agency / Freelancer mode: workspace membership over this client business.
    if (await userHasWorkspaceAccess(sbGet, jwtUserId, businessId)) {
      req.verifiedBusinessId = businessId;
      req.businessAccessVia = 'workspace';
      return true;
    }
    logger?.warn?.('/assertBusinessOwner', businessId, 'IDOR blocked', {
      jwt_user: jwtUserId,
      owner: row.user_id || null,
      path: req.path,
    });
    apiError(res, 403, 'FORBIDDEN', 'You do not have access to this business');
    return false;
  } catch (e) {
    apiError(res, 500, 'OWNERSHIP_CHECK_FAILED', e.message);
    return false;
  }
}

function assertBusinessOwnerMiddleware({ sbGet, apiError, logger } = {}) {
  return async function businessOwnerGate(req, res, next) {
    const businessId = extractBusinessId(req);
    if (!businessId) return next();
    const ok = await assertBusinessOwner(req, res, businessId, { sbGet, apiError, logger });
    if (ok) return next();
  };
}

module.exports = {
  assertBusinessOwner,
  assertBusinessOwnerMiddleware,
  extractBusinessId,
  isUuid,
};
