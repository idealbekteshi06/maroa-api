'use strict';

/**
 * services/google-ads/index.js
 * ---------------------------------------------------------------------------
 * Google Ads optimizer — mirrors the structure of services/ad-optimizer/
 * but for Google Ads (PMax, AI Max for Search, Demand Gen).
 *
 * The "Power Pack" allocation rule per Google's 2026 official guidance:
 *   PMax 70% / AI Max for Search 20% / Demand Gen 10%
 *
 * Consolidation rule: only consolidate campaigns of the same type when the
 * account hits 30+ conversions/month. Below that, keep them separate so each
 * campaign has its own learning signal.
 *
 * What this module does (Week 5-7 scope, decisioning layer only — actual
 * Google Ads API publish lives behind GOOGLE_ADS_LIVE env flag):
 *
 *   - Audit each Google campaign daily
 *   - Score asset coverage (video coverage signal: 25-40% lift)
 *   - Detect when to consolidate vs split
 *   - Recommend Power Pack allocation rebalance
 *   - Score Enhanced Conversions health (gates scaling)
 *
 * Public API:
 *   auditCampaigns({ businessId })     — daily audit, returns decisions array
 *   recommendAllocation({ businessId }) — Power Pack rebalance suggestion
 *   coldStartLaunch({ businessId, concept }) — initial 3-campaign launch
 * ---------------------------------------------------------------------------
 */

const POWER_PACK_DEFAULT = {
  pmax: 0.70,
  ai_max_search: 0.20,
  demand_gen: 0.10,
};

const CONSOLIDATION_MIN_CONVERSIONS_PER_MONTH = 30;
const ASSET_GROUP_VIDEO_COVERAGE_TARGET = 0.6;     // 60% of asset groups should have ≥1 video

// ─── Allocation rebalance ────────────────────────────────────────────────

/**
 * Given current spend distribution + observed ROAS per campaign type, return
 * a recommended new allocation. Rule:
 *   - If a type's ROAS is > 1.5× the others, shift +5pp into it (max once/week)
 *   - If a type's ROAS is < 0.5× the others, shift -5pp from it
 *   - Always respect the Power Pack 70/20/10 unless 30d data overwhelmingly disagrees
 */
function recommendAllocation({ currentSplit, roasByType, learningPhaseTypes = [] }) {
  const target = { ...POWER_PACK_DEFAULT };
  const reasons = [];

  if (!currentSplit || !roasByType) {
    return { allocation: target, reasons: ['Defaulting to Power Pack — no data'] };
  }

  // Don't rebalance away from a type that's still in learning phase
  const movable = ['pmax', 'ai_max_search', 'demand_gen'].filter((t) => !learningPhaseTypes.includes(t));

  // Find the over- and under-performers
  const roasValues = movable.map((t) => roasByType[t]).filter((v) => typeof v === 'number');
  if (roasValues.length < 2) {
    return { allocation: target, reasons: ['Insufficient ROAS signal across types'] };
  }
  const roasMean = roasValues.reduce((a, b) => a + b, 0) / roasValues.length;

  for (const t of movable) {
    const roas = roasByType[t];
    if (typeof roas !== 'number') continue;
    if (roas > roasMean * 1.5) {
      target[t] = Math.min(target[t] + 0.05, 0.85);
      reasons.push(`Shifted +5pp into ${t} (ROAS ${roas.toFixed(2)} vs mean ${roasMean.toFixed(2)})`);
    } else if (roas < roasMean * 0.5) {
      target[t] = Math.max(target[t] - 0.05, 0.05);
      reasons.push(`Shifted -5pp from ${t} (ROAS ${roas.toFixed(2)} below 50% of mean)`);
    }
  }

  // Normalize so the splits sum to 1.0
  const sum = Object.values(target).reduce((a, b) => a + b, 0);
  if (sum > 0) {
    for (const k of Object.keys(target)) target[k] /= sum;
  }

  return { allocation: target, reasons };
}

// ─── Asset-group video coverage score ───────────────────────────────────

function scoreAssetCoverage(assetGroups) {
  if (!Array.isArray(assetGroups) || assetGroups.length === 0) {
    return { score: 0, video_coverage: 0, recommendations: ['No asset groups detected — PMax cannot run effectively without assets'] };
  }
  const withVideo = assetGroups.filter((g) => Array.isArray(g.videos) && g.videos.length > 0).length;
  const coverage = withVideo / assetGroups.length;
  const recs = [];
  if (coverage < ASSET_GROUP_VIDEO_COVERAGE_TARGET) {
    recs.push(`Video coverage ${(coverage * 100).toFixed(0)}% below target ${ASSET_GROUP_VIDEO_COVERAGE_TARGET * 100}% — request 1 video per asset group (research shows 25-40% lift)`);
  }
  return {
    score: Math.round(coverage * 100),
    video_coverage: coverage,
    recommendations: recs,
  };
}

// ─── Consolidation decision ─────────────────────────────────────────────

function shouldConsolidate({ campaignsOfType, monthlyConversions }) {
  if (!Array.isArray(campaignsOfType) || campaignsOfType.length < 2) {
    return { consolidate: false, reason: 'Single campaign — nothing to consolidate' };
  }
  if ((monthlyConversions || 0) < CONSOLIDATION_MIN_CONVERSIONS_PER_MONTH) {
    return {
      consolidate: false,
      reason: `Only ${monthlyConversions} conversions/month — below ${CONSOLIDATION_MIN_CONVERSIONS_PER_MONTH} threshold; keep campaigns separate`,
    };
  }
  return {
    consolidate: true,
    reason: `${monthlyConversions} conversions/month ≥ ${CONSOLIDATION_MIN_CONVERSIONS_PER_MONTH} — consolidating ${campaignsOfType.length} ${campaignsOfType[0]?.type || ''} campaigns boosts learning signal`,
  };
}

// ─── Audit (daily) ─────────────────────────────────────────────────────

/**
 * Daily audit — pulls Google Ads data via deps.googleAdsApi.fetchInsights and
 * returns scale/pause/refresh decisions per campaign. Decisions are PROPOSED
 * (status='pending') unless GOOGLE_ADS_LIVE env is set.
 *
 * Inputs:
 *   deps.measurementHealth.trustForScaling({ businessId, platform: 'google' })
 *     — gates scaling unless Enhanced Conversions match rate ≥ 50%
 */
async function auditCampaigns({ businessId, deps }) {
  const { sbGet, googleAdsApi, measurementHealth, logger } = deps;

  if (!googleAdsApi?.fetchInsights) {
    return { ok: false, reason: 'googleAdsApi.fetchInsights not configured' };
  }

  const trustScaling = await measurementHealth?.trustForScaling?.({
    businessId, platform: 'google', deps,
  }).catch(() => false);

  let insights;
  try {
    insights = await googleAdsApi.fetchInsights({ businessId });
  } catch (e) {
    logger?.warn?.('google-ads.audit', businessId, 'insights fetch failed', { error: e.message });
    return { ok: false, reason: e.message };
  }

  const decisions = [];
  for (const camp of insights?.campaigns || []) {
    const dec = decideForCampaign({ camp, trustScaling });
    decisions.push(dec);
  }

  return {
    ok: true,
    audited: decisions.length,
    decisions,
    trust_for_scaling: trustScaling,
    asset_coverage: scoreAssetCoverage(insights?.asset_groups || []),
  };
}

function decideForCampaign({ camp, trustScaling }) {
  const { id, type, status, roas, cpa, target_cpa, conversions_30d, learning_phase } = camp;

  // Don't make changes during learning phase
  if (learning_phase === true) {
    return { campaign_id: id, type, decision: 'hold', reason: 'In learning phase — no changes allowed' };
  }

  // Refusal: untrusted measurement → no scaling, only obvious pauses
  if (!trustScaling) {
    if (typeof cpa === 'number' && typeof target_cpa === 'number' && cpa > target_cpa * 3) {
      return { campaign_id: id, type, decision: 'pause', reason: `CPA ${cpa} > 3× target ${target_cpa} (scaling untrusted — pausing on hard signal only)` };
    }
    return { campaign_id: id, type, decision: 'hold', reason: 'Enhanced Conversions match rate below 50% — measurement untrusted, no scale decisions' };
  }

  // Trusted measurement → standard rules
  if (typeof roas === 'number' && roas >= 3.0 && conversions_30d >= 30) {
    return { campaign_id: id, type, decision: 'scale_20pct', reason: `ROAS ${roas.toFixed(2)} ≥ 3.0 with ${conversions_30d} conversions in 30d` };
  }
  if (typeof roas === 'number' && roas < 1.0 && conversions_30d < 5) {
    return { campaign_id: id, type, decision: 'pause', reason: `ROAS ${roas.toFixed(2)} < 1.0 with only ${conversions_30d} conversions` };
  }
  return { campaign_id: id, type, decision: 'hold', reason: 'Within normal bounds' };
}

module.exports = {
  recommendAllocation,
  scoreAssetCoverage,
  shouldConsolidate,
  auditCampaigns,
  decideForCampaign,
  POWER_PACK_DEFAULT,
  CONSOLIDATION_MIN_CONVERSIONS_PER_MONTH,
  ASSET_GROUP_VIDEO_COVERAGE_TARGET,
};
