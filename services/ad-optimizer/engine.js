'use strict';

/**
 * services/wf2/engine.js
 * ----------------------------------------------------------------------------
 * Orchestrator for the daily ad-optimizer (WF02).
 *
 * For each active campaign:
 *   1. Pull current metrics from ad_campaigns + latest ad_performance_logs row
 *   2. Pull last 14 days of ad_performance_logs (trend analysis)
 *   3. Pull last 7 decisions for the campaign (anti-thrashing)
 *   4. Pull business profile (location, language, plan, tier)
 *   5. Run auditCampaign() (deterministic checks → LLM synthesis)
 *   6. Apply decision: scale|pause|keep|optimize|refresh_creative
 *      - scale/optimize → PATCH ad_campaigns + insert ad_audit_results row
 *      - pause          → PATCH ad_campaigns.status='PAUSED' (Meta API call deferred to actuator)
 *      - keep           → log only
 *      - refresh_creative → fire event for WF26
 * ----------------------------------------------------------------------------
 */

const adOptimizer = require('../prompts/ad-optimizer');

function createEngine(deps) {
  const {
    sbGet, sbPost, sbPatch,
    callClaude, extractJSON,
    logger,
    Sentry,
  } = deps;

  if (!sbGet || !sbPost || !sbPatch) throw new Error('WF2 engine: sbGet/sbPost/sbPatch required');
  if (!callClaude || !extractJSON) throw new Error('WF2 engine: callClaude + extractJSON required');

  /**
   * Audit a single campaign end-to-end.
   * Returns the audit result + the action that was taken.
   */
  async function auditOne({ campaignId, businessId, dryRun = false }) {
    const tx = Sentry?.startTransaction?.({ name: 'wf2.auditOne', op: 'wf2' });
    Sentry?.addBreadcrumb?.({ category: 'wf2', message: 'auditOne start', data: { campaignId, businessId, dryRun } });
    try {
      // ─── Pull data (parallel) ──────────────────────────────────────────
      const [campaignRows, businessRows, history, decisionHistory] = await Promise.all([
        sbGet('ad_campaigns', `id=eq.${campaignId}&select=*`).catch(() => []),
        sbGet('businesses',   `id=eq.${businessId}&select=*`).catch(() => []),
        sbGet('ad_performance_logs',
          `campaign_id=eq.${campaignId}&order=logged_at.desc&limit=14&select=*`).catch(() => []),
        sbGet('ad_audit_results',
          `campaign_id=eq.${campaignId}&order=audited_at.desc&limit=7&select=decision,decided_at:audited_at,created_at:audited_at`).catch(() => []),
      ]);

      const campaign = campaignRows[0];
      const business = businessRows[0];
      if (!campaign) throw new Error(`campaign ${campaignId} not found`);
      if (!business) throw new Error(`business ${businessId} not found`);

      // History oldest-first for trend
      const orderedHistory = [...history].reverse();
      const latest = orderedHistory[orderedHistory.length - 1] || {};

      // ─── Build metrics for audit ───────────────────────────────────────
      const metrics = {
        spend: Number(latest.spend || 0),
        clicks: Number(latest.clicks || 0),
        impressions: Number(latest.impressions || 0),
        ctr: Number(latest.ctr || 0),
        roas: Number(latest.roas || 0),
        cpc: Number(latest.cpc || 0),
        cpm: Number(latest.cpm || 0),
        cpa: Number(latest.cpa || 0),
        frequency: Number(latest.frequency || 0),
        reach: Number(latest.reach || 0),
        conversions: Number(latest.conversions || 0),
        daily_budget: Number(campaign.daily_budget || 0),
        status: campaign.status,
        ad_status: campaign.ad_status,
        creative_count: campaign.creative_count,
        creative_age_days: campaign.creative_age_days,
        days_active: campaign.days_active,
        learning_phase_state: campaign.learning_phase_state,
        capi_configured: campaign.capi_configured,
        event_match_quality: campaign.event_match_quality,
        attribution_window: campaign.attribution_window,
        target_cpa: campaign.target_cpa,
        conversions_since_edit: campaign.conversions_since_edit,
        days_since_edit: campaign.days_since_edit,
      };

      // ─── Run the audit ─────────────────────────────────────────────────
      const audit = await adOptimizer.auditCampaign({
        business,
        metrics,
        history: orderedHistory,
        decisionHistory,
        plan: business.plan || 'free',
        platform: 'meta',
        callClaude,
        extractJSON,
        logger,
      });

      // ─── Persist audit result ──────────────────────────────────────────
      const auditRow = {
        campaign_id: campaignId,
        business_id: businessId,
        decision: audit.decision,
        decision_reason: audit.decision_reason,
        new_daily_budget: audit.new_daily_budget,
        audit_score: audit.audit_score,
        score_breakdown: audit.score_breakdown,
        critical_issues: audit.critical_issues,
        warnings: audit.warnings,
        opportunities: audit.opportunities,
        trend: audit.trend,
        citations: audit.citations,
        market_tier: audit.market_tier,
        budget_tier: audit.budget_tier,
        short_circuited: !!audit.short_circuited,
        short_circuit_reason: audit.short_circuit_reason || null,
        plan_used: business.plan || 'free',
        slop_violations: (audit.slop_violations || []).length,
        gates: audit.gates,
      };

      let action_taken = 'noop';
      if (!dryRun) {
        await sbPost('ad_audit_results', auditRow).catch((e) => {
          logger?.warn?.('wf2.engine', businessId, 'audit_results insert failed', e);
        });

        // ─── Apply decision (gentle — don't break customer campaigns) ───
        const patch = {
          last_decision: audit.decision,
          last_decision_reason: audit.decision_reason,
          last_optimized_at: new Date().toISOString(),
        };

        if (audit.decision === 'scale' && audit.new_daily_budget != null) {
          patch.daily_budget = audit.new_daily_budget;
          action_taken = 'budget_increased';
        } else if (audit.decision === 'optimize' && audit.new_daily_budget != null) {
          patch.daily_budget = audit.new_daily_budget;
          action_taken = 'budget_adjusted';
        } else if (audit.decision === 'pause') {
          patch.status = 'PAUSED';
          action_taken = 'paused';
        } else if (audit.decision === 'refresh_creative') {
          action_taken = 'refresh_creative_event';
          await sbPost('events', {
            business_id: businessId,
            kind: 'wf26.refresh_required',
            workflow: '26_creative_refresh',
            payload: { campaign_id: campaignId, reason: audit.decision_reason },
            severity: 'info',
          }).catch(() => {});
        } else {
          action_taken = 'kept';
        }

        await sbPatch('ad_campaigns', `id=eq.${campaignId}`, patch).catch((e) => {
          logger?.warn?.('wf2.engine', businessId, 'campaign patch failed', e);
        });
      }

      Sentry?.addBreadcrumb?.({ category: 'wf2', message: 'auditOne done', data: { decision: audit.decision, action_taken } });
      return { audit, action_taken, campaign, business };
    } catch (e) {
      Sentry?.captureException?.(e);
      throw e;
    } finally {
      tx?.finish?.();
    }
  }

  /**
   * Audit every active campaign (cron target — runs daily 8am).
   */
  async function auditAllActive({ dryRun = false, limit = 500 } = {}) {
    const campaigns = await sbGet(
      'ad_campaigns',
      `status=eq.ACTIVE&order=last_optimized_at.asc.nullsfirst&limit=${limit}&select=id,business_id`
    ).catch(() => []);

    const results = { total: campaigns.length, audited: 0, errors: 0, decisions: {} };
    for (const c of campaigns) {
      try {
        const r = await auditOne({ campaignId: c.id, businessId: c.business_id, dryRun });
        results.audited++;
        results.decisions[r.audit.decision] = (results.decisions[r.audit.decision] || 0) + 1;
      } catch (e) {
        results.errors++;
        logger?.warn?.('wf2.auditAllActive', c.business_id, `campaign ${c.id} failed`, e?.message);
      }
    }
    return results;
  }

  return { auditOne, auditAllActive };
}

module.exports = createEngine;
