'use strict';

/**
 * lib/decisionLog.js
 * ───────────────────────────────────────────────────────────────────────
 * Universal agent-decision audit trail. Generalizes Wave 60 S10's
 * agency_pipeline_runs to ALL agents (ad-optimizer, content-generator,
 * cro, voc, competitor-watch, agency-pipeline, lifecycle-marketer,
 * growth-engineer, etc.).
 *
 * Every agent that takes an action should write one row here BEFORE
 * executing. After execution + measurement, fill in outcome.
 *
 * This table powers the Autopilot Control Room UI (Phase 3 of the
 * strategy) — every "what Maroa noticed / what it recommends / what
 * happened / what the outcome was" panel reads from here.
 *
 * Public API:
 *
 *   const log = makeDecisionLogger({ sbGet, sbPost, sbPatch, logger, metrics });
 *
 *   const decision = await log.proposeDecision({
 *     businessId,
 *     agentName: 'ad-optimizer',
 *     decisionType: 'refresh_creative',
 *     inputs: { campaign_id, ctr_drop_pct: 31 },
 *     trigger: 'cron',
 *     recommendationText: 'CTR dropped 31% after 4 days. Refresh creative, not budget.',
 *     confidence: 0.84,
 *     expectedUpside: { text: '+15% CTR within 7 days', value: 0.15 },
 *     risk: 'Low — creative refresh, no budget change',
 *     costUsd: 0.30,        // expected LLM + image cost
 *     manipulationRisk: 2,  // Wave 60 ethics ceiling
 *     autoSafeBand: 'green',
 *     requiredApproval: false,
 *   });
 *   // → { id, ...row }
 *
 *   await log.recordExecution(decision.id, {
 *     executed: true,
 *     executionDetails: { new_creative_id: '...', resumed_campaign: true },
 *   });
 *
 *   await log.recordOutcome(decision.id, {
 *     outcome: { ctr_after_7d: 0.038, ctr_before: 0.022 },
 *     outcomeScore: 0.92,   // 0..1 against expectedUpside
 *   });
 *
 *   await log.pendingApprovals(businessId)  // for the inbox UI
 *   await log.recentDecisions(businessId, { agentName?, limit? })
 *
 * Auto-safe banding (matches the strategy doc):
 *   green  — auto-publish, no approval
 *   yellow — notify operator before publish (brand-sensitive)
 *   red    — never auto-publish (regulated / high-risk / above spend threshold)
 *
 * Tier-aware: free-tier writes still create a row (audit is universal)
 * but the Control Room UI is gated by plan.
 *
 * Fail-safe: every method swallows DB errors + returns a soft result.
 * Decisions should be made + acted on whether or not the log row writes.
 * Telemetry counts every soft failure.
 */

const AUTO_SAFE_BANDS = ['green', 'yellow', 'red'];

function makeDecisionLogger(deps = {}) {
  const { sbGet, sbPost, sbPatch, logger, metrics } = deps;

  if (typeof sbPost !== 'function') {
    throw new Error('decisionLog: sbPost is a required dep');
  }

  let _healthy = null;

  async function isHealthy() {
    if (_healthy !== null) return _healthy;
    try {
      if (typeof sbGet === 'function') {
        await sbGet('decision_logs', 'select=id&limit=1');
      }
      _healthy = true;
    } catch (e) {
      _healthy = false;
      if (logger?.warn) logger.warn('decisionLog', null, 'logger offline', { err: e.message });
    }
    return _healthy;
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

  function _encode(value) {
    return encodeURIComponent(value);
  }

  /**
   * Write the initial decision row. Returns the row (with `id`) so the
   * caller can pass `id` into recordExecution + recordOutcome later.
   *
   * Required: businessId, agentName, decisionType, recommendationText.
   * Everything else has reasonable defaults.
   */
  async function proposeDecision(spec = {}) {
    const {
      businessId,
      agentName,
      decisionType,
      decisionSubtype,
      inputs,
      trigger,
      recommendationText,
      confidence,
      expectedUpside,
      risk,
      costUsd,
      manipulationRisk,
      autoSafeBand,
      requiredApproval,
    } = spec;

    if (!businessId || !agentName || !decisionType || !recommendationText) {
      throw new Error('proposeDecision: businessId + agentName + decisionType + recommendationText required');
    }
    if (!(await isHealthy())) {
      _bump('decision_log_skips_total', { agent: agentName, reason: 'logger_offline' });
      return { id: null, _soft: true, reason: 'logger_offline' };
    }

    const band = AUTO_SAFE_BANDS.includes(autoSafeBand) ? autoSafeBand : 'green';
    const row = {
      business_id: businessId,
      agent_name: agentName,
      decision_type: decisionType,
      decision_subtype: decisionSubtype || null,
      inputs: inputs || {},
      trigger: trigger || null,
      recommendation_text: recommendationText,
      confidence: typeof confidence === 'number' ? Math.max(0, Math.min(1, confidence)) : 0.5,
      expected_upside_text: expectedUpside?.text || null,
      expected_upside_value: typeof expectedUpside?.value === 'number' ? expectedUpside.value : null,
      risk_text: risk || null,
      cost_usd: typeof costUsd === 'number' ? Number(costUsd.toFixed(2)) : 0,
      manipulation_risk: typeof manipulationRisk === 'number' ? manipulationRisk : null,
      auto_safe_band: band,
      required_approval: !!requiredApproval || band === 'red' || band === 'yellow',
    };
    try {
      const r = await sbPost('decision_logs', row, { returning: 'representation' });
      const inserted = Array.isArray(r) ? r[0] : r;
      _bump('decision_log_writes_total', { agent: agentName, decision_type: decisionType, band });
      return inserted || { id: null, _soft: true };
    } catch (e) {
      _bump('decision_log_write_errors_total', { agent: agentName });
      if (logger?.warn) logger.warn('decisionLog', null, 'write failed', { err: e.message });
      return { id: null, _soft: true, reason: e.message };
    }
  }

  async function recordExecution(id, { executed, executionDetails, refused, refusalReason } = {}) {
    if (!id) return null;
    if (typeof sbPatch !== 'function') return null;
    try {
      const updates = {};
      if (typeof executed === 'boolean') {
        updates.executed = executed;
        if (executed) updates.executed_at = new Date().toISOString();
      }
      if (executionDetails) updates.execution_details = executionDetails;
      if (typeof refused === 'boolean') updates.refused = refused;
      if (refusalReason) updates.refusal_reason = refusalReason;
      if (Object.keys(updates).length === 0) return null;

      const r = await sbPatch('decision_logs', `id=eq.${_encode(id)}`, updates, {
        returning: 'representation',
      });
      _bump('decision_log_execution_total', { outcome: refused ? 'refused' : executed ? 'executed' : 'unknown' });
      return Array.isArray(r) ? r[0] : r;
    } catch (e) {
      _bump('decision_log_write_errors_total', { phase: 'execution' });
      if (logger?.warn) logger.warn('decisionLog', null, 'execution write failed', { err: e.message });
      return null;
    }
  }

  /**
   * Fill in measured outcome after the closed-loop learning window
   * (typically 1–7 days after execution).
   *
   * outcomeScore: 0..1 — how well the measured outcome met the
   * expected_upside_value. The Autopilot UI surfaces this as
   * "Maroa was right 8 of 10 times in the last month."
   */
  async function recordOutcome(id, { outcome, outcomeScore } = {}) {
    if (!id) return null;
    if (typeof sbPatch !== 'function') return null;
    try {
      const updates = { outcome_measured_at: new Date().toISOString() };
      if (outcome) updates.outcome = outcome;
      if (typeof outcomeScore === 'number') {
        updates.outcome_score = Math.max(0, Math.min(1, outcomeScore));
      }
      const r = await sbPatch('decision_logs', `id=eq.${_encode(id)}`, updates, {
        returning: 'representation',
      });
      _bump('decision_log_outcome_recorded_total');
      return Array.isArray(r) ? r[0] : r;
    } catch (e) {
      _bump('decision_log_write_errors_total', { phase: 'outcome' });
      if (logger?.warn) logger.warn('decisionLog', null, 'outcome write failed', { err: e.message });
      return null;
    }
  }

  /**
   * Decisions awaiting human approval, oldest first. Drives the
   * Autopilot UI inbox.
   */
  async function pendingApprovals(businessId, { limit = 20 } = {}) {
    if (!businessId || typeof sbGet !== 'function') return [];
    if (!(await isHealthy())) return [];
    try {
      return await sbGet(
        'decision_logs',
        `business_id=eq.${_encode(businessId)}&required_approval=eq.true&approved_at=is.null` +
          `&order=created_at.asc&limit=${Math.max(1, Math.min(100, limit))}`
      );
    } catch (e) {
      _bump('decision_log_read_errors_total');
      return [];
    }
  }

  async function recentDecisions(businessId, { agentName, limit = 50 } = {}) {
    if (!businessId || typeof sbGet !== 'function') return [];
    if (!(await isHealthy())) return [];
    let filter =
      `business_id=eq.${_encode(businessId)}&order=created_at.desc` + `&limit=${Math.max(1, Math.min(200, limit))}`;
    if (agentName) filter += `&agent_name=eq.${_encode(agentName)}`;
    try {
      return await sbGet('decision_logs', filter);
    } catch (e) {
      _bump('decision_log_read_errors_total');
      return [];
    }
  }

  async function approve(id, userId) {
    if (!id || !userId || typeof sbPatch !== 'function') return null;
    try {
      const r = await sbPatch(
        'decision_logs',
        `id=eq.${_encode(id)}`,
        { approved_by: userId, approved_at: new Date().toISOString() },
        { returning: 'representation' }
      );
      _bump('decision_log_approvals_total');
      return Array.isArray(r) ? r[0] : r;
    } catch (e) {
      _bump('decision_log_write_errors_total', { phase: 'approval' });
      return null;
    }
  }

  /**
   * Operator-side rejection. Reuses the `refused` flag (originally for
   * compliance-bot refusals) so a single column tells the UI "this
   * decision will not execute". The actor is captured in `refusal_reason`
   * so audit history stays intact.
   */
  async function reject(id, userId, reason) {
    if (!id || !userId || typeof sbPatch !== 'function') return null;
    const trimmed = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
    const note = trimmed ? `rejected by user ${userId}: ${trimmed}` : `rejected by user ${userId}`;
    try {
      const r = await sbPatch(
        'decision_logs',
        `id=eq.${_encode(id)}`,
        {
          refused: true,
          refusal_reason: note,
          executed: false,
        },
        { returning: 'representation' }
      );
      _bump('decision_log_rejections_total');
      return Array.isArray(r) ? r[0] : r;
    } catch (e) {
      _bump('decision_log_write_errors_total', { phase: 'rejection' });
      return null;
    }
  }

  async function getById(id) {
    if (!id || typeof sbGet !== 'function') return null;
    try {
      const rows = await sbGet('decision_logs', `id=eq.${_encode(id)}&limit=1`);
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    } catch (e) {
      _bump('decision_log_read_errors_total');
      return null;
    }
  }

  return {
    isHealthy,
    proposeDecision,
    recordExecution,
    recordOutcome,
    pendingApprovals,
    recentDecisions,
    approve,
    reject,
    getById,
    AUTO_SAFE_BANDS,
  };
}

module.exports = { makeDecisionLogger, AUTO_SAFE_BANDS };
