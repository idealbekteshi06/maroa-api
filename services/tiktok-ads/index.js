'use strict';

/**
 * services/tiktok-ads/index.js
 * ---------------------------------------------------------------------------
 * TikTok Ads optimizer — Smart+ campaigns with Spark Ads bias for SMB budgets.
 *
 * 2026 reality check from research:
 *   - Campaign minimum: $50/day
 *   - Ad-group minimum: $20/day
 *   - Spark Ads CPM $1-$4 (uses organic posts)
 *   - In-Feed Ads CPM $4-$10 (lower trust signal)
 *   - Smart+ campaigns simplify everything but require business verification
 *
 * What this module does:
 *   - Eligibility gate (refuses to launch on businesses below $50/day total)
 *   - Spark Ads selection (picks high-performing organic posts to boost)
 *   - Smart+ campaign template (one campaign per business, multiple ad groups)
 *   - Performance audit + decision rules
 *
 * Public API:
 *   isEligible({ dailyBudget })          — boolean
 *   selectSparkAdsPosts({ businessId })   — picks top organic posts to boost
 *   coldStartLaunch({ businessId, concept }) — initial Smart+ campaign
 *   auditCampaigns({ businessId })       — daily audit
 * ---------------------------------------------------------------------------
 */

const TIKTOK_CAMPAIGN_MIN_DAILY = 50;
const TIKTOK_AD_GROUP_MIN_DAILY = 20;
const SPARK_ADS_PERFORMANCE_PERCENTILE = 75;   // boost top-25% organic posts

function isEligible({ dailyBudget }) {
  return Number(dailyBudget) >= TIKTOK_CAMPAIGN_MIN_DAILY;
}

/**
 * eligibilityVerdict — explainable answer for the customer dashboard.
 */
function eligibilityVerdict({ dailyBudget, businessVerified }) {
  const reasons = [];
  if (!isEligible({ dailyBudget })) {
    reasons.push(`TikTok requires $${TIKTOK_CAMPAIGN_MIN_DAILY}/day minimum spend (you're at $${dailyBudget}/day) — routing to Meta + Google instead`);
  }
  if (businessVerified === false) {
    reasons.push('TikTok Business verification not complete — Smart+ campaigns unavailable');
  }
  return {
    eligible: reasons.length === 0,
    reasons,
  };
}

/**
 * selectSparkAdsPosts — find the customer's top organic TikTok posts by
 * engagement (views, likes, completion rate) and pick the top 25th
 * percentile to boost as Spark Ads.
 *
 * Why Spark Ads over In-Feed: 4-10× cheaper CPM, higher trust signal,
 * benefits the organic profile too.
 */
async function selectSparkAdsPosts({ businessId, deps, limit = 5 }) {
  const { sbGet, tiktokApi } = deps;
  if (!tiktokApi?.listOrganicPosts) {
    return { ok: false, reason: 'tiktokApi.listOrganicPosts not configured', posts: [] };
  }

  let posts;
  try {
    posts = await tiktokApi.listOrganicPosts({ businessId, limit: 50 });
  } catch (e) {
    return { ok: false, reason: e.message, posts: [] };
  }

  if (!Array.isArray(posts) || posts.length < 4) {
    return { ok: false, reason: 'Need at least 4 organic posts to identify high-performers', posts: [] };
  }

  // Score by engagement composite: views × completion_rate × (likes + comments × 3)
  // Comments weighted 3× because they're a stronger affinity signal than likes.
  const scored = posts.map((p) => ({
    ...p,
    _engagement_score:
      (Number(p.views) || 0) *
      (Number(p.completion_rate) || 0.1) *
      ((Number(p.likes) || 0) + (Number(p.comments) || 0) * 3),
  })).sort((a, b) => b._engagement_score - a._engagement_score);

  // Top-25th-percentile
  const threshold = Math.max(1, Math.floor(scored.length * (1 - SPARK_ADS_PERFORMANCE_PERCENTILE / 100)));
  const top = scored.slice(0, Math.min(threshold, limit));

  return {
    ok: true,
    posts: top.map((p) => ({
      post_id: p.id,
      caption: p.caption,
      views: p.views,
      engagement_score: p._engagement_score,
    })),
    selection_method: 'top_25th_percentile_by_engagement',
  };
}

/**
 * Cold-start launch — gated by eligibility + business verification.
 */
async function coldStartLaunch({ businessId, concept, deps }) {
  const { sbGet, sbPost, logger } = deps;
  const businessRows = await sbGet?.('businesses', `id=eq.${businessId}&select=daily_budget,tiktok_business_verified,industry,business_name`).catch(() => []);
  const business = businessRows?.[0];
  if (!business) return { ok: false, reason: 'business not found' };

  const verdict = eligibilityVerdict({
    dailyBudget: business.daily_budget,
    businessVerified: business.tiktok_business_verified !== false, // default to true unless explicitly false
  });

  if (!verdict.eligible) {
    return { ok: true, launched: 0, eligible: false, reasons: verdict.reasons };
  }

  // Try to seed with Spark Ads from organic posts; if not enough organic
  // material exists, fall back to In-Feed Ads with the approved concept.
  const sparkResult = await selectSparkAdsPosts({ businessId, deps, limit: 3 });

  const adGroupBudget = Math.max(TIKTOK_AD_GROUP_MIN_DAILY, Math.floor(business.daily_budget / 3));
  const groups = [
    {
      name: 'smart_plus_lookalike',
      audience: 'lookalike_narrow',
      daily_budget: adGroupBudget,
      ad_type: sparkResult.ok && sparkResult.posts.length > 0 ? 'spark_ads' : 'in_feed',
      spark_post_id: sparkResult.ok ? sparkResult.posts[0]?.post_id : null,
    },
    {
      name: 'smart_plus_interest',
      audience: 'interest',
      daily_budget: adGroupBudget,
      ad_type: 'in_feed',
      spark_post_id: null,
    },
  ];

  // Persist as ad_campaigns rows (status: planned_dry_run unless TIKTOK_ADS_LIVE set)
  const live = String(process.env.TIKTOK_ADS_LIVE || '').toLowerCase() === 'true';
  for (const g of groups) {
    await sbPost?.('ad_campaigns', {
      business_id: businessId,
      business_name: business.business_name,
      status: live ? 'pending_publish' : 'planned_dry_run',
      daily_budget: g.daily_budget,
      last_decision: 'cold_start_launch',
      last_decision_reason: `TikTok Smart+ ${g.name} (${g.ad_type})`,
      last_optimized_at: new Date().toISOString(),
      metadata: { platform: 'tiktok', smart_plus: true, ...g, concept_id: concept?.id || null },
    }).catch((e) => logger?.warn?.('tiktok-ads.coldStartLaunch', businessId, 'persist failed', { error: e.message }));
  }

  return {
    ok: true,
    launched: groups.length,
    eligible: true,
    spark_seeded: sparkResult.ok ? sparkResult.posts.length : 0,
    dry_run: !live,
  };
}

// ─── Audit ──────────────────────────────────────────────────────────────

async function auditCampaigns({ businessId, deps }) {
  const { sbGet, tiktokApi, measurementHealth } = deps;
  if (!tiktokApi?.fetchInsights) return { ok: false, reason: 'tiktokApi.fetchInsights not configured' };

  const trust = await measurementHealth?.trustForScaling?.({
    businessId, platform: 'tiktok', deps,
  }).catch(() => false);

  let insights;
  try {
    insights = await tiktokApi.fetchInsights({ businessId });
  } catch (e) {
    return { ok: false, reason: e.message };
  }

  const decisions = (insights?.campaigns || []).map((c) => decideForTikTokCampaign({ camp: c, trust }));
  return { ok: true, audited: decisions.length, decisions, trust_for_scaling: trust };
}

function decideForTikTokCampaign({ camp, trust }) {
  const { id, status, roas, cpa, conversions_30d, in_learning } = camp;
  if (in_learning) return { campaign_id: id, decision: 'hold', reason: 'Smart+ in learning' };
  if (!trust) {
    if (typeof cpa === 'number' && cpa > (camp.target_cpa || 100) * 3) {
      return { campaign_id: id, decision: 'pause', reason: 'CPA blowout > 3× target (only hard signal honored when Events API untrusted)' };
    }
    return { campaign_id: id, decision: 'hold', reason: 'Events API health degraded — measurement untrusted' };
  }
  if (typeof roas === 'number' && roas >= 2.5 && conversions_30d >= 30) {
    return { campaign_id: id, decision: 'scale_15pct', reason: `ROAS ${roas.toFixed(2)} ≥ 2.5 with ${conversions_30d} conversions` };
  }
  if (typeof roas === 'number' && roas < 0.8) {
    return { campaign_id: id, decision: 'refresh_creative', reason: `ROAS ${roas.toFixed(2)} below 0.8 — likely creative fatigue, request fresh Spark posts` };
  }
  return { campaign_id: id, decision: 'hold', reason: 'Within bounds' };
}

module.exports = {
  isEligible,
  eligibilityVerdict,
  selectSparkAdsPosts,
  coldStartLaunch,
  auditCampaigns,
  decideForTikTokCampaign,
  TIKTOK_CAMPAIGN_MIN_DAILY,
  TIKTOK_AD_GROUP_MIN_DAILY,
};
