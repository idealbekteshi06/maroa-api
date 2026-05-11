'use strict';

/**
 * services/measurement-health/index.js
 * ---------------------------------------------------------------------------
 * Measurement Health Probe — verifies that the data feeding our ad-optimizer
 * decisions is trustworthy. Without this check, we can't tell the difference
 * between "ROAS dropped" and "tracking broke". Pixel-only attribution loses
 * 30-40% of post-iOS 14.5 conversions, so EMQ + dedup ratio matter a LOT.
 *
 * Per-platform checks:
 *
 *   Meta:
 *     - Event Match Quality (EMQ) score from Meta Insights API
 *     - Pixel ↔ CAPI deduplication ratio
 *     - Verdict: healthy ≥ EMQ 8 AND dedup ≥ 0.7
 *
 *   Google:
 *     - Enhanced Conversions enabled (single toggle since June 2026)
 *     - Conversion action diagnostics
 *     - Match rate ≥ 0.5
 *
 *   TikTok:
 *     - Events API health string from Marketing API diagnostics
 *     - Events count > 0 in last 24h
 *
 * Public API:
 *   probe({ businessId, platform })  → measurement_health row
 *   getLatest({ businessId, platform }) → most recent row
 *   trustForScaling({ businessId, platform }) → boolean (gate before scale)
 * ---------------------------------------------------------------------------
 */

const HEALTH_THRESHOLDS = {
  meta: {
    emq_min: 6,
    emq_excellent: 8,
    dedup_min: 0.7,
  },
  google: {
    match_rate_min: 0.5,
  },
  tiktok: {
    events_24h_min: 1,
  },
};

function deriveMetaVerdict({ emq, dedup }) {
  const reasons = [];
  if (emq == null) reasons.push('EMQ score unavailable');
  if (dedup == null) reasons.push('Pixel/CAPI dedup ratio unavailable');
  if (typeof emq === 'number' && emq < HEALTH_THRESHOLDS.meta.emq_min) {
    reasons.push(`EMQ ${emq} below minimum ${HEALTH_THRESHOLDS.meta.emq_min}`);
  }
  if (typeof dedup === 'number' && dedup < HEALTH_THRESHOLDS.meta.dedup_min) {
    reasons.push(`Pixel/CAPI dedup ${(dedup * 100).toFixed(0)}% below 70% minimum`);
  }
  let verdict = 'unknown';
  let trust = false;
  if (typeof emq === 'number' && typeof dedup === 'number') {
    if (emq >= HEALTH_THRESHOLDS.meta.emq_excellent && dedup >= HEALTH_THRESHOLDS.meta.dedup_min) {
      verdict = 'healthy';
      trust = true;
    } else if (emq >= HEALTH_THRESHOLDS.meta.emq_min && dedup >= HEALTH_THRESHOLDS.meta.dedup_min) {
      verdict = 'degraded';
      trust = true;
    } else {
      verdict = 'broken';
      trust = false;
    }
  }
  return { verdict, trust, reasons };
}

function deriveGoogleVerdict({ enhancedOn, matchRate, convActionCount }) {
  const reasons = [];
  if (enhancedOn === false) reasons.push('Enhanced Conversions OFF — server-side conversion data missing');
  if (typeof matchRate === 'number' && matchRate < HEALTH_THRESHOLDS.google.match_rate_min) {
    reasons.push(`Enhanced Conv match rate ${(matchRate * 100).toFixed(0)}% below 50%`);
  }
  if (convActionCount === 0) reasons.push('No active conversion actions configured');
  let verdict = 'unknown';
  let trust = false;
  if (enhancedOn === true && typeof matchRate === 'number') {
    if (matchRate >= 0.7) {
      verdict = 'healthy';
      trust = true;
    } else if (matchRate >= HEALTH_THRESHOLDS.google.match_rate_min) {
      verdict = 'degraded';
      trust = true;
    } else {
      verdict = 'broken';
      trust = false;
    }
  } else if (enhancedOn === false) {
    verdict = 'broken';
  }
  return { verdict, trust, reasons };
}

function deriveTikTokVerdict({ eventsApiHealth, events24h }) {
  const reasons = [];
  if (eventsApiHealth && /(error|fail|broken)/i.test(eventsApiHealth)) {
    reasons.push(`Events API: ${eventsApiHealth}`);
  }
  if (typeof events24h === 'number' && events24h < HEALTH_THRESHOLDS.tiktok.events_24h_min) {
    reasons.push('No events received in last 24h');
  }
  let verdict = 'unknown';
  let trust = false;
  if (typeof events24h === 'number') {
    if (events24h >= 100) {
      verdict = 'healthy';
      trust = true;
    } else if (events24h >= 1) {
      verdict = 'degraded';
      trust = true;
    } else {
      verdict = 'broken';
      trust = false;
    }
  }
  return { verdict, trust, reasons };
}

/**
 * probe — runs platform-specific health check + persists result.
 *
 * Inputs (deps):
 *   sbGet, sbPost — Supabase REST helpers
 *   metaInsights — async ({ businessId }) → { emq, dedup, capi_events_24h, raw }
 *   googleAdsDiag — async ({ businessId }) → { enhanced_on, match_rate, conv_action_count, raw }
 *   tiktokDiag — async ({ businessId }) → { events_api_health, events_24h, raw }
 *
 * In production these source-of-truth functions hit the Meta/Google/TikTok
 * APIs. They're injected so we can test the verdict logic in isolation.
 */
async function probe({ businessId, platform, deps }) {
  const { sbPost, logger } = deps;

  let raw = {};
  let metaEmq, metaDedup, metaCapiEvents24h;
  let googleEnhancedOn, googleMatchRate, googleConvActionCount;
  let tiktokEventsHealth, tiktokEvents24h;
  let verdict = 'unknown';
  let trust = false;
  let reasons = [];

  try {
    if (platform === 'meta') {
      const r = await deps.metaInsights?.({ businessId }).catch(() => null);
      if (r) {
        metaEmq = r.emq;
        metaDedup = r.dedup;
        metaCapiEvents24h = r.capi_events_24h;
        raw = r.raw || {};
      }
      const v = deriveMetaVerdict({ emq: metaEmq, dedup: metaDedup });
      verdict = v.verdict;
      trust = v.trust;
      reasons = v.reasons;
    } else if (platform === 'google') {
      const r = await deps.googleAdsDiag?.({ businessId }).catch(() => null);
      if (r) {
        googleEnhancedOn = r.enhanced_on;
        googleMatchRate = r.match_rate;
        googleConvActionCount = r.conv_action_count;
        raw = r.raw || {};
      }
      const v = deriveGoogleVerdict({
        enhancedOn: googleEnhancedOn,
        matchRate: googleMatchRate,
        convActionCount: googleConvActionCount,
      });
      verdict = v.verdict;
      trust = v.trust;
      reasons = v.reasons;
    } else if (platform === 'tiktok') {
      const r = await deps.tiktokDiag?.({ businessId }).catch(() => null);
      if (r) {
        tiktokEventsHealth = r.events_api_health;
        tiktokEvents24h = r.events_24h;
        raw = r.raw || {};
      }
      const v = deriveTikTokVerdict({
        eventsApiHealth: tiktokEventsHealth,
        events24h: tiktokEvents24h,
      });
      verdict = v.verdict;
      trust = v.trust;
      reasons = v.reasons;
    } else {
      return { ok: false, reason: 'unknown platform' };
    }
  } catch (e) {
    logger?.warn?.('measurement-health.probe', businessId, 'probe error', { error: e.message, platform });
    reasons.push(`probe error: ${e.message}`);
  }

  const row = {
    business_id: businessId,
    platform,
    emq_score: typeof metaEmq === 'number' ? metaEmq : null,
    pixel_capi_dedup_ratio: typeof metaDedup === 'number' ? metaDedup : null,
    capi_events_24h: typeof metaCapiEvents24h === 'number' ? metaCapiEvents24h : null,
    enhanced_conversions_on: typeof googleEnhancedOn === 'boolean' ? googleEnhancedOn : null,
    enhanced_conv_match_rate: typeof googleMatchRate === 'number' ? googleMatchRate : null,
    conv_action_count: typeof googleConvActionCount === 'number' ? googleConvActionCount : null,
    events_api_health: tiktokEventsHealth || null,
    events_24h: typeof tiktokEvents24h === 'number' ? tiktokEvents24h : null,
    health_verdict: verdict,
    trust_for_scaling: trust,
    reasons,
    raw,
  };

  await sbPost?.('measurement_health', row).catch(() => {});

  return { ok: true, ...row };
}

async function getLatest({ businessId, platform, deps }) {
  const rows = await deps
    .sbGet?.(
      'measurement_health',
      `business_id=eq.${businessId}&platform=eq.${platform}&order=recorded_at.desc&limit=1&select=*`
    )
    .catch(() => []);
  return rows?.[0] || null;
}

async function trustForScaling({ businessId, platform, deps, maxAgeHours = 24 }) {
  const latest = await getLatest({ businessId, platform, deps });
  if (!latest) return false;
  const ageMs = Date.now() - new Date(latest.recorded_at).getTime();
  if (ageMs > maxAgeHours * 60 * 60 * 1000) return false;
  return latest.trust_for_scaling === true;
}

module.exports = {
  probe,
  getLatest,
  trustForScaling,
  deriveMetaVerdict,
  deriveGoogleVerdict,
  deriveTikTokVerdict,
  HEALTH_THRESHOLDS,
};
