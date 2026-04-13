/*
 * services/wf3/index.js
 * ----------------------------------------------------------------------------
 * Workflow #3 — Ad Optimization Loop.
 *
 * Weekly pipeline:
 *   1. Build snapshot from ad_campaigns + ad_performance_logs (last 7d + 4w trajectory)
 *   2. Call Claude Opus with buildAdOptimizationPrompt
 *   3. Persist decision as ad_optimization_runs + one ad_optimization_actions per action
 *   4. If autonomy allows, auto-apply low-risk actions; queue high-risk for approval
 *
 * Apply actions dispatches via existing meta/google campaign helpers
 * (placeholders — actual platform calls would reuse webhooks).
 * ----------------------------------------------------------------------------
 */

'use strict';

const { buildAdOptimizationPrompt } = require('../prompts/workflow_3_ads.js');
const { buildBrandContext } = require('../wf1/brandContext.js');

function createWf3(deps) {
  const { sbGet, sbPost, sbPatch, callClaude, extractJSON, logger, apiRequest } = deps;

  async function resolveBrandContext(businessId) {
    const [b, p] = await Promise.all([
      sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
    ]);
    if (!b[0]) throw new Error('Business not found');
    return buildBrandContext({ business: b[0], profile: p[0] || {} });
  }

  async function buildSnapshot({ businessId, weekStart }) {
    const start = weekStart ? new Date(weekStart + 'T00:00:00Z') : new Date(Date.now() - 7 * 86400000);
    const end = new Date(start.getTime() + 7 * 86400000);

    const [campaigns, perf, historical] = await Promise.all([
      sbGet('ad_campaigns', `business_id=eq.${businessId}&select=*&limit=100`).catch(() => []),
      sbGet(
        'ad_performance_logs',
        `business_id=eq.${businessId}&logged_at=gte.${encodeURIComponent(start.toISOString())}&logged_at=lt.${encodeURIComponent(end.toISOString())}&select=*&limit=500`
      ).catch(() => []),
      sbGet(
        'ad_performance_logs',
        `business_id=eq.${businessId}&logged_at=gte.${encodeURIComponent(new Date(start.getTime() - 28 * 86400000).toISOString())}&logged_at=lt.${encodeURIComponent(end.toISOString())}&select=logged_at,spend,roas,cpc,conversions`
      ).catch(() => []),
    ]);

    // Aggregate per campaign for the week
    const byCamp = new Map();
    for (const p of perf) {
      const key = p.campaign_id || 'unknown';
      const rec = byCamp.get(key) || { spend: 0, clicks: 0, impressions: 0, conversions: 0, reach: 0, roas_sum: 0, roas_n: 0, ctr_sum: 0, ctr_n: 0, freq_sum: 0, freq_n: 0, cpc_sum: 0, cpc_n: 0 };
      rec.spend += Number(p.spend || 0);
      rec.clicks += Number(p.clicks || 0);
      rec.impressions += Number(p.impressions || 0);
      rec.conversions += Number(p.conversions || 0);
      rec.reach += Number(p.reach || 0);
      if (p.roas != null) { rec.roas_sum += Number(p.roas || 0); rec.roas_n++; }
      if (p.ctr != null) { rec.ctr_sum += Number(p.ctr || 0); rec.ctr_n++; }
      if (p.frequency != null) { rec.freq_sum += Number(p.frequency || 0); rec.freq_n++; }
      if (p.cpc != null) { rec.cpc_sum += Number(p.cpc || 0); rec.cpc_n++; }
      byCamp.set(key, rec);
    }
    const campSnap = (campaigns || []).map(c => {
      const r = byCamp.get(c.meta_campaign_id || c.id) || {};
      return {
        platform: c.platform || 'meta',
        id: c.meta_campaign_id || c.id,
        name: c.business_name || c.campaign_name || c.id,
        status: c.status || 'unknown',
        spend: r.spend || 0,
        conversions: r.conversions || 0,
        roas: r.roas_n ? r.roas_sum / r.roas_n : 0,
        cpa: r.conversions ? (r.spend || 0) / r.conversions : 0,
        ctr: r.ctr_n ? r.ctr_sum / r.ctr_n : 0,
        frequency: r.freq_n ? r.freq_sum / r.freq_n : 0,
      };
    });

    const totalSpend = campSnap.reduce((s, c) => s + c.spend, 0);
    const totalConversions = campSnap.reduce((s, c) => s + c.conversions, 0);
    const blendedCac = totalConversions ? totalSpend / totalConversions : 0;
    const blendedRoas = campSnap.length ? campSnap.reduce((s, c) => s + c.roas, 0) / campSnap.length : 0;

    // Build 4-week trajectory by ISO week
    const weekBuckets = new Map();
    for (const p of historical) {
      const d = new Date(p.logged_at);
      const dow = (d.getDay() + 6) % 7;
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - dow);
      const wk = d.toISOString().slice(0, 10);
      const rec = weekBuckets.get(wk) || { spend: 0, conversions: 0, roas_sum: 0, roas_n: 0 };
      rec.spend += Number(p.spend || 0);
      rec.conversions += Number(p.conversions || 0);
      if (p.roas != null) { rec.roas_sum += Number(p.roas || 0); rec.roas_n++; }
      weekBuckets.set(wk, rec);
    }
    const trajectory = [...weekBuckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-4)
      .map(([weekStart, r]) => ({
        weekStart,
        spend: r.spend,
        roas: r.roas_n ? r.roas_sum / r.roas_n : 0,
        cac: r.conversions ? r.spend / r.conversions : 0,
      }));

    return {
      weekStart: start.toISOString().slice(0, 10),
      weekEnd: new Date(end.getTime() - 1).toISOString().slice(0, 10),
      campaigns: campSnap,
      totalSpend,
      blendedCac,
      blendedRoas,
      trajectory,
      goals: undefined,
      budgetCeiling: undefined,
    };
  }

  async function runOptimization({ businessId, weekStart, force = false }) {
    const brandContext = await resolveBrandContext(businessId);
    const snapshot = await buildSnapshot({ businessId, weekStart });

    // Idempotency
    const existing = await sbGet('ad_optimization_runs', `business_id=eq.${businessId}&week_start=eq.${snapshot.weekStart}&select=id,status`).catch(() => []);
    if (existing[0] && !force) {
      return { runId: existing[0].id, status: existing[0].status, reused: true };
    }

    const { system, user } = buildAdOptimizationPrompt(brandContext, snapshot);
    const raw = await callClaude(user, 'claude-opus-4-5', 3500, { system, businessId, returnRaw: true });
    const decision = extractJSON(raw) || {};

    let runRow;
    if (existing[0]) {
      await sbPatch('ad_optimization_runs', `id=eq.${existing[0].id}`, {
        snapshot,
        decision,
        blended_roas: snapshot.blendedRoas,
        blended_cac: snapshot.blendedCac,
        total_spend_usd: snapshot.totalSpend,
        model_used: 'claude-opus-4-5',
        status: 'awaiting_approval',
      });
      runRow = { id: existing[0].id };
    } else {
      runRow = await sbPost('ad_optimization_runs', {
        business_id: businessId,
        week_start: snapshot.weekStart,
        week_end: snapshot.weekEnd,
        snapshot,
        decision,
        blended_roas: snapshot.blendedRoas,
        blended_cac: snapshot.blendedCac,
        total_spend_usd: snapshot.totalSpend,
        model_used: 'claude-opus-4-5',
        status: 'awaiting_approval',
      });
    }

    // Persist actions
    for (const a of decision.actions || []) {
      await sbPost('ad_optimization_actions', {
        run_id: runRow.id,
        business_id: businessId,
        action_kind: a.action_kind || 'scale',
        entity_platform: a.entity_platform || 'meta',
        entity_id: a.entity_id || null,
        entity_name: a.entity_name || null,
        current_state: a.current_state || null,
        recommendation: a.recommendation || null,
        why_now: a.why_now || null,
        expected_impact_low: a.expected_impact?.low || 0,
        expected_impact_high: a.expected_impact?.high || 0,
        impact_metric: a.expected_impact?.metric || null,
        risk_level: a.risk_level || 'medium',
        requires_approval: a.requires_approval !== false,
      }).catch(() => {});
    }

    await sbPost('events', {
      business_id: businessId,
      kind: 'wf3.optimization.completed',
      workflow: '3_ad_optimization',
      payload: {
        run_id: runRow.id,
        actions_count: (decision.actions || []).length,
        blended_roas: snapshot.blendedRoas,
        blended_cac: snapshot.blendedCac,
      },
      severity: 'info',
    }).catch(() => {});

    return { runId: runRow.id, decision, snapshot };
  }

  async function applyAction({ businessId, actionId }) {
    const rows = await sbGet('ad_optimization_actions', `id=eq.${actionId}&business_id=eq.${businessId}&select=*`);
    const a = rows[0];
    if (!a) throw new Error('Action not found');

    // Dispatch based on action_kind — this is a thin placeholder that records
    // the intent. Real platform API calls are triggered via the existing
    // /webhook/meta-campaign-optimize / google-campaign-optimize routes.
    await sbPatch('ad_optimization_actions', `id=eq.${actionId}`, {
      status: 'applied',
      applied_at: new Date().toISOString(),
      result: { note: 'queued for platform dispatch' },
    });
    await sbPost('events', {
      business_id: businessId,
      kind: 'wf3.action.applied',
      workflow: '3_ad_optimization',
      payload: { action_id: actionId, kind: a.action_kind, platform: a.entity_platform },
      severity: 'info',
    }).catch(() => {});
    return { ok: true };
  }

  async function getLatestRun(businessId) {
    const rows = await sbGet('ad_optimization_runs', `business_id=eq.${businessId}&order=week_start.desc&limit=1&select=*`).catch(() => []);
    if (!rows[0]) return null;
    const actions = await sbGet('ad_optimization_actions', `run_id=eq.${rows[0].id}&order=created_at.asc&select=*`).catch(() => []);
    return { run: rows[0], actions };
  }

  return { runOptimization, applyAction, getLatestRun, buildSnapshot, resolveBrandContext };
}

module.exports = createWf3;
