'use strict';

/**
 * services/ad-optimizer/registerRoutes.js
 * ----------------------------------------------------------------------------
 * Mounts ad-optimizer (user-facing WF02) Express routes:
 *
 *   POST /webhook/ad-optimizer-daily-audit    cron target — audits all active campaigns
 *   POST /webhook/ad-optimizer-audit-campaign on-demand audit for a single campaign
 *
 * All routes use the existing `/webhook` auth middleware (x-webhook-secret).
 * ----------------------------------------------------------------------------
 */

function registerAdOptimizerRoutes({ app, apiError, engine, logger }) {
  // ─── POST /webhook/ad-optimizer-daily-audit (cron target, daily 8am) ───
  app.post('/webhook/ad-optimizer-daily-audit', async (req, res) => {
    const { dryRun, limit } = req.body || {};
    try {
      const result = await engine.auditAllActive({
        dryRun: !!dryRun,
        limit: Number(limit || 500),
      });
      res.json(result);
    } catch (e) {
      logger?.error?.('/webhook/ad-optimizer-daily-audit', null, 'cron failed', e);
      apiError(res, 500, 'AD_OPTIMIZER_CRON_FAILED', e.message);
    }
  });

  // ─── POST /webhook/ad-optimizer-audit-campaign (dashboard "Audit Now") ─
  app.post('/webhook/ad-optimizer-audit-campaign', async (req, res) => {
    const { campaignId, businessId, dryRun } = req.body || {};
    if (!campaignId || !businessId) {
      return apiError(res, 400, 'INVALID_REQUEST', 'campaignId + businessId required');
    }
    try {
      const result = await engine.auditOne({
        campaignId,
        businessId,
        dryRun: !!dryRun,
      });
      res.json({
        decision: result.audit.decision,
        decision_reason: result.audit.decision_reason,
        new_daily_budget: result.audit.new_daily_budget,
        audit_score: result.audit.audit_score,
        score_breakdown: result.audit.score_breakdown,
        critical_issues: result.audit.critical_issues,
        warnings: result.audit.warnings,
        opportunities: result.audit.opportunities,
        trend: result.audit.trend,
        citations: result.audit.citations,
        market_tier: result.audit.market_tier,
        budget_tier: result.audit.budget_tier,
        short_circuited: result.audit.short_circuited,
        short_circuit_reason: result.audit.short_circuit_reason,
        action_taken: result.action_taken,
      });
    } catch (e) {
      logger?.error?.('/webhook/ad-optimizer-audit-campaign', businessId, 'audit failed', e);
      apiError(res, 500, 'AD_OPTIMIZER_AUDIT_FAILED', e.message);
    }
  });
}

module.exports = { registerAdOptimizerRoutes };
