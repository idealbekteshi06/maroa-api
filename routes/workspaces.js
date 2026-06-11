'use strict';

/**
 * routes/workspaces.js — HTTP surface for the workspaces multi-tenant lib.
 *
 * Exposes lib/workspaces.js (shipped in commit 7ea21aa, migration 066) via
 * authenticated /api endpoints. Every route requires a Bearer JWT (via the
 * pre-existing requireAnyUserId middleware mounted in server.js).
 *
 * Endpoints:
 *   POST   /api/workspaces                       — create workspace (caller becomes owner)
 *   GET    /api/workspaces                       — list workspaces caller is a member of
 *   GET    /api/workspaces/:id                   — workspace details (membership-gated)
 *   PATCH  /api/workspaces/:id                   — update name / branding (owner/strategist)
 *
 *   GET    /api/workspaces/:id/members           — list members
 *   POST   /api/workspaces/:id/members           — invite member (owner/strategist)
 *   PATCH  /api/workspaces/:id/members/:userId   — change role (owner)
 *   DELETE /api/workspaces/:id/members/:userId   — remove member (owner)
 *
 *   GET    /api/workspaces/:id/invites           — list pending invites
 *   POST   /api/workspaces/:id/invites/:inviteId/cancel — cancel an invite (owner/strategist)
 *
 *   GET    /api/workspaces/:id/clients           — list clients (paused/active filter via ?status)
 *   POST   /api/workspaces/:id/clients           — attach a business_id as a client
 *   POST   /api/workspaces/:id/clients/:businessId/offboard — soft-delete
 *
 * Public (no auth):
 *   POST /api/invites/:token/accept              — accept an invite via magic link
 *   POST /api/approvals/:token/approve           — client approves content via magic link
 *   POST /api/approvals/:token/reject            — client rejects content via magic link
 *   GET  /api/approvals/:token                   — public lookup of pending approval
 *
 * Defensive: every membership check fails closed. If migration 066 isn't
 * applied (workspaces table missing), the lib factory returns service
 * methods that soft-fail to null/[] → routes return 404/empty without crashing.
 */

const { assertBusinessOwner } = require('../lib/assertBusinessOwner');

function register({ app, workspaces, requireAnyUserId, apiError, safePublicError, log }) {
  if (!workspaces) {
    // Migration 066 not applied / lib not constructed — skip route mounting.
    // Boot stays clean; routes simply 404.
    return;
  }

  // server.js does not inject sbGet into this module, but assertBusinessOwner
  // needs a PostgREST reader to verify business ownership before a caller can
  // attach an arbitrary business_id to their workspace (IDOR / privilege
  // escalation fix). Build a minimal sbGet-compatible reader from env, mirroring
  // the service-role pattern in middleware/requireAuthOrWebhookSecret.js. Returns
  // [] / throws like server.js's sbGet so assertBusinessOwner behaves identically.
  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/[^\x20-\x7E]/g, '').trim();
  const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
  const sbGet =
    SUPABASE_URL && SUPABASE_KEY
      ? async function sbGet(table, query = '') {
          const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
          });
          if (r.status !== 200) throw new Error(`sbGet ${table}: ${r.status}`);
          const body = await r.json();
          return Array.isArray(body) ? body : [];
        }
      : undefined;
  const logger = { warn: (...a) => log?.(...a) };

  // ── Authenticated workspaces routes ────────────────────────────────────
  // requireAnyUserId is mounted globally for /api/* in server.js, so
  // req.user.id is guaranteed below.

  app.post('/api/workspaces', requireAnyUserId, async (req, res) => {
    try {
      const { name, plan_tier = 'solo', branding } = req.body || {};
      if (!name || typeof name !== 'string' || name.trim().length < 2) {
        return apiError(res, 400, 'INVALID_BODY', 'name is required (min 2 chars)');
      }
      const result = await workspaces.createWorkspace({
        ownerUserId: req.user.id,
        name: name.trim(),
        planTier: plan_tier,
        branding: branding && typeof branding === 'object' ? branding : null,
      });
      if (!result || !result.ok) {
        return apiError(res, 400, 'CREATE_FAILED', result?.reason || 'Workspace not created');
      }
      return res.status(201).json({ workspace: result.workspace });
    } catch (err) {
      log?.('/api/workspaces POST', null, 'error', { error: err.message });
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  app.get('/api/workspaces', requireAnyUserId, async (req, res) => {
    try {
      const list = await workspaces.getWorkspacesForUser(req.user.id);
      return res.json({ workspaces: list || [] });
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  app.get('/api/workspaces/:id', requireAnyUserId, async (req, res) => {
    try {
      const { id } = req.params;
      const membership = await workspaces.getMembership(id, req.user.id);
      if (!membership) return apiError(res, 404, 'NOT_FOUND', 'Workspace not found or no access');
      const ws = await workspaces.getWorkspace(id);
      if (!ws) return apiError(res, 404, 'NOT_FOUND', 'Workspace not found');
      return res.json({ workspace: ws, membership });
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  app.patch('/api/workspaces/:id', requireAnyUserId, async (req, res) => {
    try {
      const { id } = req.params;
      const allowed = await workspaces.userHasRole({ workspaceId: id, userId: req.user.id, atLeast: 'strategist' });
      if (!allowed) return apiError(res, 403, 'FORBIDDEN', 'Strategist role or higher required');
      const result = await workspaces.updateWorkspace(id, req.body || {});
      if (!result?.ok) return apiError(res, 400, 'UPDATE_FAILED', result?.reason || 'Update failed');
      return res.json({ workspace: result.workspace });
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  // ── Members ────────────────────────────────────────────────────────────

  app.get('/api/workspaces/:id/members', requireAnyUserId, async (req, res) => {
    try {
      const { id } = req.params;
      const membership = await workspaces.getMembership(id, req.user.id);
      if (!membership) return apiError(res, 404, 'NOT_FOUND', 'Workspace not found or no access');
      const list = await workspaces.listMembers(id);
      return res.json({ members: list || [] });
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  app.post('/api/workspaces/:id/members', requireAnyUserId, async (req, res) => {
    try {
      const { id } = req.params;
      const allowed = await workspaces.userHasRole({ workspaceId: id, userId: req.user.id, atLeast: 'strategist' });
      if (!allowed) return apiError(res, 403, 'FORBIDDEN', 'Strategist role or higher required');
      const { email, role = 'viewer' } = req.body || {};
      if (!email) return apiError(res, 400, 'INVALID_BODY', 'email required');
      const result = await workspaces.inviteMember({
        workspaceId: id,
        email,
        role,
        invitedBy: req.user.id,
      });
      if (!result?.ok) return apiError(res, 400, 'INVITE_FAILED', result?.reason || 'Invite failed');
      return res.status(201).json({ invite: result.invite });
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  app.patch('/api/workspaces/:id/members/:userId', requireAnyUserId, async (req, res) => {
    try {
      const { id, userId } = req.params;
      const allowed = await workspaces.userHasRole({ workspaceId: id, userId: req.user.id, atLeast: 'owner' });
      if (!allowed) return apiError(res, 403, 'FORBIDDEN', 'Owner role required');
      const { role } = req.body || {};
      if (!role) return apiError(res, 400, 'INVALID_BODY', 'role required');
      const result = await workspaces.updateMemberRole({ workspaceId: id, userId, role });
      if (!result?.ok) return apiError(res, 400, 'UPDATE_FAILED', result?.reason || 'Update failed');
      return res.json({ membership: result.membership });
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  app.delete('/api/workspaces/:id/members/:userId', requireAnyUserId, async (req, res) => {
    try {
      const { id, userId } = req.params;
      const allowed = await workspaces.userHasRole({ workspaceId: id, userId: req.user.id, atLeast: 'owner' });
      if (!allowed) return apiError(res, 403, 'FORBIDDEN', 'Owner role required');
      const result = await workspaces.removeMember({ workspaceId: id, userId });
      if (!result?.ok) return apiError(res, 400, 'REMOVE_FAILED', result?.reason || 'Remove failed');
      return res.json({ ok: true });
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  // ── Invites ────────────────────────────────────────────────────────────

  app.get('/api/workspaces/:id/invites', requireAnyUserId, async (req, res) => {
    try {
      const { id } = req.params;
      const allowed = await workspaces.userHasRole({ workspaceId: id, userId: req.user.id, atLeast: 'strategist' });
      if (!allowed) return apiError(res, 403, 'FORBIDDEN', 'Strategist role or higher required');
      const list = await workspaces.listPendingInvites(id);
      return res.json({ invites: list || [] });
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  app.post('/api/workspaces/:id/invites/:inviteId/cancel', requireAnyUserId, async (req, res) => {
    try {
      const { id, inviteId } = req.params;
      const allowed = await workspaces.userHasRole({ workspaceId: id, userId: req.user.id, atLeast: 'strategist' });
      if (!allowed) return apiError(res, 403, 'FORBIDDEN', 'Strategist role or higher required');
      const result = await workspaces.cancelInvite(inviteId);
      if (!result?.ok) return apiError(res, 400, 'CANCEL_FAILED', result?.reason || 'Cancel failed');
      return res.json({ ok: true });
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  // ── Clients (businesses attached to a workspace) ──────────────────────

  app.get('/api/workspaces/:id/clients', requireAnyUserId, async (req, res) => {
    try {
      const { id } = req.params;
      const membership = await workspaces.getMembership(id, req.user.id);
      if (!membership) return apiError(res, 404, 'NOT_FOUND', 'Workspace not found or no access');
      const status = req.query.status || null;
      const list = await workspaces.listClients(id, { status });
      return res.json({ clients: list || [] });
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  app.post('/api/workspaces/:id/clients', requireAnyUserId, async (req, res) => {
    try {
      const { id } = req.params;
      const allowed = await workspaces.userHasRole({ workspaceId: id, userId: req.user.id, atLeast: 'strategist' });
      if (!allowed) return apiError(res, 403, 'FORBIDDEN', 'Strategist role or higher required');
      const { business_id, client_name, monthly_retainer_usd } = req.body || {};
      if (!business_id) return apiError(res, 400, 'INVALID_BODY', 'business_id required');
      // Privilege-escalation fix: you may only attach a business you own to your
      // workspace. Without this, any strategist could attach an arbitrary
      // business_id and gain access to another tenant's data via the workspace.
      if (!(await assertBusinessOwner(req, res, business_id, { sbGet, apiError, logger }))) return;
      const result = await workspaces.addClient({
        workspaceId: id,
        businessId: business_id,
        clientName: client_name || null,
        monthlyRetainerUsd: monthly_retainer_usd || null,
      });
      if (!result?.ok) return apiError(res, 400, 'ADD_FAILED', result?.reason || 'Add client failed');
      return res.status(201).json({ client: result.client });
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  app.post('/api/workspaces/:id/clients/:businessId/offboard', requireAnyUserId, async (req, res) => {
    try {
      const { id, businessId } = req.params;
      const allowed = await workspaces.userHasRole({ workspaceId: id, userId: req.user.id, atLeast: 'strategist' });
      if (!allowed) return apiError(res, 403, 'FORBIDDEN', 'Strategist role or higher required');
      const result = await workspaces.offboardClient({ workspaceId: id, businessId });
      if (!result?.ok) return apiError(res, 400, 'OFFBOARD_FAILED', result?.reason || 'Offboard failed');
      return res.json({ ok: true });
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  // ── Public (no JWT) — magic-link invite + approval flows ──────────────
  // These are mounted OUTSIDE the /api/* path that requireAnyUserId guards
  // because the user clicking the magic link doesn't have an account yet.

  app.post('/api/invites/:token/accept', async (req, res) => {
    try {
      const { token } = req.params;
      const { user_id, email } = req.body || {};
      if (!user_id || !email) return apiError(res, 400, 'INVALID_BODY', 'user_id + email required');
      const result = await workspaces.acceptInvite({ token, userId: user_id, email });
      if (!result?.ok) return apiError(res, 400, 'ACCEPT_FAILED', result?.reason || 'Accept failed');
      return res.json({ membership: result.membership });
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  app.get('/api/approvals/:token', async (req, res) => {
    try {
      const { token } = req.params;
      const approval = await workspaces.lookupApproval(token);
      if (!approval) return apiError(res, 404, 'NOT_FOUND', 'Approval not found or expired');
      return res.json({ approval });
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  app.post('/api/approvals/:token/approve', async (req, res) => {
    try {
      const { token } = req.params;
      const { approver_email, approver_name } = req.body || {};
      const result = await workspaces.approveByToken({
        token,
        approverEmail: approver_email || null,
        approverName: approver_name || null,
      });
      if (!result?.ok) return apiError(res, 400, 'APPROVE_FAILED', result?.reason || 'Approve failed');
      return res.json({ approval: result.approval });
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  app.post('/api/approvals/:token/reject', async (req, res) => {
    try {
      const { token } = req.params;
      const { rejection_reason, approver_email } = req.body || {};
      const result = await workspaces.rejectByToken({
        token,
        reason: rejection_reason || null,
        approverEmail: approver_email || null,
      });
      if (!result?.ok) return apiError(res, 400, 'REJECT_FAILED', result?.reason || 'Reject failed');
      return res.json({ approval: result.approval });
    } catch (err) {
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });
}

module.exports = { register };
