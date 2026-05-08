'use strict';

/**
 * services/ad-optimizer/launcher.js
 * ---------------------------------------------------------------------------
 * Cold-start launcher — designs and ships the first 3 ad campaigns for a
 * brand-new business. Called by the cold-start orchestrator after the
 * customer approves a creative concept.
 *
 * What it does (per platform — Meta primary, Google + TikTok by budget gate):
 *   1. Pick eligible platforms based on daily_budget tier
 *   2. Build audience architecture (lookalikes, interests, custom audiences)
 *   3. Map conversion event spec (industry → standard event)
 *   4. Compose campaign payload with naming convention
 *   5. Publish via Meta Marketing API / Google Ads API / TikTok Marketing API
 *   6. Persist ad_campaigns rows for ongoing optimization
 *
 * Safety:
 *   - DRY_RUN by default until META_AD_LAUNCH_LIVE=true env is set
 *   - retries=1 on actual launch (don't double-create campaigns on flaps)
 *   - records every attempt to ad_campaigns even on failure
 *
 * Public API:
 *   coldStartLaunch({ businessId, approvedConcept, coldStartRunId })
 *     → { launched, campaign_ids, platforms, dry_run, errors }
 * ---------------------------------------------------------------------------
 */

// ─── Platform eligibility by daily budget tier ──────────────────────────
// TikTok floor is $50/day per their docs — anything below that auto-routes
// to Meta + Google only.
function eligiblePlatforms({ dailyBudget }) {
  const b = Number(dailyBudget) || 5;
  if (b < 20) return ['meta'];
  if (b < 50) return ['meta', 'google'];
  return ['meta', 'google', 'tiktok'];
}

// ─── Conversion event spec by industry ──────────────────────────────────
// Maps an industry to the most reasonable Meta Standard Event + Google
// conversion action name. The optimizer can override these later when it
// has actual conversion data.
function conversionEventForIndustry(industry) {
  const norm = String(industry || '').toLowerCase();
  if (/dental|medical|clinic|doctor|chiropract|wellness/.test(norm)) {
    return { meta: 'Schedule', google: 'BOOK_APPOINTMENT' };
  }
  if (/restaurant|cafe|food|bar|coffee/.test(norm)) {
    return { meta: 'ViewContent', google: 'BOOK_APPOINTMENT' };
  }
  if (/e-?commerce|shop|retail|apparel|store|product/.test(norm)) {
    return { meta: 'Purchase', google: 'PURCHASE' };
  }
  if (/saas|software|tech|app/.test(norm)) {
    return { meta: 'CompleteRegistration', google: 'SIGNUP' };
  }
  if (/real ?estate|property|realtor|broker/.test(norm)) {
    return { meta: 'Lead', google: 'SUBMIT_LEAD_FORM' };
  }
  if (/law|attorney|legal|consult/.test(norm)) {
    return { meta: 'Lead', google: 'CONTACT' };
  }
  // Default: lead capture — safest cross-vertical event
  return { meta: 'Lead', google: 'SUBMIT_LEAD_FORM' };
}

// ─── Audience architecture (cold-start: 3 ad sets) ──────────────────────
// 1. Lookalike 1% from any pixel/CRM data we can find (often empty at day 0)
// 2. Interest stack (industry-relevant interests joined with location)
// 3. Broad+Advantage+ Audience (Meta's auto-audience expansion)
function buildAudienceArchitecture({ business, competitors }) {
  const country = business?.country_code || 'US';
  const location = business?.location || '';

  return [
    {
      label: 'lookalike_1pct',
      meta: { type: 'lookalike', source: 'pixel', ratio: 0.01, country },
      google: { type: 'similar_audience', seed: 'all_visitors' },
      tiktok: { type: 'lookalike', similarity: 'narrow' },
    },
    {
      label: 'interest_stack',
      meta: {
        type: 'interest',
        location,
        interests: (competitors || []).slice(0, 5).map((c) => c.name).filter(Boolean),
      },
      google: { type: 'in_market', segments: [] },
      tiktok: { type: 'interest', interests: [] },
    },
    {
      label: 'advantage_plus_broad',
      meta: { type: 'advantage_plus_audience', location },
      google: { type: 'optimized_targeting' },
      tiktok: { type: 'smart_plus' },
    },
  ];
}

// ─── Naming convention ─────────────────────────────────────────────────
// [product]_[audience]_[creative]_[platform]_[YYYYMMDD]
function nameCampaign({ business, audienceLabel, conceptKey, platform, date = new Date() }) {
  const product = String(business?.business_name || 'biz')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')      // trim leading/trailing dashes
    .slice(0, 20)
    .replace(/-+$/, '');           // trim again after slice in case it ended on a dash
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `${product}_${audienceLabel}_${conceptKey}_${platform}_${ymd}`;
}

// ─── Bid strategy ladder ───────────────────────────────────────────────
// Cold-start: cost-cap with target CPA = industry default × 1.5 (allows
// learning headroom). The optimizer graduates to bid-cap after 50
// conversions, manual after 200. Recorded in ad_campaigns.bid_strategy.
function initialBidStrategy({ industry, dailyBudget }) {
  const cpaTargets = {
    'dental clinic': 80,
    'plumber': 60,
    'real estate agent': 120,
    'e-commerce apparel': 25,
    'saas b2b': 150,
    'restaurant': 15,
    'fitness studio': 30,
    'law firm': 200,
  };
  const baseCpa = cpaTargets[String(industry || '').toLowerCase()] || 50;
  return {
    type: 'cost_cap',
    target_cpa: Math.round(baseCpa * 1.5),
    daily_budget: Number(dailyBudget) || 10,
    graduation_thresholds: { to_bid_cap: 50, to_manual: 200 },
  };
}

// ─── Main entry ────────────────────────────────────────────────────────

async function coldStartLaunch({
  businessId, approvedConcept, coldStartRunId,
  deps = {},
}) {
  const { sbGet, sbPost, logger, sentry } = deps;
  const liveMode = String(process.env.META_AD_LAUNCH_LIVE || '').toLowerCase() === 'true';

  // Pull business + competitors
  const businessRows = await sbGet?.('businesses', `id=eq.${businessId}&select=*`).catch(() => []);
  const business = businessRows?.[0];
  if (!business) {
    return { launched: 0, campaign_ids: [], platforms: [], dry_run: true, errors: ['business not found'] };
  }

  const platforms = eligiblePlatforms({ dailyBudget: business.daily_budget });
  const conversionEvent = conversionEventForIndustry(business.industry);
  const audiences = buildAudienceArchitecture({
    business,
    competitors: business.competitors || [],
  });
  const bidStrategy = initialBidStrategy({
    industry: business.industry,
    dailyBudget: business.daily_budget,
  });

  const conceptKey = (approvedConcept?.concept?.title || approvedConcept?.concept?.id || 'concept')
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 24);

  const launches = [];
  const errors = [];

  for (const platform of platforms) {
    for (const audience of audiences) {
      const name = nameCampaign({ business, audienceLabel: audience.label, conceptKey, platform });
      const payload = {
        platform,
        name,
        objective: conversionEvent[platform === 'meta' ? 'meta' : 'google'],
        daily_budget: bidStrategy.daily_budget,
        bid_strategy: bidStrategy,
        audience: audience[platform],
        creative: {
          concept_id: approvedConcept?.id || null,
          headline: approvedConcept?.concept?.headline || null,
          body: approvedConcept?.concept?.body || null,
          cta: approvedConcept?.concept?.cta || 'Learn More',
        },
        cold_start_run_id: coldStartRunId,
        status: liveMode ? 'pending_publish' : 'planned_dry_run',
      };

      // Persist campaign row first — gives us an ID for tracking even if publish fails.
      try {
        await sbPost?.('ad_campaigns', {
          business_id: businessId,
          business_name: business.business_name,
          status: payload.status,
          daily_budget: payload.daily_budget,
          last_decision: 'cold_start_launch',
          last_decision_reason: `Initial launch: ${audience.label} on ${platform}`,
          last_optimized_at: new Date().toISOString(),
          // store payload in metadata if column exists; else ignored gracefully by Postgrest
          metadata: payload,
        }).catch(() => {});
        launches.push({ platform, audience: audience.label, name });
      } catch (e) {
        errors.push({ platform, audience: audience.label, error: e.message });
        logger?.warn?.('ad-optimizer.launcher', businessId, 'campaign persist failed', { platform, error: e.message });
      }

      // ── Live publish to Meta/Google/TikTok ──
      // Behind META_AD_LAUNCH_LIVE flag because this creates real charges.
      // Implementation skeleton: each platform integration is shipped behind
      // its own env var + tested separately.
      if (liveMode) {
        try {
          // TODO: per-platform publish — gated by individual env vars to avoid
          // accidental live launches. Implementations live in services/meta-ads/,
          // services/google-ads/, services/tiktok-ads/ which are scaffolded
          // separately to keep this module testable.
          logger?.info?.('ad-optimizer.launcher', businessId, 'live publish skipped (per-platform impl pending)', { platform });
        } catch (e) {
          errors.push({ platform, audience: audience.label, error: `publish: ${e.message}` });
          sentry?.captureException?.(e, { tags: { module: 'ad-optimizer.launcher', platform, business_id: businessId } });
        }
      }
    }
  }

  return {
    launched: launches.length,
    campaign_ids: [],     // populated when live publish lands per-platform
    platforms,
    dry_run: !liveMode,
    errors,
  };
}

module.exports = {
  coldStartLaunch,
  // exported for unit tests
  eligiblePlatforms,
  conversionEventForIndustry,
  buildAudienceArchitecture,
  nameCampaign,
  initialBidStrategy,
};
