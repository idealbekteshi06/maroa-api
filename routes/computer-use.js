'use strict';

/**
 * routes/computer-use.js
 * ---------------------------------------------------------------------------
 * HTTP surface for services/computer-use. Two endpoints:
 *
 *   GET  /api/computer-use/flows
 *        — list the registered flows + their action caps + allowed origins.
 *
 *   POST /api/computer-use/run
 *        — kick off a flow for a business. Defaults to dry-run; live runs
 *        require `dryRun:false` AND `operatorOptIn:true` AND the env flag
 *        `COMPUTER_USE_ENABLED=1` (the flow service enforces this triple).
 *
 * Auth: Bearer JWT (requireAnyUserId). Caller's user.id must own the
 * business OR be a workspace member with strategist+ role. We don't trust
 * the businessId in the body without verifying.
 *
 * Idempotency-Key header is honored by the standard middleware mounted in
 * server.js — repeated POSTs with the same key return the same plan.
 * ---------------------------------------------------------------------------
 */

function register({ app, computerUse, workspaces, requireAnyUserId, sbGet, apiError, safePublicError, log, express }) {
  if (!computerUse) {
    // Service not constructed — skip mounting so the rest of the API stays up.
    return;
  }

  async function _businessOwnedByUser(businessId, userId) {
    if (!businessId || !userId) return false;
    try {
      const rows = await sbGet(
        'businesses',
        `id=eq.${encodeURIComponent(businessId)}&user_id=eq.${encodeURIComponent(userId)}&select=id&limit=1`
      );
      if (rows && rows.length > 0) return true;
    } catch {
      // fall through to workspace membership check
    }
    // Agency case: the business lives inside a workspace the caller is a
    // member of. workspaces.userOwnsBusiness uses the same gate logic
    // routes/war-room.js trusts.
    try {
      if (workspaces && typeof workspaces.userOwnsBusiness === 'function') {
        return !!(await workspaces.userOwnsBusiness(businessId, userId));
      }
    } catch {
      /* deny */
    }
    return false;
  }

  app.get('/api/computer-use/flows', requireAnyUserId, (req, res) => {
    try {
      return res.json({ flows: computerUse.listFlows(), enabled: !!computerUse.isEnabled() });
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  app.post(
    '/api/computer-use/run',
    requireAnyUserId,
    express ? express.json({ limit: '8kb' }) : (req, _res, next) => next(),
    async (req, res) => {
      try {
        const { businessId, flow, args, dryRun, operatorOptIn } = req.body || {};
        if (!businessId) return apiError(res, 400, 'VALIDATION_ERROR', 'businessId required');
        if (!flow) return apiError(res, 400, 'VALIDATION_ERROR', 'flow required');

        const owned = await _businessOwnedByUser(businessId, req.user.id);
        if (!owned) return apiError(res, 403, 'FORBIDDEN', 'You do not own this business');

        // Default safety: caller MUST opt out of dry-run explicitly. Any
        // missing flag → dry-run wins.
        const effectiveDryRun = dryRun === false ? false : true;
        const effectiveOptIn = operatorOptIn === true;

        const outcome = await computerUse.runFlow({
          businessId,
          flow,
          args: args || {},
          dryRun: effectiveDryRun,
          operatorOptIn: effectiveOptIn,
        });
        return res.json(outcome);
      } catch (err) {
        log?.('/api/computer-use/run', null, 'run error', { error: err.message });
        return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
      }
    }
  );
}

module.exports = { register };
