'use strict';

const { buildKpiHistory } = require('../lib/warRoomKpiHistory');

/**
 * routes/war-room.js — HTTP surface for the War Room Feed lib.
 *
 * Exposes lib/warRoomFeed.js (shipped in commit 105c80a) via authenticated
 * /api endpoints. Powers the Phase 3 Autopilot Control Room UI.
 *
 * Endpoints:
 *   GET  /api/war-room/:workspaceId
 *        — full workspace feed: clients + decisions + creatives +
 *          experiments + claims + competitor alerts + pending approvals.
 *
 *   GET  /api/war-room/:workspaceId/dashboard
 *        — small counter shape for the top-of-dashboard summary.
 *
 *   GET  /api/war-room/:workspaceId/clients/:businessId
 *        — drill-in for one client.
 *
 *   GET  /api/war-room/:workspaceId/decisions
 *        — recent decision_logs rows for the workspace
 *          (query: ?agent=ad-optimizer&limit=50&since=2026-05-13).
 *
 * Every route is membership-gated via workspaces.getMembership(). If the
 * caller is not a member of the workspace, 404. RLS in Supabase enforces
 * the same boundary at the database level — this is defense in depth.
 */

function register({
  app,
  warRoomFeed,
  workspaces,
  decisionLog,
  requireAnyUserId,
  sbGet,
  apiError,
  safePublicError,
  log,
  express,
  businessMemory, // optional — lib/businessMemory.makeBusinessMemory(...)
}) {
  if (!warRoomFeed || !workspaces) {
    // Migration 066 not applied or libs not constructed — skip route mounting.
    return;
  }

  // Memory tool (Anthropic Managed Agents Memory) — fire-and-forget on
  // approve/reject so the per-business session accumulates a high-signal
  // history of "user said yes/no to this kind of recommendation, here's
  // why." Module is null when ANTHROPIC_MEMORY_ENABLED isn't set, in
  // which case these calls become no-ops.
  function _rememberApproval(businessId, decision) {
    if (!businessMemory || !businessMemory.rememberApproval) return;
    Promise.resolve(businessMemory.rememberApproval(businessId, decision)).catch(() => {});
  }
  function _rememberRejection(businessId, decision, reason) {
    if (!businessMemory || !businessMemory.rememberRejection) return;
    Promise.resolve(businessMemory.rememberRejection(businessId, decision, reason)).catch(() => {});
  }

  // Membership gate — used by every route. Returns membership or null.
  async function checkMembership(workspaceId, userId) {
    try {
      return await workspaces.getMembership(workspaceId, userId);
    } catch {
      return null;
    }
  }

  // Confirm a decision belongs to a business that lives in this workspace.
  // Defense in depth: even with membership, an operator cannot act on a
  // decision from a business they don't actually own.
  async function decisionBelongsToWorkspace(decisionId, workspaceId) {
    if (!decisionId || !workspaceId || !decisionLog) return null;
    const decision = await decisionLog.getById(decisionId);
    if (!decision || !decision.business_id) return null;
    const client = await workspaces.getClient(workspaceId, decision.business_id).catch(() => null);
    if (!client) return null;
    return decision;
  }

  app.get('/api/war-room/:workspaceId', requireAnyUserId, async (req, res) => {
    try {
      const { workspaceId } = req.params;
      const m = await checkMembership(workspaceId, req.user.id);
      if (!m) return apiError(res, 404, 'NOT_FOUND', 'Workspace not found or no access');

      const feed = await warRoomFeed.getWorkspaceFeed(workspaceId);
      if (!feed) return apiError(res, 404, 'NOT_FOUND', 'Workspace feed unavailable');

      // Augment with 7-day sparkline history. Pure read; never throws into
      // the response — degrades to flat arrays on any per-table failure.
      try {
        const businessIds = (feed.clients || []).map((c) => c.business_id).filter(Boolean);
        feed.kpi_history = await buildKpiHistory({
          sbGet,
          businessIds,
          currentSummary: feed.summary || {},
        });
      } catch (e) {
        log?.('/api/war-room', null, 'kpi_history error', { error: e.message });
      }

      return res.json(feed);
    } catch (err) {
      log?.('/api/war-room', null, 'feed error', { error: err.message });
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  app.get('/api/war-room/:workspaceId/dashboard', requireAnyUserId, async (req, res) => {
    try {
      const { workspaceId } = req.params;
      const m = await checkMembership(workspaceId, req.user.id);
      if (!m) return apiError(res, 404, 'NOT_FOUND', 'Workspace not found or no access');

      const summary = await warRoomFeed.summarizeForDashboard(workspaceId);
      if (!summary) return apiError(res, 404, 'NOT_FOUND', 'Dashboard summary unavailable');
      return res.json({ summary });
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  app.get('/api/war-room/:workspaceId/clients/:businessId', requireAnyUserId, async (req, res) => {
    try {
      const { workspaceId, businessId } = req.params;
      const m = await checkMembership(workspaceId, req.user.id);
      if (!m) return apiError(res, 404, 'NOT_FOUND', 'Workspace not found or no access');

      const client = await warRoomFeed.getClientFeed({ workspaceId, businessId });
      if (!client) return apiError(res, 404, 'NOT_FOUND', 'Client not found in this workspace');
      return res.json(client);
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  // POST /api/war-room/:workspaceId/decisions/:decisionId/approve
  // Body: ignored. Idempotent — already-approved decisions return 200 with the row.
  app.post(
    '/api/war-room/:workspaceId/decisions/:decisionId/approve',
    requireAnyUserId,
    async (req, res) => {
      try {
        const { workspaceId, decisionId } = req.params;
        if (!decisionLog) return apiError(res, 503, 'SERVICE_UNAVAILABLE', 'Decision log not available');

        const m = await checkMembership(workspaceId, req.user.id);
        if (!m) return apiError(res, 404, 'NOT_FOUND', 'Workspace not found or no access');

        const decision = await decisionBelongsToWorkspace(decisionId, workspaceId);
        if (!decision) return apiError(res, 404, 'NOT_FOUND', 'Decision not found in this workspace');
        if (decision.refused) {
          return apiError(res, 409, 'ALREADY_REJECTED', 'Decision was already rejected');
        }
        if (decision.approved_at) {
          return res.json({ decision });
        }

        const updated = await decisionLog.approve(decisionId, req.user.id);
        if (!updated) return apiError(res, 500, 'INTERNAL_ERROR', 'Failed to approve decision');
        // Fire-and-forget memory write — never block the response on it.
        _rememberApproval(updated.business_id || decision.business_id, updated);
        return res.json({ decision: updated });
      } catch (err) {
        log?.('/api/war-room/approve', null, 'approve error', { error: err.message });
        return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
      }
    },
  );

  // POST /api/war-room/:workspaceId/decisions/:decisionId/reject
  // Body: { reason?: string } — optional, capped at 500 chars by the lib.
  app.post(
    '/api/war-room/:workspaceId/decisions/:decisionId/reject',
    requireAnyUserId,
    express ? express.json({ limit: '4kb' }) : (req, _res, next) => next(),
    async (req, res) => {
      try {
        const { workspaceId, decisionId } = req.params;
        if (!decisionLog) return apiError(res, 503, 'SERVICE_UNAVAILABLE', 'Decision log not available');

        const m = await checkMembership(workspaceId, req.user.id);
        if (!m) return apiError(res, 404, 'NOT_FOUND', 'Workspace not found or no access');

        const decision = await decisionBelongsToWorkspace(decisionId, workspaceId);
        if (!decision) return apiError(res, 404, 'NOT_FOUND', 'Decision not found in this workspace');
        if (decision.approved_at) {
          return apiError(res, 409, 'ALREADY_APPROVED', 'Decision was already approved');
        }
        if (decision.refused) {
          return res.json({ decision });
        }

        const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
        const updated = await decisionLog.reject(decisionId, req.user.id, reason);
        if (!updated) return apiError(res, 500, 'INTERNAL_ERROR', 'Failed to reject decision');
        // Rejections carry the highest training signal — capture them
        // into per-business memory so future drafts avoid the same shape.
        _rememberRejection(updated.business_id || decision.business_id, updated, reason);
        return res.json({ decision: updated });
      } catch (err) {
        log?.('/api/war-room/reject', null, 'reject error', { error: err.message });
        return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
      }
    },
  );

  app.get('/api/war-room/:workspaceId/decisions', requireAnyUserId, async (req, res) => {
    try {
      const { workspaceId } = req.params;
      const m = await checkMembership(workspaceId, req.user.id);
      if (!m) return apiError(res, 404, 'NOT_FOUND', 'Workspace not found or no access');

      const limit = Math.min(parseInt(req.query.limit, 10) || 25, 200);
      const agent = req.query.agent || null;
      const since = req.query.since || null;

      // Build PostgREST filter
      const clients = await workspaces.listClients(workspaceId, {});
      const businessIds = (clients || []).map((c) => c.business_id).filter(Boolean);
      if (businessIds.length === 0) return res.json({ decisions: [] });

      const bizClause = `business_id=in.(${businessIds.map(encodeURIComponent).join(',')})`;
      const agentClause = agent ? `&agent_name=eq.${encodeURIComponent(agent)}` : '';
      const sinceClause = since ? `&created_at=gte.${encodeURIComponent(since)}` : '';
      const filter = `${bizClause}${agentClause}${sinceClause}&order=created_at.desc&limit=${limit}`;
      const decisions = await sbGet('decision_logs', filter).catch(() => []);
      return res.json({ decisions: decisions || [], filter: { agent, since, limit } });
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });
}

module.exports = { register };
