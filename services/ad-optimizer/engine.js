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
    sbGet,
    sbPost,
    sbPatch,
    sbRpc, // optional — migration-071 atomic ad_optimizer_decision; legacy fallback handled inline
    callClaude,
    extractJSON,
    logger,
    Sentry,
    decisionLog,
    // Marketing Graph (migration 065) — every executed audit decision is
    // mirrored as a typed entity + edge so the moat compounds. Optional;
    // soft-fails when the lib isn't wired or the migration isn't applied.
    marketingGraph,
  } = deps;

  if (!sbGet || !sbPost || !sbPatch) throw new Error('WF2 engine: sbGet/sbPost/sbPatch required');
  if (!callClaude || !extractJSON) throw new Error('WF2 engine: callClaude + extractJSON required');

  // ── Mirror every audit decision into decision_logs ──────────────────────
  // Wires this agent into the universal decision log so the War Room UI can
  // surface ad-optimizer activity alongside content + cro + voc etc.
  // Soft-fail by design: if decisionLog isn't wired (e.g. unit tests, or
  // pre-migration deploys), the mirror is a no-op.
  async function _mirrorToDecisionLog({ businessId, campaign, audit, action_taken, dryRun }) {
    if (!decisionLog) return;
    try {
      // Severity bands match decisionLog's auto-safe ladder:
      //  - 'pause' → red (interrupts spend; needs human eyes)
      //  - 'scale'/'optimize' → yellow (changes budget; notify)
      //  - 'keep'/'refresh_creative' → green (informational)
      const decision = String(audit.decision || 'keep').toLowerCase();
      const auto_safe_band =
        decision === 'pause' ? 'red'
        : decision === 'scale' || decision === 'optimize' ? 'yellow'
        : 'green';

      await decisionLog.proposeDecision({
        agentName: 'ad-optimizer',
        businessId,
        decisionType: 'campaign_audit',
        decisionSubtype: decision,
        recommendationText: audit.decision_reason || `Ad optimizer chose: ${decision}`,
        confidence: typeof audit.audit_score === 'number' ? audit.audit_score / 100 : null,
        manipulationRisk: 0, // ad audits don't manipulate; safe by construction
        autoSafeBand: auto_safe_band,
        executed: !dryRun && action_taken !== 'noop' && action_taken !== 'kept',
        refused: false,
        targetEntity: { type: 'campaign', id: campaign?.id || null, name: campaign?.name || null },
        budgetImpactUsd: typeof audit.new_daily_budget === 'number' && typeof campaign?.daily_budget === 'number'
          ? Number((audit.new_daily_budget - campaign.daily_budget).toFixed(2))
          : 0,
        metadata: {
          market_tier: audit.market_tier || null,
          budget_tier: audit.budget_tier || null,
          short_circuited: !!audit.short_circuited,
          gates: audit.gates || null,
          action_taken,
        },
      });
    } catch (e) {
      // Mirror failure must NEVER interrupt the audit pipeline.
      logger?.warn?.('wf2.engine', businessId, 'decisionLog mirror failed', { error: e.message });
    }
  }

  // ── Mirror every executed audit decision into the Marketing Graph ──────
  // Migration 065 / ADR-0010. Two writes per decision:
  //   1. Upsert the campaign as a `campaign` entity (idempotent via externalId)
  //   2. Upsert the decision as a `decision` entity + edge to the campaign
  // Reads later use these to drive grounding ("we paused 3 ads with this
  // angle for cafés in this region — try a different angle instead").
  //
  // Soft-fail by design — failed graph writes never block the audit.
  async function _mirrorToMarketingGraph({ businessId, campaign, audit, action_taken }) {
    if (!marketingGraph || typeof marketingGraph.upsertEntity !== 'function') return;
    try {
      const campaignEntity = await marketingGraph.upsertEntity({
        businessId,
        type: 'campaign',
        subtype: campaign?.network || campaign?.platform || 'meta',
        title: campaign?.name || `Campaign ${campaign?.id}`,
        externalId: campaign?.id ? `campaign:${campaign.id}` : null,
        source: 'agent:ad-optimizer',
        attrs: {
          status: campaign?.status,
          daily_budget: campaign?.daily_budget,
          last_decision: audit.decision,
        },
      });
      const decisionEntity = await marketingGraph.upsertEntity({
        businessId,
        type: 'decision',
        subtype: 'ad_audit',
        title:
          (audit.decision_reason || `Ad optimizer: ${audit.decision}`).slice(0, 200),
        source: 'agent:ad-optimizer',
        attrs: {
          decision: audit.decision,
          action_taken,
          score: audit.audit_score,
          market_tier: audit.market_tier,
          budget_tier: audit.budget_tier,
        },
      });
      if (campaignEntity?.id && decisionEntity?.id) {
        await marketingGraph.linkEntities({
          businessId,
          sourceId: decisionEntity.id,
          targetId: campaignEntity.id,
          type: 'acted_on',
          weight:
            audit.decision === 'pause'
              ? -1.0
              : audit.decision === 'scale'
                ? 1.0
                : 0.5,
          attrs: { audited_at: new Date().toISOString() },
        });
      }
    } catch (e) {
      // marketingGraph already logs internally; never throw to caller.
      logger?.warn?.('wf2.engine', businessId, 'marketingGraph mirror failed', {
        error: e.message,
      });
    }
  }

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
        sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
        sbGet('ad_performance_logs', `campaign_id=eq.${campaignId}&order=logged_at.desc&limit=14&select=*`).catch(
          () => []
        ),
        sbGet(
          'ad_audit_results',
          `campaign_id=eq.${campaignId}&order=audited_at.desc&limit=7&select=decision,decided_at:audited_at,created_at:audited_at`
        ).catch(() => []),
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
        // Compute the campaign patch first so we can hand it to the
        // atomic RPC (or fall back to the two-call legacy path).
        const patch = {
          last_decision: audit.decision,
          last_decision_reason: audit.decision_reason,
          last_optimized_at: new Date().toISOString(),
        };
        let patchStatus = null;
        let patchBudget = null;

        if (audit.decision === 'scale' && audit.new_daily_budget != null) {
          patchBudget = audit.new_daily_budget;
          action_taken = 'budget_increased';
        } else if (audit.decision === 'optimize' && audit.new_daily_budget != null) {
          patchBudget = audit.new_daily_budget;
          action_taken = 'budget_adjusted';
        } else if (audit.decision === 'pause') {
          patchStatus = 'PAUSED';
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
        if (patchBudget != null) patch.daily_budget = patchBudget;
        if (patchStatus != null) patch.status = patchStatus;

        // Atomic write via migration-071 RPC if available — avoids leaving
        // an audit row with no matching campaign patch (or vice versa) on
        // partial failure. Falls back to the legacy two-call path on
        // RPC_NOT_FOUND or any RPC failure. Audit 2026-05-18 H4.
        let usedRpc = false;
        if (typeof sbRpc === 'function') {
          try {
            await sbRpc('ad_optimizer_decision', {
              p_business_id: businessId,
              p_campaign_id: String(campaign?.meta_campaign_id || campaignId),
              p_decision: audit.decision,
              p_reason: audit.decision_reason || null,
              p_score: typeof audit.score === 'number' ? audit.score : 0,
              p_score_breakdown: audit.score_breakdown || {},
              p_patch_status: patchStatus,
              p_patch_budget: patchBudget,
            });
            usedRpc = true;
          } catch (e) {
            logger?.warn?.('wf2.engine', businessId, 'rpc fallback', { error: e.message });
          }
        }
        if (!usedRpc) {
          await sbPost('ad_audit_results', auditRow).catch((e) => {
            logger?.warn?.('wf2.engine', businessId, 'audit_results insert failed', e);
          });
          await sbPatch('ad_campaigns', `id=eq.${campaignId}`, patch).catch((e) => {
            logger?.warn?.('wf2.engine', businessId, 'campaign patch failed', e);
          });
        }
      }

      // Mirror to universal decision_logs (fail-safe; never throws)
      await _mirrorToDecisionLog({ businessId, campaign, audit, action_taken, dryRun });

      Sentry?.addBreadcrumb?.({
        category: 'wf2',
        message: 'auditOne done',
        data: { decision: audit.decision, action_taken },
      });
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
