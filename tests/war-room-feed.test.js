'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { makeWarRoomFeed, classifyCreativeDecay } = require('../lib/warRoomFeed');

function makeStubWorkspaces({ workspace, clients = [], clientByPair = null } = {}) {
  return {
    getWorkspace: async () => workspace,
    listClients: async () => clients,
    getClient: async (workspaceId, businessId) => {
      if (clientByPair) {
        const key = `${workspaceId}:${businessId}`;
        return clientByPair[key] || null;
      }
      return clients.find((c) => c.business_id === businessId) || null;
    },
  };
}

function makeStubSbGet(tables = {}) {
  return async (table, filter = '') => {
    const rows = tables[table] || [];
    // Best-effort filter: only handle `business_id=eq.X` + `workspace_id=eq.X`
    // since that's what's used in the feed library.
    const matches = (row) => {
      for (const clause of filter.split('&')) {
        const m = /^([a-zA-Z_]+)=eq\.(.+)$/.exec(clause);
        if (m && String(row[m[1]]) !== decodeURIComponent(m[2])) return false;
      }
      return true;
    };
    return rows.filter(matches);
  };
}

function makeStubGraph(claims = []) {
  return {
    pickTopClaims: async () => claims,
  };
}

function makeStubDecisionLog(decisions = []) {
  return {
    recentDecisions: async (businessId) => decisions.filter((d) => d.business_id === businessId),
  };
}

// ─── classifyCreativeDecay (pure logic) ───────────────────────────────────

test('classifyCreativeDecay: fresh when <3 days old regardless of perf', () => {
  const c = { created_at: new Date(Date.now() - 1 * 86400000).toISOString(), performance_score: 0.1 };
  assert.strictEqual(classifyCreativeDecay(c), 'fresh');
});

test('classifyCreativeDecay: fresh when within half-life + perf >= 0.5', () => {
  const c = { created_at: new Date(Date.now() - 10 * 86400000).toISOString(), performance_score: 0.7 };
  assert.strictEqual(classifyCreativeDecay(c), 'fresh');
});

test('classifyCreativeDecay: maturing within 1.5x half-life with moderate perf', () => {
  const c = { created_at: new Date(Date.now() - 25 * 86400000).toISOString(), performance_score: 0.45 };
  assert.strictEqual(classifyCreativeDecay(c), 'maturing');
});

test('classifyCreativeDecay: decaying within 3x half-life with mediocre perf', () => {
  const c = { created_at: new Date(Date.now() - 45 * 86400000).toISOString(), performance_score: 0.32 };
  assert.strictEqual(classifyCreativeDecay(c), 'decaying');
});

test('classifyCreativeDecay: dead when ancient or low-perf', () => {
  const c = { created_at: new Date(Date.now() - 90 * 86400000).toISOString(), performance_score: 0.2 };
  assert.strictEqual(classifyCreativeDecay(c), 'dead');
});

test('classifyCreativeDecay: dead when created_at missing', () => {
  assert.strictEqual(classifyCreativeDecay({}), 'dead');
  assert.strictEqual(classifyCreativeDecay(null), 'dead');
});

test('classifyCreativeDecay: custom halfLifeDays', () => {
  const c = { created_at: new Date(Date.now() - 30 * 86400000).toISOString(), performance_score: 0.6 };
  assert.strictEqual(classifyCreativeDecay(c, { halfLifeDays: 45 }), 'fresh');
});

// ─── makeWarRoomFeed construction ─────────────────────────────────────────

test('warRoomFeed: requires sbGet + workspaces', () => {
  assert.throws(() => makeWarRoomFeed({}), /sbGet required/);
  assert.throws(
    () => makeWarRoomFeed({ sbGet: async () => [] }),
    /workspaces service required/
  );
});

// ─── getWorkspaceFeed ─────────────────────────────────────────────────────

test('getWorkspaceFeed: soft-fails when no workspaceId', async () => {
  const f = makeWarRoomFeed({
    sbGet: makeStubSbGet(),
    workspaces: makeStubWorkspaces({}),
  });
  const r = await f.getWorkspaceFeed(null);
  assert.strictEqual(r._soft, true);
});

test('getWorkspaceFeed: soft-fails when workspace not found', async () => {
  const f = makeWarRoomFeed({
    sbGet: makeStubSbGet(),
    workspaces: makeStubWorkspaces({ workspace: null }),
  });
  const r = await f.getWorkspaceFeed('w-1');
  assert.strictEqual(r._soft, true);
  assert.strictEqual(r.reason, 'workspace_not_found');
});

test('getWorkspaceFeed: empty workspace returns clients=[]', async () => {
  const f = makeWarRoomFeed({
    sbGet: makeStubSbGet(),
    workspaces: makeStubWorkspaces({ workspace: { id: 'w-1', plan_tier: 'freelancer' }, clients: [] }),
  });
  const r = await f.getWorkspaceFeed('w-1');
  assert.strictEqual(r.workspace.id, 'w-1');
  assert.deepStrictEqual(r.clients, []);
  assert.strictEqual(r.summary.clients_total, 0);
});

test('getWorkspaceFeed: aggregates per-client data', async () => {
  const creatives = [
    {
      id: 'c-1',
      business_id: 'b-1',
      performance_score: 0.8,
      created_at: new Date(Date.now() - 5 * 86400000).toISOString(),
    },
    {
      id: 'c-2',
      business_id: 'b-1',
      performance_score: 0.15,
      created_at: new Date(Date.now() - 90 * 86400000).toISOString(),  // → dead
    },
  ];
  const decisions = [{ id: 'd-1', business_id: 'b-1', agent_name: 'ad-optimizer' }];
  const pending = [{ id: 'a-1', workspace_id: 'w-1', business_id: 'b-1', status: 'pending' }];

  const f = makeWarRoomFeed({
    sbGet: makeStubSbGet({
      creative_assets: creatives,
      experiments: [],
      decision_logs: decisions,
      client_approvals: pending,
    }),
    workspaces: makeStubWorkspaces({
      workspace: { id: 'w-1', plan_tier: 'agency' },
      clients: [{ id: 'cr-1', business_id: 'b-1', client_name: 'Acme Café' }],
    }),
  });

  const r = await f.getWorkspaceFeed('w-1');
  assert.strictEqual(r.clients.length, 1);
  assert.strictEqual(r.clients[0].business_id, 'b-1');
  assert.strictEqual(r.clients[0].creatives_total, 2);
  assert.strictEqual(r.clients[0].decay_buckets.dead, 1);
  assert.strictEqual(r.clients[0].top_creatives[0].id, 'c-1');
  assert.strictEqual(r.pending_approvals.length, 1);
  assert.strictEqual(r.summary.clients_total, 1);
  assert.strictEqual(r.summary.decaying_or_dead, 1);
  assert.strictEqual(r.summary.pending_approvals, 1);
});

test('getWorkspaceFeed: surfaces competitor alerts within 7d window', async () => {
  const recentCompetitorAlert = {
    id: 'd-1',
    business_id: 'b-1',
    agent_name: 'competitor-watch',
    created_at: new Date(Date.now() - 1 * 86400000).toISOString(),
  };
  const oldAlert = {
    id: 'd-2',
    business_id: 'b-1',
    agent_name: 'competitor-watch',
    created_at: new Date(Date.now() - 30 * 86400000).toISOString(),
  };

  const f = makeWarRoomFeed({
    sbGet: makeStubSbGet({ creative_assets: [], experiments: [], decision_logs: [], client_approvals: [] }),
    workspaces: makeStubWorkspaces({
      workspace: { id: 'w-1', plan_tier: 'agency' },
      clients: [{ id: 'cr-1', business_id: 'b-1' }],
    }),
    decisionLog: makeStubDecisionLog([recentCompetitorAlert, oldAlert]),
  });

  const r = await f.getWorkspaceFeed('w-1');
  assert.strictEqual(r.clients[0].competitor_alerts.length, 1);
  assert.strictEqual(r.clients[0].competitor_alerts[0].id, 'd-1');
});

// ─── getClientFeed ────────────────────────────────────────────────────────

test('getClientFeed: soft-fails when client not in workspace', async () => {
  const f = makeWarRoomFeed({
    sbGet: makeStubSbGet(),
    workspaces: makeStubWorkspaces({ workspace: { id: 'w-1' }, clients: [] }),
  });
  const r = await f.getClientFeed({ workspaceId: 'w-1', businessId: 'b-x' });
  assert.strictEqual(r._soft, true);
  assert.strictEqual(r.reason, 'client_not_in_workspace');
});

test('getClientFeed: returns enriched data for valid client', async () => {
  const f = makeWarRoomFeed({
    sbGet: makeStubSbGet({
      creative_assets: [
        { id: 'c-1', business_id: 'b-1', performance_score: 0.7, created_at: new Date().toISOString() },
      ],
      experiments: [],
      decision_logs: [],
      client_approvals: [{ id: 'a-1', workspace_id: 'w-1', business_id: 'b-1', status: 'pending' }],
    }),
    workspaces: makeStubWorkspaces({
      workspace: { id: 'w-1' },
      clients: [{ id: 'cr-1', business_id: 'b-1', client_name: 'Acme Café' }],
    }),
  });
  const r = await f.getClientFeed({ workspaceId: 'w-1', businessId: 'b-1' });
  assert.strictEqual(r.client.business_id, 'b-1');
  assert.strictEqual(r.creatives_total, 1);
  assert.strictEqual(r.pending_approvals.length, 1);
});

// ─── summarizeForDashboard ────────────────────────────────────────────────

test('summarizeForDashboard: zero-state for empty workspace', async () => {
  const f = makeWarRoomFeed({
    sbGet: makeStubSbGet(),
    workspaces: makeStubWorkspaces({ clients: [] }),
  });
  const r = await f.summarizeForDashboard('w-1');
  assert.strictEqual(r.clients_active, 0);
  assert.strictEqual(r.pending_approvals, 0);
  assert.strictEqual(r.decisions_last_7d, 0);
});

test('summarizeForDashboard: aggregates spend + outcome scores', async () => {
  const decisions = [
    { id: 'd-1', business_id: 'b-1', cost_usd: 0.30, outcome_score: 0.75, created_at: new Date().toISOString() },
    { id: 'd-2', business_id: 'b-1', cost_usd: 0.50, outcome_score: 0.95, created_at: new Date().toISOString() },
    { id: 'd-3', business_id: 'b-2', cost_usd: 0.20, outcome_score: 0.4, created_at: new Date().toISOString() },
  ];
  const pending = [{ id: 'a-1', workspace_id: 'w-1', status: 'pending' }];

  const f = makeWarRoomFeed({
    sbGet: async (table) => {
      if (table === 'client_approvals') return pending;
      if (table === 'decision_logs') return decisions;
      return [];
    },
    workspaces: makeStubWorkspaces({
      clients: [
        { business_id: 'b-1' },
        { business_id: 'b-2' },
      ],
    }),
  });
  const r = await f.summarizeForDashboard('w-1');
  assert.strictEqual(r.clients_active, 2);
  assert.strictEqual(r.pending_approvals, 1);
  assert.strictEqual(r.decisions_last_7d, 3);
  assert.strictEqual(r.total_spend_30d, 1.00);
  assert.strictEqual(r.top_outcome_score, 0.95);
});

test('summarizeForDashboard: soft-fails on missing workspaceId', async () => {
  const f = makeWarRoomFeed({
    sbGet: makeStubSbGet(),
    workspaces: makeStubWorkspaces({}),
  });
  const r = await f.summarizeForDashboard(null);
  assert.strictEqual(r._soft, true);
});

// ─── Fail-safe ────────────────────────────────────────────────────────────

test('getWorkspaceFeed: gather error on one client doesn\'t crash whole feed', async () => {
  const f = makeWarRoomFeed({
    sbGet: async (table) => {
      if (table === 'creative_assets') throw new Error('table missing');
      return [];
    },
    workspaces: makeStubWorkspaces({
      workspace: { id: 'w-1' },
      clients: [{ id: 'cr-1', business_id: 'b-1' }],
    }),
  });
  const r = await f.getWorkspaceFeed('w-1');
  // Soft-read returns [] for the failing table; the client entry should
  // still appear with empty/zero stats.
  assert.strictEqual(r.workspace.id, 'w-1');
  assert.strictEqual(r.clients.length, 1);
  assert.strictEqual(r.clients[0].creatives_total, 0);
});
