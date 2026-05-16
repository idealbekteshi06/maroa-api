'use strict';

/**
 * lib/warRoomFeed.js
 * ───────────────────────────────────────────────────────────────────────
 * The War Room Feed API — the data layer behind the Autopilot Control Room
 * UI (Phase 3 of the AI-CMO strategy).
 *
 * Per the strategy doc: for every workspace + client, show:
 *   - What changed in the market
 *   - What competitors are doing
 *   - What campaigns are working
 *   - What content is decaying
 *   - What Maroa recommends
 *   - What it can do automatically today
 *   - Expected upside, risk, cost
 *   - Approval button (deep-links to client_approvals)
 *
 * This library aggregates per-workspace data from:
 *   - decision_logs           (what agents proposed + did + outcome)
 *   - client_approvals        (pending approvals + status)
 *   - creative_assets         (performance leaders + decaying creatives)
 *   - marketing_graph_entities (competitor entities + landing pages + etc.)
 *   - experiments             (running experiments + recent winners)
 *   - claims_library          (top-performing claims)
 *
 * The UI consumes the output as-is; no further computation needed.
 *
 * Public API:
 *
 *   const feed = makeWarRoomFeed({
 *     sbGet, workspaces, marketingGraph, decisionLog,
 *     logger, metrics,
 *   });
 *
 *   feed.getWorkspaceFeed(workspaceId, { limit, since })
 *     → {
 *         workspace, clients[],
 *         pending_approvals[],
 *         recent_decisions[],
 *         performance_summary: { top_creatives[], decaying[], …},
 *         experiments_running[], experiments_recent_winners[],
 *         top_claims[], competitor_alerts[],
 *         generated_at,
 *       }
 *
 *   feed.getClientFeed({ workspaceId, businessId, limit })
 *     → per-client subset of the above
 *
 *   feed.summarizeForDashboard(workspaceId)
 *     → tiny shape suitable for a counter row on the agency dashboard
 *         { clients_active, pending_approvals, decisions_last_7d,
 *           total_spend_30d, top_outcome_score }
 *
 *   feed.classifyCreativeDecay(creative, { halfLifeDays }?)
 *     → 'fresh' | 'maturing' | 'decaying' | 'dead' (pure logic, exported for tests)
 *
 * Fail-safe: every aggregate call swallows DB errors + returns soft shape
 * with empty arrays. The UI must never blank-screen on Supabase hiccups.
 */

function _encode(v) {
  return encodeURIComponent(v);
}

// Decay classification: based on age + recent performance trend.
// Pure function — exported separately for testing.
// `now` is parameterised so the same classifier can be replayed against
// historical timestamps (see lib/warRoomKpiHistory.js); default Date.now()
// keeps existing callers unchanged.
function classifyCreativeDecay(creative, { halfLifeDays = 21, now = Date.now() } = {}) {
  if (!creative) return 'dead';
  const createdAt = creative.created_at ? new Date(creative.created_at).getTime() : null;
  if (!createdAt) return 'dead';
  const ageDays = (now - createdAt) / 86400000;
  if (ageDays < 0) return 'fresh'; // creative born after `now` — treat as not-yet-existing-but-fresh
  const perf = typeof creative.performance_score === 'number' ? creative.performance_score : null;

  if (ageDays < 3) return 'fresh';
  if (ageDays < halfLifeDays && (perf == null || perf >= 0.5)) return 'fresh';
  if (ageDays < halfLifeDays * 1.5 && (perf == null || perf >= 0.4)) return 'maturing';
  if (ageDays < halfLifeDays * 3 && (perf == null || perf >= 0.3)) return 'decaying';
  return 'dead';
}

function makeWarRoomFeed(deps = {}) {
  const {
    sbGet,
    workspaces,
    marketingGraph,
    decisionLog,
    logger,
    metrics,
  } = deps;

  if (typeof sbGet !== 'function') {
    throw new Error('warRoomFeed: sbGet required');
  }
  if (!workspaces || typeof workspaces.getWorkspace !== 'function') {
    throw new Error('warRoomFeed: workspaces service required (lib/workspaces)');
  }

  function _bump(name, labels) {
    if (metrics?.increment) {
      try { metrics.increment(name, labels); } catch { /* best effort */ }
    }
  }

  function _logWarn(op, err) {
    if (logger?.warn) logger.warn('warRoomFeed', null, op, { err: err.message || String(err) });
  }

  async function _softGet(table, filter) {
    try {
      return await sbGet(table, filter);
    } catch (e) {
      _bump('war_room_read_errors_total', { table });
      _logWarn(`read ${table}`, e);
      return [];
    }
  }

  // ── Per-client subset (used inside workspace feed for each client) ─────

  async function _gatherForBusiness({ businessId, limit = 10 }) {
    const sinceIso = new Date(Date.now() - 7 * 86400000).toISOString();

    // Recent creatives + performance
    const creativesAll = await _softGet(
      'creative_assets',
      `business_id=eq.${_encode(businessId)}&order=created_at.desc&limit=50`
    );
    const decayBuckets = { fresh: [], maturing: [], decaying: [], dead: [] };
    for (const c of creativesAll) {
      decayBuckets[classifyCreativeDecay(c)].push(c);
    }
    const topCreatives = [...creativesAll]
      .filter((c) => typeof c.performance_score === 'number')
      .sort((a, b) => (b.performance_score || 0) - (a.performance_score || 0))
      .slice(0, limit);

    // Recent decisions
    let recentDecisions = [];
    if (decisionLog && typeof decisionLog.recentDecisions === 'function') {
      try {
        recentDecisions = (await decisionLog.recentDecisions(businessId, { limit })) || [];
      } catch (e) {
        _logWarn('decisionLog.recentDecisions', e);
      }
    } else {
      recentDecisions = await _softGet(
        'decision_logs',
        `business_id=eq.${_encode(businessId)}&order=created_at.desc&limit=${limit}`
      );
    }

    // Top claims
    let topClaims = [];
    if (marketingGraph && typeof marketingGraph.pickTopClaims === 'function') {
      try {
        topClaims = (await marketingGraph.pickTopClaims({ businessId, limit: 5 })) || [];
      } catch (e) {
        _logWarn('marketingGraph.pickTopClaims', e);
      }
    }

    // Running experiments
    const experimentsRunning = await _softGet(
      'experiments',
      `business_id=eq.${_encode(businessId)}&status=eq.running&order=started_at.desc&limit=10`
    );
    const experimentsCompleted = await _softGet(
      'experiments',
      `business_id=eq.${_encode(businessId)}&status=eq.completed&order=ended_at.desc.nullslast&limit=5`
    );

    // Competitor alerts — recent decision_logs from competitor-watch agent.
    // Defensive: rows from non-prod stubs may lack created_at; never throw
    // on Invalid Date.toISOString().
    const competitorAlerts = recentDecisions
      .filter((d) => {
        if (d.agent_name !== 'competitor-watch') return false;
        if (!d.created_at) return false;
        const t = new Date(d.created_at).getTime();
        return Number.isFinite(t) && new Date(t).toISOString() >= sinceIso;
      })
      .slice(0, 5);

    return {
      business_id: businessId,
      creatives_total: creativesAll.length,
      decay_buckets: {
        fresh: decayBuckets.fresh.length,
        maturing: decayBuckets.maturing.length,
        decaying: decayBuckets.decaying.length,
        dead: decayBuckets.dead.length,
      },
      decaying_creatives: decayBuckets.decaying.slice(0, 5),
      top_creatives: topCreatives,
      recent_decisions: recentDecisions,
      top_claims: topClaims,
      experiments_running: experimentsRunning,
      experiments_recent_winners: experimentsCompleted,
      competitor_alerts: competitorAlerts,
    };
  }

  // ── Public: per-workspace aggregate ────────────────────────────────────

  async function getWorkspaceFeed(workspaceId, { perClientLimit = 10 } = {}) {
    if (!workspaceId) {
      return { _soft: true, reason: 'workspaceId required', clients: [] };
    }

    const workspace = await workspaces.getWorkspace(workspaceId);
    if (!workspace) {
      return { _soft: true, reason: 'workspace_not_found', clients: [] };
    }

    const clients = await workspaces.listClients(workspaceId, { status: 'active' });
    const clientFeeds = [];
    for (const client of clients) {
      try {
        const cf = await _gatherForBusiness({
          businessId: client.business_id,
          limit: perClientLimit,
        });
        clientFeeds.push({ client, ...cf });
      } catch (e) {
        _logWarn(`gather business ${client.business_id}`, e);
        clientFeeds.push({ client, error: e.message });
      }
    }

    // Pending approvals across all clients
    const pendingApprovals = await _softGet(
      'client_approvals',
      `workspace_id=eq.${_encode(workspaceId)}&status=eq.pending&order=created_at.desc&limit=50`
    );

    // Aggregate stats
    const totalCreatives = clientFeeds.reduce((s, c) => s + (c.creatives_total || 0), 0);
    const totalRunningExperiments = clientFeeds.reduce(
      (s, c) => s + (c.experiments_running?.length || 0),
      0
    );
    const totalDecaying = clientFeeds.reduce(
      (s, c) => s + (c.decay_buckets?.decaying || 0) + (c.decay_buckets?.dead || 0),
      0
    );

    _bump('war_room_feeds_generated_total', { plan_tier: workspace.plan_tier });

    return {
      workspace,
      clients: clientFeeds,
      pending_approvals: pendingApprovals,
      summary: {
        clients_total: clients.length,
        creatives_total: totalCreatives,
        experiments_running: totalRunningExperiments,
        decaying_or_dead: totalDecaying,
        pending_approvals: pendingApprovals.length,
      },
      generated_at: new Date().toISOString(),
    };
  }

  // ── Public: per-client feed (when UI drills into one client) ───────────

  async function getClientFeed({ workspaceId, businessId, limit = 20 }) {
    if (!workspaceId || !businessId) {
      return { _soft: true, reason: 'workspaceId + businessId required' };
    }

    const client = await workspaces.getClient(workspaceId, businessId);
    if (!client) {
      return { _soft: true, reason: 'client_not_in_workspace' };
    }

    const bizData = await _gatherForBusiness({ businessId, limit });
    const pendingApprovals = await _softGet(
      'client_approvals',
      `workspace_id=eq.${_encode(workspaceId)}&business_id=eq.${_encode(businessId)}` +
        `&status=eq.pending&order=created_at.desc&limit=20`
    );

    return {
      client,
      ...bizData,
      pending_approvals: pendingApprovals,
      generated_at: new Date().toISOString(),
    };
  }

  // ── Public: tiny summary for top of dashboard ──────────────────────────

  async function summarizeForDashboard(workspaceId) {
    if (!workspaceId) return { _soft: true, reason: 'workspaceId required' };

    const sinceIso = new Date(Date.now() - 7 * 86400000).toISOString();

    const clients = await workspaces.listClients(workspaceId, { status: 'active' });
    const businessIds = clients.map((c) => c.business_id).filter(Boolean);

    if (!businessIds.length) {
      return {
        clients_active: 0,
        pending_approvals: 0,
        decisions_last_7d: 0,
        total_spend_30d: 0,
        top_outcome_score: null,
      };
    }

    const inList = businessIds.map(_encode).join(',');

    const pendingApprovals = await _softGet(
      'client_approvals',
      `workspace_id=eq.${_encode(workspaceId)}&status=eq.pending&select=id`
    );

    const decisions = await _softGet(
      'decision_logs',
      `business_id=in.(${inList})&created_at=gte.${_encode(sinceIso)}&select=id,outcome_score,cost_usd`
    );

    const totalSpend = decisions.reduce((s, d) => s + Number(d.cost_usd || 0), 0);
    const outcomeScores = decisions
      .map((d) => d.outcome_score)
      .filter((v) => typeof v === 'number');
    const topOutcomeScore = outcomeScores.length ? Math.max(...outcomeScores) : null;

    return {
      clients_active: clients.length,
      pending_approvals: pendingApprovals.length,
      decisions_last_7d: decisions.length,
      total_spend_30d: Number(totalSpend.toFixed(2)),
      top_outcome_score: topOutcomeScore,
    };
  }

  return {
    getWorkspaceFeed,
    getClientFeed,
    summarizeForDashboard,
    classifyCreativeDecay,
  };
}

module.exports = { makeWarRoomFeed, classifyCreativeDecay };
