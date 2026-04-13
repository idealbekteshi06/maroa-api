/*
 * services/wf14/index.js — Budget & ROI Optimizer engine
 */

'use strict';

const { buildBudgetOptimizerPrompt } = require('../prompts/workflow_14_budget.js');
const { buildBrandContext } = require('../wf1/brandContext.js');

function createWf14(deps) {
  const { sbGet, sbPost, sbPatch, callClaude, extractJSON, logger } = deps;

  async function resolveBrandContext(businessId) {
    const [b, p] = await Promise.all([
      sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
    ]);
    if (!b[0]) throw new Error('Business not found');
    return buildBrandContext({ business: b[0], profile: p[0] || {} });
  }

  async function gatherState(businessId) {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const perf = await sbGet(
      'ad_performance_logs',
      `business_id=eq.${businessId}&logged_at=gte.${encodeURIComponent(since)}&select=*`
    ).catch(() => []);

    const byChannel = new Map();
    for (const p of perf) {
      const channel = p.platform || 'meta';
      const rec = byChannel.get(channel) || { spend: 0, conv: 0, roas_sum: 0, roas_n: 0 };
      rec.spend += Number(p.spend || 0);
      rec.conv += Number(p.conversions || 0);
      if (p.roas != null) { rec.roas_sum += Number(p.roas || 0); rec.roas_n++; }
      byChannel.set(channel, rec);
    }
    const channels = [...byChannel.entries()].map(([channel, r]) => ({
      channel,
      spend: r.spend,
      roas: r.roas_n ? r.roas_sum / r.roas_n : 0,
      conversions: r.conv,
    }));

    const totalSpend = channels.reduce((s, c) => s + c.spend, 0);
    const totalConv = channels.reduce((s, c) => s + c.conversions, 0);
    const blendedCac = totalConv ? totalSpend / totalConv : 0;
    const blendedRoas = channels.length ? channels.reduce((s, c) => s + c.roas, 0) / channels.length : 0;

    return { channels, blendedRoas, blendedCac, monthlyCap: undefined };
  }

  async function runOptimizer({ businessId, force = false }) {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthStartStr = monthStart.toISOString().slice(0, 10);

    const existing = await sbGet('budget_optimizer_runs', `business_id=eq.${businessId}&month_start=eq.${monthStartStr}&select=id`).catch(() => []);
    if (existing[0] && !force) return { runId: existing[0].id, reused: true };

    const brandContext = await resolveBrandContext(businessId);
    const state = await gatherState(businessId);
    const { system, user } = buildBudgetOptimizerPrompt(brandContext, state);
    const raw = await callClaude(user, 'claude-opus-4-5', 3000, { system, businessId, returnRaw: true });
    const parsed = extractJSON(raw) || {};

    const row = await sbPost('budget_optimizer_runs', {
      business_id: businessId,
      month_start: monthStartStr,
      blended_roas: parsed.blended_roas || state.blendedRoas,
      blended_cac: parsed.blended_cac || state.blendedCac,
      ltv_cac_ratio: parsed.blended_ltv_cac_ratio || 0,
      per_channel: parsed.per_channel || [],
      reallocation_moves: parsed.reallocation_moves || [],
      total_spend_change_usd: parsed.total_spend_change_usd || 0,
      projected_blended_roas: parsed.projected_blended_roas_next_month || 0,
      confidence: parsed.confidence || 'medium',
      model_used: 'claude-opus-4-5',
      status: 'awaiting_approval',
    });

    await sbPost('events', {
      business_id: businessId,
      kind: 'wf14.optimizer.completed',
      workflow: '14_budget',
      payload: { run_id: row.id, net_change: parsed.total_spend_change_usd },
      severity: 'info',
    }).catch(() => {});

    return { runId: row.id, ...parsed };
  }

  async function getLatest(businessId) {
    const rows = await sbGet('budget_optimizer_runs', `business_id=eq.${businessId}&order=month_start.desc&limit=1&select=*`).catch(() => []);
    return rows[0] || null;
  }

  return { runOptimizer, getLatest, gatherState, resolveBrandContext };
}

module.exports = createWf14;
