'use strict';

/**
 * services/meta-marketing/index.js
 * ---------------------------------------------------------------------------
 * Real Meta Marketing API client + Conversions API (CAPI).
 *
 * Endpoints used:
 *   POST /act_{ad_account_id}/campaigns         — create campaign
 *   POST /act_{ad_account_id}/adsets            — create ad set
 *   POST /act_{ad_account_id}/ads               — create ad
 *   GET  /act_{ad_account_id}/insights          — campaign performance
 *   POST /{pixel_id}/events                     — Conversions API server-side
 *   GET  /{pixel_id}/stats                      — EMQ score + dedup ratio
 *
 * Auth: per-business `meta_access_token` (already on businesses table).
 * API version: v21.0 (current as of 2026).
 *
 * Public API (called by ad-optimizer/launcher.js when META_AD_LAUNCH_LIVE=true):
 *   isConfigured({ business })
 *   createCampaignWithAdSetsAndAds({ business, payload })
 *     → { ok, campaign_id, ad_set_ids, ad_ids }
 *   fetchInsights({ businessId, since, until })
 *     → { campaigns: [...] } shape used by ad-optimizer
 *   fetchMeasurementHealth({ businessId })
 *     → { emq, dedup, capi_events_24h, raw }
 *   sendConversionEvent({ business, event_name, event_data })
 *     → CAPI server-side conversion send
 * ---------------------------------------------------------------------------
 */

const GRAPH_VERSION = 'v21.0';
const GRAPH_HOST = 'graph.facebook.com';
const META_LAUNCH_LIVE = () => String(process.env.META_AD_LAUNCH_LIVE || '').toLowerCase() === 'true';

function isConfigured({ business }) {
  return !!(business?.meta_access_token && business?.ad_account_id);
}

async function graphCall({ method, path, accessToken, body, query }) {
  if (!accessToken) return { ok: false, status: 0, reason: 'access token required' };
  const params = new URLSearchParams({ access_token: accessToken, ...(query || {}) });
  const url = `https://${GRAPH_HOST}/${GRAPH_VERSION}${path}?${params.toString()}`;
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) {
      return {
        ok: false,
        status: res.status,
        reason: json?.error?.message || `HTTP ${res.status}`,
        raw: json,
      };
    }
    return { ok: true, status: res.status, raw: json };
  } catch (e) {
    return { ok: false, status: 0, reason: e.message };
  }
}

// ─── Campaign creation ──────────────────────────────────────────────────

const META_OBJECTIVE_MAP = {
  // Maps our internal conversion-event names to Meta ODAX objectives (2024+).
  Lead: 'OUTCOME_LEADS',
  Purchase: 'OUTCOME_SALES',
  Schedule: 'OUTCOME_LEADS',
  ViewContent: 'OUTCOME_TRAFFIC',
  CompleteRegistration: 'OUTCOME_LEADS',
  AddToCart: 'OUTCOME_SALES',
};

async function createCampaign({ business, name, conversionEvent, dailyBudgetCents }) {
  if (!META_LAUNCH_LIVE()) {
    return { ok: true, dry_run: true, campaign_id: `dry_run_${Date.now()}`, reason: 'META_AD_LAUNCH_LIVE=false' };
  }
  const objective = META_OBJECTIVE_MAP[conversionEvent] || 'OUTCOME_LEADS';
  return graphCall({
    method: 'POST',
    path: `/act_${business.ad_account_id}/campaigns`,
    accessToken: business.meta_access_token,
    body: {
      name,
      objective,
      status: 'PAUSED',                    // safety: created PAUSED, manually activated
      special_ad_categories: [],
      buying_type: 'AUCTION',
      daily_budget: dailyBudgetCents,      // cents (e.g. 1000 = $10)
    },
  });
}

async function createAdSet({ business, campaignId, name, audience, dailyBudgetCents, optimizationGoal = 'OFFSITE_CONVERSIONS', billingEvent = 'IMPRESSIONS' }) {
  if (!META_LAUNCH_LIVE()) {
    return { ok: true, dry_run: true, ad_set_id: `dry_run_adset_${Date.now()}` };
  }
  return graphCall({
    method: 'POST',
    path: `/act_${business.ad_account_id}/adsets`,
    accessToken: business.meta_access_token,
    body: {
      name,
      campaign_id: campaignId,
      daily_budget: dailyBudgetCents,
      billing_event: billingEvent,
      optimization_goal: optimizationGoal,
      bid_strategy: 'LOWEST_COST_WITH_BID_CAP',
      targeting: audience || { geo_locations: { countries: ['US'] } },
      status: 'PAUSED',
      start_time: new Date().toISOString(),
    },
  });
}

async function createAd({ business, adSetId, name, creative }) {
  if (!META_LAUNCH_LIVE()) {
    return { ok: true, dry_run: true, ad_id: `dry_run_ad_${Date.now()}` };
  }
  return graphCall({
    method: 'POST',
    path: `/act_${business.ad_account_id}/ads`,
    accessToken: business.meta_access_token,
    body: {
      name,
      adset_id: adSetId,
      creative,
      status: 'PAUSED',
    },
  });
}

/**
 * Convenience — creates a campaign + N ad sets + N ads in one shot.
 * Used by ad-optimizer/launcher.js for cold-start.
 */
async function createCampaignWithAdSetsAndAds({ business, payload }) {
  const dailyBudgetCents = Math.round(Number(payload.daily_budget || 10) * 100);
  const campRes = await createCampaign({
    business,
    name: payload.name,
    conversionEvent: payload.objective,
    dailyBudgetCents,
  });
  if (!campRes.ok) return campRes;

  const campaignId = campRes.dry_run ? campRes.campaign_id : campRes.raw.id;
  const adSetIds = [];
  const adIds = [];

  for (const variant of payload.variants || [payload]) {
    const asRes = await createAdSet({
      business,
      campaignId,
      name: `${payload.name}_${variant.audience_label || 'main'}`,
      audience: variant.audience,
      dailyBudgetCents: Math.round((Number(variant.daily_budget) || 5) * 100),
    });
    if (!asRes.ok) continue;
    const adSetId = asRes.dry_run ? asRes.ad_set_id : asRes.raw.id;
    adSetIds.push(adSetId);

    if (variant.creative) {
      const adRes = await createAd({
        business, adSetId, name: `${payload.name}_${variant.audience_label}_ad`, creative: variant.creative,
      });
      if (adRes.ok) adIds.push(adRes.dry_run ? adRes.ad_id : adRes.raw.id);
    }
  }

  return {
    ok: true,
    dry_run: campRes.dry_run === true,
    campaign_id: campaignId,
    ad_set_ids: adSetIds,
    ad_ids: adIds,
  };
}

// ─── Insights (used by ad-optimizer daily audit) ────────────────────────

async function fetchInsights({ businessId, business, since, until }) {
  if (!business?.meta_access_token || !business?.ad_account_id) {
    return { ok: true, campaigns: [], reason: 'meta token missing' };
  }
  const dateStart = since || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dateEnd = until || new Date().toISOString().slice(0, 10);

  const r = await graphCall({
    method: 'GET',
    path: `/act_${business.ad_account_id}/insights`,
    accessToken: business.meta_access_token,
    query: {
      level: 'campaign',
      time_range: JSON.stringify({ since: dateStart, until: dateEnd }),
      fields: 'campaign_id,campaign_name,spend,clicks,impressions,ctr,cpc,cpm,frequency,reach,actions,action_values',
      limit: '100',
    },
  });
  if (!r.ok) return { ok: false, reason: r.reason, campaigns: [] };

  const campaigns = (r.raw?.data || []).map((row) => {
    const conversions = Number(((row.actions || []).find((a) => a.action_type === 'offsite_conversion')?.value) || 0);
    const revenue = Number(((row.action_values || []).find((a) => a.action_type === 'offsite_conversion')?.value) || 0);
    const spend = Number(row.spend) || 0;
    return {
      id: row.campaign_id,
      name: row.campaign_name,
      spend, clicks: Number(row.clicks) || 0,
      impressions: Number(row.impressions) || 0,
      ctr: Number(row.ctr) || null,
      cpc: Number(row.cpc) || null,
      cpm: Number(row.cpm) || null,
      frequency: Number(row.frequency) || null,
      reach: Number(row.reach) || 0,
      conversions,
      conversions_30d: conversions,                    // approximation; daily audit uses 7d window by default
      roas: spend > 0 ? revenue / spend : null,
      cpa: conversions > 0 ? spend / conversions : null,
      learning_phase: false,                            // requires separate /act/insights call with delivery_estimate
      target_cpa: null,
    };
  });
  return { ok: true, campaigns };
}

// ─── Measurement health (EMQ + dedup) ───────────────────────────────────

async function fetchMeasurementHealth({ business }) {
  if (!business?.meta_access_token || !business?.ad_account_id) {
    return null;
  }
  // Pixel events stats endpoint — requires the pixel ID. We try to find it
  // off the ad account.
  const pxRes = await graphCall({
    method: 'GET',
    path: `/act_${business.ad_account_id}/customconversions`,
    accessToken: business.meta_access_token,
    query: { fields: 'pixel,id', limit: '5' },
  });
  const pixelId = pxRes.ok ? pxRes.raw?.data?.[0]?.pixel?.id : null;
  if (!pixelId) {
    return { emq: null, dedup: null, capi_events_24h: null, raw: { reason: 'pixel_id_unavailable' } };
  }

  const stats = await graphCall({
    method: 'GET',
    path: `/${pixelId}/stats`,
    accessToken: business.meta_access_token,
    query: { aggregation: 'event', start_time: String(Math.floor(Date.now() / 1000) - 86400) },
  });
  if (!stats.ok) return { emq: null, dedup: null, capi_events_24h: null, raw: stats.raw };

  // Meta exposes EMQ + dedup in the stats response under various nested keys.
  // We compute defensively. If a key is missing, return null and let the
  // measurement-health verdict fallback to 'unknown'.
  const data = stats.raw?.data || [];
  let totalEvents = 0;
  let totalCapi = 0;
  let totalBoth = 0;
  let emqSum = 0;
  let emqCount = 0;
  for (const row of data) {
    totalEvents += Number(row.count) || 0;
    if (row.dedupe_keys || row.cnp_match_keys) totalBoth += Number(row.count) || 0;
    if (row.event_source === 'server' || row.event_source === 'both') totalCapi += Number(row.count) || 0;
    if (typeof row.emq === 'number') { emqSum += row.emq; emqCount += 1; }
  }
  return {
    emq: emqCount > 0 ? emqSum / emqCount : null,
    dedup: totalEvents > 0 ? totalBoth / totalEvents : null,
    capi_events_24h: totalCapi || null,
    raw: { pixel_id: pixelId, stats_count: data.length },
  };
}

// ─── Conversions API (CAPI) — server-side conversion send ───────────────

async function sendConversionEvent({ business, pixelId, event_name, event_data, user_data, event_id }) {
  if (!business?.meta_access_token) return { ok: false, reason: 'meta token missing' };
  const px = pixelId || business.meta_pixel_id;
  if (!px) return { ok: false, reason: 'pixel_id missing — cannot send CAPI event' };

  return graphCall({
    method: 'POST',
    path: `/${px}/events`,
    accessToken: business.meta_access_token,
    body: {
      data: [{
        event_name,
        event_time: Math.floor(Date.now() / 1000),
        event_id: event_id || `${event_name}_${Date.now()}`,        // for dedup with browser pixel
        action_source: 'website',
        user_data: user_data || {},
        custom_data: event_data || {},
      }],
    },
  });
}

module.exports = {
  isConfigured,
  createCampaign,
  createAdSet,
  createAd,
  createCampaignWithAdSetsAndAds,
  fetchInsights,
  fetchMeasurementHealth,
  sendConversionEvent,
  META_OBJECTIVE_MAP,
};
