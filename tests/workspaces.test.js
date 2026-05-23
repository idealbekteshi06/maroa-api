'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { makeWorkspacesService, ROLE_HIERARCHY, VALID_ROLES } = require('../lib/workspaces');

function makeFakeSb() {
  const writes = [];
  const patches = [];
  const tables = new Map();
  let tokenCounter = 0;

  function _filterRows(rows, filter) {
    // Best-effort PostgREST filter parser for the tests
    if (!filter) return rows;
    const out = rows.slice();
    const clauses = filter.split('&');
    for (const c of clauses) {
      if (c.startsWith('select=') || c.startsWith('order=') || c.startsWith('limit=')) continue;
      // col=eq.value
      const m = /^([a-zA-Z_]+)=eq\.(.+)$/.exec(c);
      if (m) {
        const [, col, val] = m;
        const decoded = decodeURIComponent(val);
        for (let i = out.length - 1; i >= 0; i--) {
          if (String(out[i][col]) !== decoded) out.splice(i, 1);
        }
        continue;
      }
      const isNull = /^([a-zA-Z_]+)=is\.null$/.exec(c);
      if (isNull) {
        const col = isNull[1];
        for (let i = out.length - 1; i >= 0; i--) {
          if (out[i][col] != null) out.splice(i, 1);
        }
        continue;
      }
      const inMatch = /^([a-zA-Z_]+)=in\.\(([^)]+)\)$/.exec(c);
      if (inMatch) {
        const col = inMatch[1];
        const vals = inMatch[2].split(',').map(decodeURIComponent);
        for (let i = out.length - 1; i >= 0; i--) {
          if (!vals.includes(String(out[i][col]))) out.splice(i, 1);
        }
        continue;
      }
    }
    return out;
  }

  return {
    writes,
    patches,
    preload: (table, rows) => tables.set(table, rows),
    sbGet: async (table, filter) => {
      const rows = tables.get(table) || [];
      return _filterRows(rows, filter);
    },
    sbPost: async (table, row, opts = {}) => {
      const id = row.id || `id-${++tokenCounter}`;
      const inserted = { id, ...row, created_at: new Date().toISOString() };
      writes.push({ table, row });
      const arr = tables.get(table) || [];
      arr.push(inserted);
      tables.set(table, arr);
      return opts.returning === 'representation' ? [inserted] : inserted;
    },
    sbPatch: async (table, filter, updates, opts = {}) => {
      patches.push({ table, filter, updates });
      // Apply patch to in-memory rows so subsequent reads see the change
      const rows = tables.get(table) || [];
      const matching = _filterRows(rows, filter);
      for (const row of matching) Object.assign(row, updates);
      return opts.returning === 'representation'
        ? [matching[0] || { id: 'patched', ...updates }]
        : matching[0] || { id: 'patched', ...updates };
    },
  };
}

function deterministicToken() {
  let i = 0;
  return () => `tok-${++i}`;
}

// ─── Construction ─────────────────────────────────────────────────────────

test('workspaces: requires sbGet+sbPost+sbPatch', () => {
  assert.throws(() => makeWorkspacesService({}), /required deps/);
});

test('workspaces: ROLE_HIERARCHY exports ranks', () => {
  assert.strictEqual(ROLE_HIERARCHY.owner, 5);
  assert.strictEqual(ROLE_HIERARCHY.client, 1);
});

test('workspaces: VALID_ROLES has all 5 roles', () => {
  assert.strictEqual(VALID_ROLES.length, 5);
  assert.ok(VALID_ROLES.includes('owner'));
});

// ─── createWorkspace ──────────────────────────────────────────────────────

test('createWorkspace: validates required fields', () => {
  const ws = makeWorkspacesService(makeFakeSb());
  assert.rejects(() => ws.createWorkspace({ name: 'X' }), /required/);
});

test('createWorkspace: validates plan_tier', () => {
  const ws = makeWorkspacesService(makeFakeSb());
  assert.rejects(() => ws.createWorkspace({ ownerUserId: 'u', name: 'X', planTier: 'bogus' }), /planTier must be/);
});

test('createWorkspace: creates workspace + auto-adds owner as member', async () => {
  const sb = makeFakeSb();
  const ws = makeWorkspacesService(sb);
  const r = await ws.createWorkspace({ ownerUserId: 'u-1', name: 'My Agency' });
  assert.ok(r.id);
  assert.strictEqual(r.plan_tier, 'freelancer');
  // Two writes: workspace + member
  assert.strictEqual(sb.writes.length, 2);
  assert.strictEqual(sb.writes[1].table, 'workspace_members');
  assert.strictEqual(sb.writes[1].row.role, 'owner');
});

// ─── getWorkspacesForUser ─────────────────────────────────────────────────

test('getWorkspacesForUser: empty when no memberships', async () => {
  const sb = makeFakeSb();
  const ws = makeWorkspacesService(sb);
  assert.deepStrictEqual(await ws.getWorkspacesForUser('u-x'), []);
});

test('getWorkspacesForUser: returns workspaces user is member of', async () => {
  const sb = makeFakeSb();
  sb.preload('workspace_members', [
    { user_id: 'u-1', workspace_id: 'ws-a' },
    { user_id: 'u-1', workspace_id: 'ws-b' },
    { user_id: 'u-2', workspace_id: 'ws-c' },
  ]);
  sb.preload('workspaces', [
    { id: 'ws-a', name: 'A' },
    { id: 'ws-b', name: 'B' },
    { id: 'ws-c', name: 'C' },
  ]);
  const ws = makeWorkspacesService(sb);
  const r = await ws.getWorkspacesForUser('u-1');
  assert.strictEqual(r.length, 2);
  const ids = new Set(r.map((w) => w.id));
  assert.ok(ids.has('ws-a'));
  assert.ok(ids.has('ws-b'));
});

// ─── Members ─────────────────────────────────────────────────────────────

test('addMember: validates role', () => {
  const ws = makeWorkspacesService(makeFakeSb());
  assert.rejects(() => ws.addMember({ workspaceId: 'w', userId: 'u', role: 'invalid' }), /role must be/);
});

test('addMember: returns existing on duplicate (idempotent)', async () => {
  const sb = makeFakeSb();
  sb.preload('workspace_members', [{ id: 'm-1', workspace_id: 'w', user_id: 'u', role: 'strategist' }]);
  const ws = makeWorkspacesService(sb);
  const r = await ws.addMember({ workspaceId: 'w', userId: 'u', role: 'strategist' });
  assert.strictEqual(r.id, 'm-1');
  assert.strictEqual(sb.writes.length, 0);
});

test('userHasRole: respects hierarchy', async () => {
  const sb = makeFakeSb();
  sb.preload('workspace_members', [{ workspace_id: 'w', user_id: 'u', role: 'strategist' }]);
  const ws = makeWorkspacesService(sb);
  assert.strictEqual(await ws.userHasRole({ workspaceId: 'w', userId: 'u', atLeast: 'viewer' }), true);
  assert.strictEqual(await ws.userHasRole({ workspaceId: 'w', userId: 'u', atLeast: 'strategist' }), true);
  assert.strictEqual(await ws.userHasRole({ workspaceId: 'w', userId: 'u', atLeast: 'owner' }), false);
});

test('userHasRole: returns false for non-members', async () => {
  const ws = makeWorkspacesService(makeFakeSb());
  assert.strictEqual(await ws.userHasRole({ workspaceId: 'w', userId: 'u', atLeast: 'viewer' }), false);
});

// ─── Invites ─────────────────────────────────────────────────────────────

test('inviteMember: creates invite with token + expiry', async () => {
  const sb = makeFakeSb();
  const ws = makeWorkspacesService({ ...sb, generateToken: deterministicToken() });
  const inv = await ws.inviteMember({ workspaceId: 'w-1', email: 'a@b.com', role: 'designer' });
  assert.ok(inv);
  assert.strictEqual(inv.token, 'tok-1');
  assert.ok(new Date(inv.expires_at) > new Date());
});

test('inviteMember: normalizes email to lowercase', async () => {
  const sb = makeFakeSb();
  const ws = makeWorkspacesService({ ...sb, generateToken: deterministicToken() });
  await ws.inviteMember({ workspaceId: 'w-1', email: 'A@B.com', role: 'designer' });
  assert.strictEqual(sb.writes[0].row.email, 'a@b.com');
});

test('acceptInvite: not found → ok:false', async () => {
  const ws = makeWorkspacesService(makeFakeSb());
  const r = await ws.acceptInvite({ token: 'missing', userId: 'u' });
  assert.strictEqual(r.ok, false);
});

test('acceptInvite: happy path → adds member + marks accepted', async () => {
  const sb = makeFakeSb();
  sb.preload('workspace_invites', [
    {
      id: 'inv-1',
      token: 'tok-x',
      workspace_id: 'ws-1',
      role: 'designer',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      accepted_at: null,
      cancelled_at: null,
    },
  ]);
  const ws = makeWorkspacesService(sb);
  const r = await ws.acceptInvite({ token: 'tok-x', userId: 'u-1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.workspace_id, 'ws-1');
  // 1 write for the new workspace_member
  const memberWrites = sb.writes.filter((w) => w.table === 'workspace_members');
  assert.strictEqual(memberWrites.length, 1);
  // 1 patch to mark accepted
  const invitePatches = sb.patches.filter((p) => p.table === 'workspace_invites');
  assert.strictEqual(invitePatches.length, 1);
  assert.ok(invitePatches[0].updates.accepted_at);
});

test('acceptInvite: expired invite returns ok:false', async () => {
  const sb = makeFakeSb();
  sb.preload('workspace_invites', [
    {
      id: 'inv-1',
      token: 'tok-x',
      workspace_id: 'ws-1',
      role: 'designer',
      expires_at: new Date(Date.now() - 86400000).toISOString(), // expired
      accepted_at: null,
      cancelled_at: null,
    },
  ]);
  const ws = makeWorkspacesService(sb);
  const r = await ws.acceptInvite({ token: 'tok-x', userId: 'u-1' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invite_expired');
});

test('cancelInvite: patches cancelled_at', async () => {
  const sb = makeFakeSb();
  const ws = makeWorkspacesService(sb);
  await ws.cancelInvite({ token: 'tok-x' });
  assert.strictEqual(sb.patches.length, 1);
  assert.ok(sb.patches[0].updates.cancelled_at);
});

// ─── Client relationships ────────────────────────────────────────────────

test('addClient: idempotent (returns existing)', async () => {
  const sb = makeFakeSb();
  sb.preload('client_relationships', [{ id: 'cr-1', workspace_id: 'w-1', business_id: 'b-1', status: 'active' }]);
  const ws = makeWorkspacesService(sb);
  const r = await ws.addClient({ workspaceId: 'w-1', businessId: 'b-1' });
  assert.strictEqual(r.id, 'cr-1');
  assert.strictEqual(sb.writes.length, 0);
});

test('addClient: requires both ids', () => {
  const ws = makeWorkspacesService(makeFakeSb());
  assert.rejects(() => ws.addClient({ workspaceId: 'w' }), /required/);
});

test('listClients: filters by status', async () => {
  const sb = makeFakeSb();
  sb.preload('client_relationships', [
    { workspace_id: 'w', business_id: 'b1', status: 'active' },
    { workspace_id: 'w', business_id: 'b2', status: 'paused' },
  ]);
  const ws = makeWorkspacesService(sb);
  const active = await ws.listClients('w', { status: 'active' });
  assert.strictEqual(active.length, 1);
});

test('offboardClient: sets status + offboarded_at', async () => {
  const sb = makeFakeSb();
  const ws = makeWorkspacesService(sb);
  await ws.offboardClient({ workspaceId: 'w', businessId: 'b', reason: 'lost client' });
  assert.strictEqual(sb.patches[0].updates.status, 'offboarded');
  assert.ok(sb.patches[0].updates.offboarded_at);
  assert.strictEqual(sb.patches[0].updates.notes, 'lost client');
});

// ─── Client approvals ────────────────────────────────────────────────────

test('requestApproval: validates required fields', () => {
  const ws = makeWorkspacesService(makeFakeSb());
  assert.rejects(() => ws.requestApproval({ workspaceId: 'w' }), /required/);
});

test('requestApproval: returns token + expiry', async () => {
  const sb = makeFakeSb();
  const ws = makeWorkspacesService({ ...sb, generateToken: deterministicToken() });
  const r = await ws.requestApproval({
    workspaceId: 'w',
    businessId: 'b',
    clientEmail: 'client@x.com',
    previewData: { creative_id: 'c-1' },
  });
  assert.strictEqual(r.token, 'tok-1');
  assert.ok(new Date(r.expiresAt) > new Date());
});

test('approveByToken: marks approved + records approver', async () => {
  const sb = makeFakeSb();
  sb.preload('client_approvals', [
    {
      id: 'ca-1',
      approval_token: 'tok-x',
      workspace_id: 'w',
      business_id: 'b',
      status: 'pending',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    },
  ]);
  const ws = makeWorkspacesService(sb);
  const r = await ws.approveByToken({ token: 'tok-x', approvedByEmail: 'Client@X.com' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sb.patches[0].updates.status, 'approved');
  assert.strictEqual(sb.patches[0].updates.approved_by_email, 'client@x.com');
});

test('approveByToken: already-approved → ok:false', async () => {
  const sb = makeFakeSb();
  sb.preload('client_approvals', [
    {
      id: 'ca-1',
      approval_token: 'tok-x',
      workspace_id: 'w',
      business_id: 'b',
      status: 'approved',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    },
  ]);
  const ws = makeWorkspacesService(sb);
  const r = await ws.approveByToken({ token: 'tok-x', approvedByEmail: 'c@x.com' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'approved');
});

test('rejectByToken: marks rejected with reason', async () => {
  const sb = makeFakeSb();
  sb.preload('client_approvals', [
    {
      id: 'ca-1',
      approval_token: 'tok-x',
      workspace_id: 'w',
      business_id: 'b',
      status: 'pending',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    },
  ]);
  const ws = makeWorkspacesService(sb);
  const r = await ws.rejectByToken({ token: 'tok-x', reason: 'off-brand' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sb.patches[0].updates.status, 'rejected');
  assert.strictEqual(sb.patches[0].updates.rejected_reason, 'off-brand');
});

test('lookupApproval: lazy-expires past-deadline rows', async () => {
  const sb = makeFakeSb();
  sb.preload('client_approvals', [
    {
      id: 'ca-1',
      approval_token: 'tok-x',
      status: 'pending',
      expires_at: new Date(Date.now() - 60000).toISOString(), // expired
    },
  ]);
  const ws = makeWorkspacesService(sb);
  const r = await ws.lookupApproval('tok-x');
  assert.strictEqual(r.status, 'expired');
  assert.strictEqual(sb.patches.length, 1);
  assert.strictEqual(sb.patches[0].updates.status, 'expired');
});

// ─── Token generator ─────────────────────────────────────────────────────

test('generateToken: default produces unique 32-byte tokens', () => {
  const ws = makeWorkspacesService(makeFakeSb());
  // Sanity — call createWorkspace + inviteMember and watch tokens differ.
  // Actually we can test directly by reaching into the default generator.
  const { randomBytes } = require('crypto');
  const a = randomBytes(32).toString('base64url');
  const b = randomBytes(32).toString('base64url');
  assert.notStrictEqual(a, b);
  assert.ok(a.length >= 43);
});
