'use strict';

const i18n = require('./i18n-market');
const budget = require('./budget-calibration');
const checksMeta = require('./checks-meta');
const checksGoogle = require('./checks-google');
const trendMod = require('./trend-analysis');
const scoring = require('./scoring');
const mp = require('../frameworks/multi-platform-audit');

function runChecksForPlatform(platform, ctx) {
  const runner = platform === 'google' ? checksGoogle.runChecks : checksMeta.runChecks;
  return runner(ctx);
}

/**
 * Build audit inputs when metricsByPlatform is provided (meta + google in parallel).
 */
function buildMultiPlatformAuditInputs({
  business,
  metricsByPlatform = {},
  historyByPlatform = {},
  decisionHistory = [],
  plan,
  liveRates = {},
}) {
  const platforms = ['meta', 'google'].filter((p) => metricsByPlatform[p] && Object.keys(metricsByPlatform[p]).length);
  if (platforms.length === 0) {
    throw new Error('buildMultiPlatformAuditInputs: no platform metrics');
  }

  const marketProfile = i18n.buildMarketProfile(business, { liveRates });
  const spendWeights = mp.normalizeSpendWeights(metricsByPlatform, platforms);
  const bundles = [];

  for (const platform of platforms) {
    const metrics = metricsByPlatform[platform];
    const history = historyByPlatform[platform] || historyByPlatform || [];
    const dailyBudgetUsd =
      i18n.toUsd(metrics?.daily_budget, marketProfile.currency, liveRates) ?? metrics?.daily_budget ?? 0;
    const spendUsd = i18n.toUsd(metrics?.spend, marketProfile.currency, liveRates) ?? metrics?.spend ?? 0;

    const findings = runChecksForPlatform(platform, {
      metrics: {
        ...metrics,
        spend_usd: spendUsd,
        daily_budget_usd: dailyBudgetUsd,
        cpm_usd: i18n.toUsd(metrics?.cpm, marketProfile.currency, liveRates),
        cpc_usd: i18n.toUsd(metrics?.cpc, marketProfile.currency, liveRates),
      },
      history,
      market: marketProfile,
      decisionHistory,
      plan,
    });

    const auditScore = scoring.computeAuditScore({ findings, metrics, market: marketProfile, trend: null });
    bundles.push({ platform, findings, auditScore, gates: null });
  }

  const merged = mp.mergeMultiPlatformBundles(bundles, spendWeights);
  const primary = platforms.reduce((a, b) => (spendWeights[b] > spendWeights[a] ? b : a), platforms[0]);
  const primaryMetrics = metricsByPlatform[primary];
  const spendUsd = i18n.toUsd(primaryMetrics?.spend, marketProfile.currency, liveRates) ?? primaryMetrics?.spend ?? 0;
  const dailyBudgetUsd =
    i18n.toUsd(primaryMetrics?.daily_budget, marketProfile.currency, liveRates) ?? primaryMetrics?.daily_budget ?? 0;

  const significance = budget.isPauseDataSignificant({
    clicks: primaryMetrics?.clicks,
    spend_usd: spendUsd,
    conversions: primaryMetrics?.conversions,
    daily_budget_usd: dailyBudgetUsd,
  });
  const learning = budget.evaluateLearningPhase({
    conversions_since_edit: primaryMetrics?.conversions_since_edit,
    days_since_edit: primaryMetrics?.days_since_edit,
    learning_phase_state: primaryMetrics?.learning_phase_state,
  });
  const roasReliability = budget.isRoasReliable({
    conversions: primaryMetrics?.conversions,
    daily_budget_usd: dailyBudgetUsd,
  });

  const trend = trendMod.buildTrendSummary(historyByPlatform[primary] || []);
  const antiThrashing = trendMod.detectThrashing(decisionHistory);

  return {
    marketProfile,
    budgetTier: budget.tierName(budget.tierForDailyBudgetUsd(dailyBudgetUsd)),
    trend,
    findings: merged.findings,
    antiThrashing,
    gates: { significance, learning, roasReliability },
    auditScore: merged.auditScore,
    multi_platform: merged.multi_platform,
    platform: 'multi',
    primary_platform: primary,
    metrics: primaryMetrics,
    history: historyByPlatform[primary] || [],
  };
}

module.exports = {
  buildMultiPlatformAuditInputs,
  runChecksForPlatform,
};
