'use strict';

/**
 * services/pacing-alerts/engine.js
 * ----------------------------------------------------------------------------
 * Pacing Alert orchestrator — runs every 4 hours via cron.
 *
 * For each active campaign:
 *   1. Pull current metrics + last 6h aggregate + previous 24h aggregate
 *   2. Run pacing-alerts/evaluatePacing
 *   3. If any alert fires, write to pacing_alerts table + emit event
 *
 * Idempotent: same alert within 12h window is deduped on (campaign_id, rule_id).
 * ----------------------------------------------------------------------------
 */

const pacing = require('../prompts/pacing-alerts');
const adI18n = require('../prompts/ad-optimizer/i18n-market');

function createEngine(deps) {
  const { sbGet, sbPost, sbPatch, logger, Sentry } = deps;
  if (!sbGet || !sbPost || !sbPatch) throw new Error('pacing-alerts engine: sbGet/sbPost/sbPatch required');

  /**
   * Aggregate ad_performance_logs over a recent window.
   */
  async function _aggregateWindow(campaignId, hours) {
    const since = new Date(Date.now() - hours * 36e5).toISOString();
    const rows = await sbGet(
      'ad_performance_logs',
      `campaign_id=eq.${campaignId}&logged_at=gte.${since}&select=spend,clicks,conversions,roas,frequency,cpa`
    ).catch(() => []);
    if (!rows.length) return null;
    const sum = rows.reduce(
      (acc, r) => ({
        spend: acc.spend + Number(r.spend || 0),
        clicks: acc.clicks + Number(r.clicks || 0),
        conversions: acc.conversions + Number(r.conversions || 0),
      }),
      { spend: 0, clicks: 0, conversions: 0 }
    );
    const avg = (k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0) / rows.length;
    return {
      ...sum,
      roas: avg('roas'),
      frequency: avg('frequency'),
      cpa: avg('cpa'),
      sample_size: rows.length,
    };
  }

  async function evaluateOne({ campaignId, businessId, dryRun = false }) {
    const tx = Sentry?.startTransaction?.({ name: 'pacing-alerts.evaluateOne' });
    try {
      const [campaignRows, businessRows, recent6h, prev24h] = await Promise.all([
        sbGet('ad_campaigns', `id=eq.${campaignId}&select=*`).catch(() => []),
        sbGet('businesses',   `id=eq.${businessId}&select=*`).catch(() => []),
        _aggregateWindow(campaignId, 6),
        _aggregateWindow(campaignId, 24),
      ]);
      const campaign = campaignRows[0];
      const business = businessRows[0];
      if (!campaign || !business) return { alerts: [], reason: 'missing_data' };

      const now = new Date();
      const startOfDay = new Date(now);
      startOfDay.setUTCHours(0, 0, 0, 0);
      const hoursElapsed = (now - startOfDay) / 36e5;

      // Find first click time for "zero clicks for X hours" rule
      const firstClickRow = await sbGet(
        'ad_performance_logs',
        `campaign_id=eq.${campaignId}&clicks=gt.0&order=logged_at.asc&limit=1&select=logged_at`
      ).catch(() => []);
      const hoursSinceFirstClick = firstClickRow[0]
        ? (Date.now() - new Date(firstClickRow[0].logged_at).getTime()) / 36e5
        : 99999;

      const metrics = {
        spend: Number(campaign.spend || 0),
        daily_budget: Number(campaign.daily_budget || 0),
        roas: Number(campaign.roas || 0),
        ctr: Number(campaign.ctr || 0),
        cpa: Number(campaign.cpa || 0),
        frequency: Number(campaign.frequency || 0),
        target_cpa: Number(campaign.target_cpa || 0),
        clicks: Number(campaign.clicks || 0),
        conversions: Number(campaign.conversions || 0),
        status: campaign.status,
        ad_status: campaign.ad_status,
      };

      const alerts = pacing.evaluatePacing({
        metrics,
        recent_window: recent6h,
        prev_24h: prev24h,
        hours_elapsed: hoursElapsed,
        hours_since_first_click: hoursSinceFirstClick,
      });

      if (!alerts.length) return { alerts: [], reason: 'no_pacing_issues' };

      const marketProfile = adI18n.buildMarketProfile(business);
      const humanized = alerts.map(a => pacing.humanizeAlert({ alert: a, business, marketProfile }));

      if (!dryRun) {
        // Dedupe: skip alerts already raised in last 12h on (campaign_id, rule_id)
        const since = new Date(Date.now() - 12 * 36e5).toISOString();
        const recentRows = await sbGet(
          'pacing_alerts',
          `campaign_id=eq.${campaignId}&fired_at=gte.${since}&select=rule_id`
        ).catch(() => []);
        const recentRuleIds = new Set(recentRows.map(r => r.rule_id));

        const fresh = humanized.filter(a => !recentRuleIds.has(a.rule_id));
        for (const a of fresh) {
          await sbPost('pacing_alerts', {
            business_id: businessId,
            campaign_id: campaignId,
            rule_id: a.rule_id,
            severity: a.severity,
            title: a.title,
            message: a.message,
            evidence: a.evidence,
            primary_language: a.primary_language,
            currency: a.currency,
            country: a.country,
          }).catch((e) => logger?.warn?.('pacing-alerts', businessId, 'persist failed', e));

          await sbPost('events', {
            business_id: businessId,
            kind: 'pacing.alert',
            workflow: '24_smart_budget_optimizer',
            payload: { campaign_id: campaignId, rule_id: a.rule_id, severity: a.severity, message: a.message },
            severity: a.severity === 'critical' ? 'error' : 'warning',
          }).catch(() => {});
        }
      }

      return { alerts: humanized };
    } catch (e) {
      Sentry?.captureException?.(e);
      throw e;
    } finally {
      tx?.finish?.();
    }
  }

  async function evaluateAll({ dryRun = false, limit = 500 } = {}) {
    const campaigns = await sbGet(
      'ad_campaigns',
      `status=eq.ACTIVE&limit=${limit}&select=id,business_id`
    ).catch(() => []);

    const results = { total: campaigns.length, evaluated: 0, alerts_fired: 0, errors: 0 };
    for (const c of campaigns) {
      try {
        const r = await evaluateOne({ campaignId: c.id, businessId: c.business_id, dryRun });
        results.evaluated++;
        results.alerts_fired += (r.alerts || []).length;
      } catch (e) {
        results.errors++;
        logger?.warn?.('pacing-alerts.evaluateAll', c.business_id, `campaign ${c.id} failed`, e?.message);
      }
    }
    return results;
  }

  return { evaluateOne, evaluateAll };
}

module.exports = createEngine;
