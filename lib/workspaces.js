'use strict';

/**
 * lib/workspaces.js
 * ───────────────────────────────────────────────────────────────────────
 * Workspace + member + invite + client-relationship + approval CRUD.
 *
 * Unlocks Freelancer Mode + Agency Mode (migration 066 / ADR-0011).
 *
 * Public API:
 *
 *   const ws = makeWorkspacesService({ sbGet, sbPost, sbPatch, sbDelete?,
 *                                       logger, metrics, generateToken? });
 *
 *   // ── Workspaces ────────────────────────────────────────────────────
 *   ws.createWorkspace({ ownerUserId, name, planTier?, slug?, whiteLabel? })
 *   ws.getWorkspace(id)
 *   ws.getWorkspacesForUser(userId)               // workspaces user owns OR is member of
 *   ws.updateWorkspace(id, { name?, whiteLabel?, settings?, planTier?, ... })
 *
 *   // ── Members ───────────────────────────────────────────────────────
 *   ws.listMembers(workspaceId)
 *   ws.getMembership(workspaceId, userId)         // → { role, joined_at, … } or null
 *   ws.addMember({ workspaceId, userId, role, invitedBy?, visibleClientIds? })
 *   ws.updateMemberRole({ workspaceId, userId, role, visibleClientIds? })
 *   ws.removeMember({ workspaceId, userId })
 *   ws.userHasRole({ workspaceId, userId, atLeast })  // role hierarchy check
 *
 *   // ── Invites ───────────────────────────────────────────────────────
 *   ws.inviteMember({ workspaceId, email, role, invitedBy?, expiresInDays? })
 *     → { id, token, expires_at }
 *   ws.acceptInvite({ token, userId })            // converts to workspace_member
 *   ws.cancelInvite({ token })
 *   ws.listPendingInvites(workspaceId)
 *
 *   // ── Client relationships ──────────────────────────────────────────
 *   ws.addClient({ workspaceId, businessId, clientName?, monthlyRetainerUsd? })
 *   ws.listClients(workspaceId, { status? })
 *   ws.getClient(workspaceId, businessId)
 *   ws.offboardClient({ workspaceId, businessId, reason? })
 *
 *   // ── Client approvals (magic-link workflow) ────────────────────────
 *   ws.requestApproval({ workspaceId, businessId, decisionLogId?, clientEmail,
 *                         previewUrl?, previewData?, expiresInHours? })
 *     → { id, token, expiresAt }
 *   ws.lookupApproval(token)                      // public — no auth, just the token
 *   ws.approveByToken({ token, approvedByEmail })
 *   ws.rejectByToken({ token, reason, rejectedByEmail })
 *   ws.expireStaleApprovals()                     // cron sweep
 *
 *   // ── Role hierarchy ────────────────────────────────────────────────
 *   ws.ROLE_HIERARCHY                              // { owner:5, strategist:4, designer:3, viewer:2, client:1 }
 *
 * Design constraints:
 *   - Every method returns soft results on DB error (null / [] / soft-result).
 *     Workspace operations are user-initiated; failure should surface as an
 *     error in the UI, NOT crash the request.
 *   - Tokens are 32-byte URL-safe random by default; caller can inject a
 *     deterministic generator for tests.
 *   - Role checks use a hierarchy so route guards can say "at least
 *     strategist" without enumerating every higher role.
 */

const crypto = require('crypto');

const ROLE_HIERARCHY = Object.freeze({
  client: 1,
  viewer: 2,
  designer: 3,
  strategist: 4,
  owner: 5,
});

const VALID_ROLES = Object.freeze(Object.keys(ROLE_HIERARCHY));
const VALID_PLAN_TIERS = Object.freeze(['solo', 'freelancer', 'agency', 'enterprise']);
const VALID_CLIENT_STATUSES = Object.freeze(['active', 'paused', 'offboarded']);

function defaultGenerateToken() {
  // 32 bytes → 43 chars base64url (URL-safe, no padding)
  return crypto.randomBytes(32).toString('base64url');
}

function makeWorkspacesService(deps = {}) {
  const { sbGet, sbPost, sbPatch, logger, metrics, generateToken = defaultGenerateToken } = deps;

  if (typeof sbGet !== 'function' || typeof sbPost !== 'function' || typeof sbPatch !== 'function') {
    throw new Error('workspaces: sbGet + sbPost + sbPatch required deps');
  }

  function _bump(name, labels) {
    if (metrics?.increment) {
      try {
        metrics.increment(name, labels);
      } catch {
        /* best effort */
      }
    }
  }

  function _enc(v) {
    return encodeURIComponent(v);
  }

  function _logWarn(op, err) {
    if (logger?.warn) logger.warn('workspaces', null, op, { err: err.message || String(err) });
  }

  async function _softGet(table, filter) {
    try {
      return await sbGet(table, filter);
    } catch (e) {
      _bump('workspaces_read_errors_total', { table });
      _logWarn(`read ${table}`, e);
      return [];
    }
  }

  async function _softPost(table, row) {
    try {
      const r = await sbPost(table, row, { returning: 'representation' });
      return Array.isArray(r) ? r[0] : r;
    } catch (e) {
      _bump('workspaces_write_errors_total', { table });
      _logWarn(`write ${table}`, e);
      return null;
    }
  }

  async function _softPatch(table, filter, updates) {
    try {
      const r = await sbPatch(table, filter, updates, { returning: 'representation' });
      return Array.isArray(r) ? r[0] : r;
    } catch (e) {
      _bump('workspaces_write_errors_total', { table });
      _logWarn(`patch ${table}`, e);
      return null;
    }
  }

  // ── Workspaces ────────────────────────────────────────────────────────

  async function createWorkspace({
    ownerUserId,
    name,
    planTier = 'freelancer',
    slug,
    whiteLabel,
    settings,
    monthlySpendCapUsd,
  }) {
    if (!ownerUserId || !name) throw new Error('createWorkspace: ownerUserId + name required');
    if (!VALID_PLAN_TIERS.includes(planTier)) {
      throw new Error(`createWorkspace: planTier must be one of ${VALID_PLAN_TIERS.join(',')}`);
    }

    const workspace = await _softPost('workspaces', {
      owner_user_id: ownerUserId,
      name,
      slug: slug || null,
      plan_tier: planTier,
      white_label: whiteLabel || {},
      settings: settings || {},
      monthly_spend_cap_usd: typeof monthlySpendCapUsd === 'number' ? monthlySpendCapUsd : null,
      team_seat_count: 1,
    });
    if (!workspace) return null;

    // Auto-add the owner as a workspace_member with role=owner.
    await _softPost('workspace_members', {
      workspace_id: workspace.id,
      user_id: ownerUserId,
      role: 'owner',
    });

    _bump('workspaces_created_total', { plan_tier: planTier });
    return workspace;
  }

  async function getWorkspace(id) {
    if (!id) return null;
    const rows = await _softGet('workspaces', `id=eq.${_enc(id)}&limit=1`);
    return rows[0] || null;
  }

  async function getWorkspacesForUser(userId) {
    if (!userId) return [];
    const memberships = await _softGet('workspace_members', `user_id=eq.${_enc(userId)}&select=workspace_id`);
    const ids = memberships.map((m) => m.workspace_id).filter(Boolean);
    if (!ids.length) return [];
    const inList = ids.map(_enc).join(',');
    return _softGet('workspaces', `id=in.(${inList})&order=created_at.desc`);
  }

  async function updateWorkspace(id, updates) {
    if (!id || !updates) return null;
    const allowed = ['name', 'slug', 'white_label', 'settings', 'plan_tier', 'monthly_spend_cap_usd', 'status'];
    const patch = {};
    for (const k of allowed) {
      if (updates[k] !== undefined) patch[k] = updates[k];
    }
    if (Object.keys(patch).length === 0) return null;
    return _softPatch('workspaces', `id=eq.${_enc(id)}`, patch);
  }

  // ── Members ──────────────────────────────────────────────────────────

  async function listMembers(workspaceId) {
    if (!workspaceId) return [];
    return _softGet('workspace_members', `workspace_id=eq.${_enc(workspaceId)}&order=joined_at.asc`);
  }

  async function getMembership(workspaceId, userId) {
    if (!workspaceId || !userId) return null;
    const rows = await _softGet(
      'workspace_members',
      `workspace_id=eq.${_enc(workspaceId)}&user_id=eq.${_enc(userId)}&limit=1`
    );
    return rows[0] || null;
  }

  async function addMember({ workspaceId, userId, role, invitedBy, visibleClientIds }) {
    if (!workspaceId || !userId || !role) throw new Error('addMember: workspaceId + userId + role required');
    if (!VALID_ROLES.includes(role)) throw new Error(`addMember: role must be one of ${VALID_ROLES.join(',')}`);

    const existing = await getMembership(workspaceId, userId);
    if (existing) return existing;

    return _softPost('workspace_members', {
      workspace_id: workspaceId,
      user_id: userId,
      role,
      invited_by: invitedBy || null,
      visible_client_ids: Array.isArray(visibleClientIds) ? visibleClientIds : [],
    });
  }

  async function updateMemberRole({ workspaceId, userId, role, visibleClientIds }) {
    if (!workspaceId || !userId || !role) throw new Error('updateMemberRole: workspaceId + userId + role required');
    if (!VALID_ROLES.includes(role)) throw new Error(`updateMemberRole: role must be one of ${VALID_ROLES.join(',')}`);
    const patch = { role };
    if (Array.isArray(visibleClientIds)) patch.visible_client_ids = visibleClientIds;
    return _softPatch('workspace_members', `workspace_id=eq.${_enc(workspaceId)}&user_id=eq.${_enc(userId)}`, patch);
  }

  async function removeMember({ workspaceId, userId }) {
    if (!workspaceId || !userId) return null;
    // We can't DELETE through PostgREST without a delete dep; soft-archive by patching role.
    // Real delete should happen via service-role through a direct SQL or sb-delete dep.
    return _softPatch('workspace_members', `workspace_id=eq.${_enc(workspaceId)}&user_id=eq.${_enc(userId)}`, {
      role: 'viewer',
      visible_client_ids: [],
    });
  }

  function _roleRank(role) {
    return ROLE_HIERARCHY[role] || 0;
  }

  async function userHasRole({ workspaceId, userId, atLeast = 'viewer' }) {
    const membership = await getMembership(workspaceId, userId);
    if (!membership) return false;
    return _roleRank(membership.role) >= _roleRank(atLeast);
  }

  // ── Invites ──────────────────────────────────────────────────────────

  async function inviteMember({ workspaceId, email, role, invitedBy, expiresInDays = 14 }) {
    if (!workspaceId || !email || !role) throw new Error('inviteMember: workspaceId + email + role required');
    if (!VALID_ROLES.includes(role)) throw new Error(`inviteMember: role must be one of ${VALID_ROLES.join(',')}`);

    const token = generateToken();
    const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString();
    const invite = await _softPost('workspace_invites', {
      workspace_id: workspaceId,
      email: String(email).trim().toLowerCase(),
      role,
      token,
      invited_by: invitedBy || null,
      expires_at: expiresAt,
    });
    if (invite) _bump('workspace_invites_sent_total', { role });
    return invite;
  }

  async function acceptInvite({ token, userId }) {
    if (!token || !userId) return { ok: false, reason: 'token + userId required' };

    const rows = await _softGet(
      'workspace_invites',
      `token=eq.${_enc(token)}&accepted_at=is.null&cancelled_at=is.null&limit=1`
    );
    const invite = rows[0];
    if (!invite) return { ok: false, reason: 'invite_not_found_or_already_used' };
    if (new Date(invite.expires_at) < new Date()) {
      return { ok: false, reason: 'invite_expired' };
    }

    // Add the user as a workspace member
    const member = await addMember({
      workspaceId: invite.workspace_id,
      userId,
      role: invite.role,
      invitedBy: invite.invited_by,
    });

    // Mark invite as accepted
    await _softPatch('workspace_invites', `id=eq.${_enc(invite.id)}`, {
      accepted_at: new Date().toISOString(),
    });

    _bump('workspace_invites_accepted_total', { role: invite.role });
    return { ok: true, member, workspace_id: invite.workspace_id };
  }

  async function cancelInvite({ token }) {
    if (!token) return null;
    return _softPatch('workspace_invites', `token=eq.${_enc(token)}&accepted_at=is.null`, {
      cancelled_at: new Date().toISOString(),
    });
  }

  async function listPendingInvites(workspaceId) {
    if (!workspaceId) return [];
    return _softGet(
      'workspace_invites',
      `workspace_id=eq.${_enc(workspaceId)}&accepted_at=is.null&cancelled_at=is.null&order=created_at.desc`
    );
  }

  // ── Client relationships ─────────────────────────────────────────────

  async function addClient({ workspaceId, businessId, clientName, monthlyRetainerUsd, notes }) {
    if (!workspaceId || !businessId) throw new Error('addClient: workspaceId + businessId required');

    const existing = await _softGet(
      'client_relationships',
      `workspace_id=eq.${_enc(workspaceId)}&business_id=eq.${_enc(businessId)}&limit=1`
    );
    if (existing.length) return existing[0];

    const client = await _softPost('client_relationships', {
      workspace_id: workspaceId,
      business_id: businessId,
      client_name: clientName || null,
      monthly_retainer_usd: typeof monthlyRetainerUsd === 'number' ? monthlyRetainerUsd : null,
      notes: notes || null,
    });
    if (client) _bump('workspace_clients_added_total');
    return client;
  }

  async function listClients(workspaceId, { status } = {}) {
    if (!workspaceId) return [];
    let filter = `workspace_id=eq.${_enc(workspaceId)}&order=added_at.desc`;
    if (status) filter += `&status=eq.${_enc(status)}`;
    return _softGet('client_relationships', filter);
  }

  async function getClient(workspaceId, businessId) {
    if (!workspaceId || !businessId) return null;
    const rows = await _softGet(
      'client_relationships',
      `workspace_id=eq.${_enc(workspaceId)}&business_id=eq.${_enc(businessId)}&limit=1`
    );
    return rows[0] || null;
  }

  async function offboardClient({ workspaceId, businessId, reason }) {
    if (!workspaceId || !businessId) return null;
    const patch = {
      status: 'offboarded',
      offboarded_at: new Date().toISOString(),
    };
    if (reason) patch.notes = reason;
    return _softPatch(
      'client_relationships',
      `workspace_id=eq.${_enc(workspaceId)}&business_id=eq.${_enc(businessId)}`,
      patch
    );
  }

  // ── Client approvals ─────────────────────────────────────────────────

  async function requestApproval({
    workspaceId,
    businessId,
    decisionLogId,
    clientEmail,
    previewUrl,
    previewData,
    expiresInHours = 72,
  }) {
    if (!workspaceId || !businessId || !clientEmail) {
      throw new Error('requestApproval: workspaceId + businessId + clientEmail required');
    }
    const token = generateToken();
    const expiresAt = new Date(Date.now() + expiresInHours * 3600000).toISOString();
    const row = await _softPost('client_approvals', {
      workspace_id: workspaceId,
      business_id: businessId,
      decision_log_id: decisionLogId || null,
      approval_token: token,
      preview_url: previewUrl || null,
      preview_data: previewData || {},
      client_email: String(clientEmail).trim().toLowerCase(),
      expires_at: expiresAt,
    });
    if (row) _bump('client_approvals_created_total');
    return row ? { id: row.id, token, expiresAt: row.expires_at } : null;
  }

  async function lookupApproval(token) {
    if (!token) return null;
    const rows = await _softGet('client_approvals', `approval_token=eq.${_enc(token)}&limit=1`);
    const r = rows[0] || null;
    if (!r) return null;
    if (r.status === 'pending' && new Date(r.expires_at) < new Date()) {
      // Lazy-expire
      await _softPatch('client_approvals', `id=eq.${_enc(r.id)}`, { status: 'expired' });
      r.status = 'expired';
    }
    return r;
  }

  async function approveByToken({ token, approvedByEmail }) {
    if (!token) return { ok: false, reason: 'token required' };
    const current = await lookupApproval(token);
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.status !== 'pending') return { ok: false, reason: current.status };

    const patched = await _softPatch('client_approvals', `approval_token=eq.${_enc(token)}`, {
      status: 'approved',
      approved_by_email: approvedByEmail ? String(approvedByEmail).trim().toLowerCase() : null,
      approved_at: new Date().toISOString(),
    });
    _bump('client_approvals_approved_total');
    return { ok: true, approval: patched };
  }

  async function rejectByToken({ token, reason, rejectedByEmail }) {
    if (!token) return { ok: false, reason: 'token required' };
    const current = await lookupApproval(token);
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.status !== 'pending') return { ok: false, reason: current.status };

    const patched = await _softPatch('client_approvals', `approval_token=eq.${_enc(token)}`, {
      status: 'rejected',
      rejected_reason: reason || null,
      approved_by_email: rejectedByEmail ? String(rejectedByEmail).trim().toLowerCase() : null,
      approved_at: new Date().toISOString(),
    });
    _bump('client_approvals_rejected_total');
    return { ok: true, approval: patched };
  }

  async function expireStaleApprovals() {
    const now = new Date().toISOString();
    return _softPatch('client_approvals', `status=eq.pending&expires_at=lt.${_enc(now)}`, {
      status: 'expired',
    });
  }

  return {
    // Workspaces
    createWorkspace,
    getWorkspace,
    getWorkspacesForUser,
    updateWorkspace,
    // Members
    listMembers,
    getMembership,
    addMember,
    updateMemberRole,
    removeMember,
    userHasRole,
    // Invites
    inviteMember,
    acceptInvite,
    cancelInvite,
    listPendingInvites,
    // Clients
    addClient,
    listClients,
    getClient,
    offboardClient,
    // Approvals
    requestApproval,
    lookupApproval,
    approveByToken,
    rejectByToken,
    expireStaleApprovals,
    // Constants
    ROLE_HIERARCHY,
    VALID_ROLES,
    VALID_PLAN_TIERS,
    VALID_CLIENT_STATUSES,
  };
}

module.exports = {
  makeWorkspacesService,
  ROLE_HIERARCHY,
  VALID_ROLES,
  VALID_PLAN_TIERS,
};
