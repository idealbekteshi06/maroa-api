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
 *   6. Apply decision: scale|pause|resume|optimize|budget_update|keep|refresh_creative
 *      - scale/optimize/budget_update → PATCH ad_campaigns + insert audit row,
 *        then _executeOnMeta() pushes the new daily_budget to Meta
 *      - pause/resume   → PATCH ad_campaigns.status, then _executeOnMeta()
 *        sets the campaign status on Meta (PAUSED/ACTIVE)
 *      - keep           → log only
 *      - refresh_creative → fire event for WF26
 *
 *   Step 0 (PART 3): before deciding, pull FRESH last_7d insights from Meta
 *   and overlay them onto the newest stored log. Step 6 actuator and the
 *   live Meta writes are dry-run gated by META_AD_LAUNCH_LIVE.
 * ----------------------------------------------------------------------------
 */

const adOptimizer = require('../prompts/ad-optimizer');
const { loadBusiness, checkPlatform } = require('../../lib/integrationGate');

function metricsFromLogAndCampaign(latest, campaign = {}) {
  return {
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
    daily_budget: Number(campaign.daily_budget || latest.daily_budget || 0),
    status: campaign.status,
    ad_status: campaign.ad_status,
    creative_count: campaign.creative_count,
    creative_age_days: campaign.creative_age_days,
    days_active: campaign.days_active,
    learning_phase_state: campaign.learning_phase_state || latest.learning_phase_state,
    capi_configured: campaign.capi_configured,
    event_match_quality: campaign.event_match_quality,
    attribution_window: campaign.attribution_window,
    target_cpa: campaign.target_cpa,
    conversions_since_edit: campaign.conversions_since_edit,
    days_since_edit: campaign.days_since_edit,
  };
}

async function fetchPlatformAuditContext(businessId, platform, sbGet) {
  const camps = await sbGet(
    'ad_campaigns',
    `business_id=eq.${businessId}&platform=eq.${platform}&select=*&order=last_optimized_at.desc.nullsfirst&limit=20`
  ).catch(() => []);
  if (!camps.length) return null;

  let best = null;
  for (const camp of camps) {
    const logs = await sbGet(
      'ad_performance_logs',
      `campaign_id=eq.${camp.id}&order=logged_at.desc&limit=14&select=*`
    ).catch(() => []);
    if (!logs.length) continue;
    const spend = Number(logs[0]?.spend || 0);
    if (!best || spend > best.spend) {
      best = {
        metrics: metricsFromLogAndCampaign(logs[0], camp),
        history: [...logs].reverse(),
        spend,
      };
    }
  }
  if (!best) return null;
  return { metrics: best.metrics, history: best.history };
}

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
        decision === 'pause' ? 'red' : decision === 'scale' || decision === 'optimize' ? 'yellow' : 'green';

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
        budgetImpactUsd:
          typeof audit.new_daily_budget === 'number' && typeof campaign?.daily_budget === 'number'
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
        title: (audit.decision_reason || `Ad optimizer: ${audit.decision}`).slice(0, 200),
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
          weight: audit.decision === 'pause' ? -1.0 : audit.decision === 'scale' ? 1.0 : 0.5,
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

  // Resolve the Meta client once. Tests inject deps.metaMarketingClient;
  // production lazy-requires the real module (mirrors launcher.js).
  function _getMetaClient() {
    if (deps.metaMarketingClient) return deps.metaMarketingClient;
    try {
      return require('../meta-marketing');
    } catch {
      return null;
    }
  }

  // ── PART 4: Actuator — actually execute the decision on Meta ───────────
  // The engine historically only patched the DB ("Meta API call deferred to
  // actuator"). This closes that gap. Safety:
  //   - updateCampaign() is itself dry-run gated by META_AD_LAUNCH_LIVE, so
  //     when the flag is off we record intent and never touch Meta.
  //   - any failure is saved to the errors table and swallowed (never throws).
  //   - executed_at is stamped ONLY on a real (non-dry-run) success.
  async function _executeOnMeta({ businessId, campaignId, campaign, business, audit, patchBudget, patchStatus }) {
    const decision = String(audit.decision || '').toLowerCase();
    const EXECUTABLE = new Set(['scale', 'optimize', 'budget_update', 'pause', 'resume']);
    if (!EXECUTABLE.has(decision)) return;

    let fields = null;
    if (patchStatus === 'PAUSED') fields = { status: 'PAUSED' };
    else if (patchStatus === 'ACTIVE') fields = { status: 'ACTIVE' };
    else if (patchBudget != null) fields = { daily_budget: Math.round(Number(patchBudget) * 100) }; // dollars → cents
    if (!fields) return;

    const metaCampaignId = campaign?.meta_campaign_id;
    const metaClient = _getMetaClient();

    if (!metaClient?.updateCampaign || !metaCampaignId) {
      await sbPatch('ad_campaigns', `id=eq.${campaignId}`, {
        execution_response: {
          ok: false,
          decision,
          fields,
          reason: metaCampaignId ? 'meta client unavailable' : 'no meta_campaign_id',
        },
      }).catch(() => {});
      return;
    }

    try {
      const r = await metaClient.updateCampaign({ business, campaignId: metaCampaignId, fields });
      if (!r.ok) throw new Error(r.reason || 'meta updateCampaign failed');
      if (r.dry_run) {
        logger?.info?.('ad-optimizer.actuator', businessId, 'dry-run intended action', {
          campaign: metaCampaignId,
          decision,
          fields,
        });
        await sbPatch('ad_campaigns', `id=eq.${campaignId}`, {
          execution_response: { ok: true, dry_run: true, decision, fields },
        }).catch(() => {});
        return;
      }
      await sbPatch('ad_campaigns', `id=eq.${campaignId}`, {
        executed_at: new Date().toISOString(),
        execution_response: { ok: true, decision, fields, meta: r.raw || null },
      }).catch(() => {});
    } catch (e) {
      await sbPost('errors', {
        business_id: businessId,
        workflow_name: 'ad-optimizer-actuator',
        error_message: e.message,
        retry_payload: JSON.stringify({ campaign_id: metaCampaignId, decision, fields }),
      }).catch(() => {});
      await sbPatch('ad_campaigns', `id=eq.${campaignId}`, {
        execution_response: { ok: false, decision, fields, error: e.message },
      }).catch(() => {});
      logger?.warn?.('ad-optimizer.actuator', businessId, 'meta execution failed', { error: e.message });
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

      // ─── PART 3: pull FRESH insights from Meta before deciding ─────────
      // Read-only (not gated by META_AD_LAUNCH_LIVE). Overlays the live
      // last_7d numbers onto the newest stored log so scale/pause decisions
      // act on today's reality, not yesterday's snapshot. Soft-falls back to
      // ad_performance_logs when Meta is unreachable or unlinked.
      const m = { ...latest };
      try {
        const metaClient = _getMetaClient();
        if (
          metaClient?.fetchCampaignInsights &&
          campaign?.meta_campaign_id &&
          business?.meta_access_token &&
          business?.ad_account_id
        ) {
          const ci = await metaClient.fetchCampaignInsights({
            business,
            campaignId: campaign.meta_campaign_id,
            withBreakdowns: false,
          });
          const live = ci?.windows?.last_7d;
          if (live && !live.error) {
            for (const k of ['spend', 'clicks', 'impressions', 'ctr', 'cpm', 'frequency', 'reach', 'conversions', 'roas', 'cpa']) {
              if (live[k] != null) m[k] = live[k];
            }
          }
        }
      } catch (e) {
        logger?.warn?.('wf2.engine', businessId, 'live insight fetch failed', { error: e.message });
      }

      // ─── Build metrics for audit ───────────────────────────────────────
      const metrics = {
        spend: Number(m.spend || 0),
        clicks: Number(m.clicks || 0),
        impressions: Number(m.impressions || 0),
        ctr: Number(m.ctr || 0),
        roas: Number(m.roas || 0),
        cpc: Number(m.cpc || 0),
        cpm: Number(m.cpm || 0),
        cpa: Number(m.cpa || 0),
        frequency: Number(m.frequency || 0),
        reach: Number(m.reach || 0),
        conversions: Number(m.conversions || 0),
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

      // ─── Multi-platform audit when Meta + Google are both connected ───
      const bizIntegrations = await loadBusiness(businessId, sbGet);
      const hasMeta = checkPlatform(bizIntegrations, 'meta_ads');
      const hasGoogle = checkPlatform(bizIntegrations, 'google_ads');
      let metricsByPlatform;
      let historyByPlatform;
      const campaignPlatform = String(campaign.platform || 'meta').toLowerCase();

      if (hasMeta && hasGoogle) {
        metricsByPlatform = {};
        historyByPlatform = {};
        if (campaignPlatform === 'meta') {
          metricsByPlatform.meta = metrics;
          historyByPlatform.meta = orderedHistory;
        } else {
          const metaCtx = await fetchPlatformAuditContext(businessId, 'meta', sbGet);
          if (metaCtx) {
            metricsByPlatform.meta = metaCtx.metrics;
            historyByPlatform.meta = metaCtx.history;
          }
        }
        if (campaignPlatform === 'google') {
          metricsByPlatform.google = metrics;
          historyByPlatform.google = orderedHistory;
        } else {
          const googleCtx = await fetchPlatformAuditContext(businessId, 'google', sbGet);
          if (googleCtx) {
            metricsByPlatform.google = googleCtx.metrics;
            historyByPlatform.google = googleCtx.history;
          }
        }
        if (Object.keys(metricsByPlatform).length < 2) {
          metricsByPlatform = undefined;
          historyByPlatform = undefined;
        }
      }

      // ─── Run the audit ─────────────────────────────────────────────────
      const audit = await adOptimizer.auditCampaign({
        business,
        metrics,
        metricsByPlatform,
        historyByPlatform,
        history: orderedHistory,
        decisionHistory,
        plan: business.plan || 'free',
        platform: metricsByPlatform ? 'multi' : campaignPlatform,
        callClaude,
        extractJSON,
        logger,
        sbGet,
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
        } else if (audit.decision === 'resume') {
          patchStatus = 'ACTIVE';
          action_taken = 'resumed';
        } else if (audit.decision === 'budget_update' && audit.new_daily_budget != null) {
          patchBudget = audit.new_daily_budget;
          action_taken = 'budget_updated';
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

        // ── PART 4: now actually execute the decision on Meta ──────────────
        await _executeOnMeta({ businessId, campaignId, campaign, business, audit, patchBudget, patchStatus });
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

    const results = {
      total: campaigns.length,
      audited: 0,
      errors: 0,
      skipped_no_meta: 0,
      decisions: {},
    };
    const bizCache = new Map();
    for (const c of campaigns) {
      try {
        let biz = bizCache.get(c.business_id);
        if (!biz) {
          biz = await loadBusiness(c.business_id, sbGet);
          bizCache.set(c.business_id, biz);
        }
        if (!checkPlatform(biz, 'meta_ads')) {
          results.skipped_no_meta++;
          continue;
        }
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
