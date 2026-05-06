'use strict';

/**
 * services/forecasting/engine.js
 * ----------------------------------------------------------------------------
 * Forecasting orchestrator. Pulls last 60 days of ad_performance_logs, optional
 * channel breakdown, optional orders, runs forecastForBusiness, persists.
 * ----------------------------------------------------------------------------
 */

const forecasting = require('../prompts/forecasting');

function createEngine(deps) {
  const { sbGet, sbPost, sbPatch, callClaude, extractJSON, logger, Sentry } = deps;
  if (!sbGet || !sbPost || !sbPatch) throw new Error('forecasting engine: sbGet/sbPost/sbPatch required');
  if (!callClaude || !extractJSON)     throw new Error('forecasting engine: callClaude + extractJSON required');

  async function forecast({ businessId, horizonDays }) {
    const tx = Sentry?.startTransaction?.({ name: 'forecasting.forecast' });
    try {
      const since60 = new Date(Date.now() - 60 * 86400000).toISOString();
      const [bizRows, profileRows, history, orders] = await Promise.all([
        sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
        sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
        sbGet('ad_performance_logs',
          `business_id=eq.${businessId}&logged_at=gte.${since60}&order=logged_at.asc&select=*`
        ).catch(() => []),
        // Orders table optional — may not exist on all setups
        sbGet('orders', `business_id=eq.${businessId}&select=customer_id,amount,ordered_at&order=ordered_at.desc&limit=500`).catch(() => []),
      ]);
      const business = { ...(bizRows[0] || {}), ...(profileRows[0] || {}) };
      if (!business?.id && !business?.user_id) throw new Error(`business ${businessId} not found`);

      // Per-channel breakdown (Maroa runs Meta primarily, but architecture is multi-channel ready)
      const channelHistory = {};
      const metaRows = history.filter(r => !r.platform || r.platform === 'meta' || r.platform === 'facebook');
      const googleRows = history.filter(r => r.platform === 'google');
      if (metaRows.length) channelHistory.meta = metaRows;
      if (googleRows.length) channelHistory.google = googleRows;

      const result = await forecasting.forecastForBusiness({
        business,
        history,
        channelHistory: Object.keys(channelHistory).length > 1 ? channelHistory : null,
        orders: Array.isArray(orders) ? orders : null,
        plan: business.plan || 'free',
        horizonDays,
        callClaude,
        extractJSON,
        logger,
      });

      // Persist
      await sbPost('forecasts', {
        business_id: businessId,
        horizon_days: result.horizon_days,
        roas_forecast: result.roas_forecast,
        spend_forecast: result.spend_forecast,
        revenue_forecast: result.revenue_forecast,
        ltv_forecast: result.ltv_forecast,
        budget_allocation_recommendation: result.budget_allocation_recommendation,
        narrative: result.narrative,
        caveats: result.caveats,
        data_quality: result.data_quality,
        sample_size_days: result.sample_size_days,
        currency: result.currency,
        primary_language: result.primary_language,
        country: result.country,
        short_circuited: !!result.short_circuited,
        short_circuit_reason: result.short_circuit_reason || null,
        plan_used: business.plan || 'free',
      }).catch((e) => logger?.warn?.('forecasting', businessId, 'persist failed', e));

      return result;
    } catch (e) {
      Sentry?.captureException?.(e);
      throw e;
    } finally {
      tx?.finish?.();
    }
  }

  return { forecast };
}

module.exports = createEngine;
