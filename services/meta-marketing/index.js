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

const crypto = require('crypto');
const oauthCrypto = require('../../lib/oauthCrypto');

const GRAPH_VERSION = 'v21.0';
const GRAPH_HOST = 'graph.facebook.com';
const META_LAUNCH_LIVE = () => String(process.env.META_AD_LAUNCH_LIVE || '').toLowerCase() === 'true';
// Per-business consent (migration 095): the global env flag remains a
// kill-switch/override, but a business that explicitly opted in
// (businesses.ads_live=true, asked at onboarding) gets real execution
// without arming every other customer at once.
const adsLive = (business) => META_LAUNCH_LIVE() || business?.ads_live === true;
const DRY_RUN_REASON = 'ads not live (META_AD_LAUNCH_LIVE=false and business.ads_live=false)';

// readToken prefers the encrypted *_enc column and falls back to legacy
// plaintext. Synchronous (no I/O) — the business row is already fetched.
function metaToken(business) {
  return oauthCrypto.readToken(business, 'meta_access_token');
}

function isConfigured({ business }) {
  return !!(metaToken(business) && business?.ad_account_id);
}

async function graphCall({ method, path, accessToken, body, query }) {
  if (!accessToken) return { ok: false, status: 0, reason: 'access token required' };
  const params = new URLSearchParams({ access_token: accessToken, ...(query || {}) });
  // appsecret_proof: required when the Meta app enforces it; also prevents a
  // leaked token from being replayed without the app secret. HMAC of the token.
  const appSecret = (process.env.META_APP_SECRET || '').trim();
  if (appSecret) {
    params.set('appsecret_proof', crypto.createHmac('sha256', appSecret).update(accessToken).digest('hex'));
  }
  const url = `https://${GRAPH_HOST}/${GRAPH_VERSION}${path}?${params.toString()}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(30000),
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
  if (!adsLive(business)) {
    return { ok: true, dry_run: true, campaign_id: `dry_run_${Date.now()}`, reason: DRY_RUN_REASON };
  }
  const objective = META_OBJECTIVE_MAP[conversionEvent] || 'OUTCOME_LEADS';
  return graphCall({
    method: 'POST',
    path: `/act_${business.ad_account_id}/campaigns`,
    accessToken: metaToken(business),
    body: {
      name,
      objective,
      status: 'PAUSED', // safety: created PAUSED, manually activated
      special_ad_categories: [],
      buying_type: 'AUCTION',
      daily_budget: dailyBudgetCents, // cents (e.g. 1000 = $10)
    },
  });
}

async function createAdSet({
  business,
  campaignId,
  name,
  audience,
  dailyBudgetCents,
  optimizationGoal = 'OFFSITE_CONVERSIONS',
  billingEvent = 'IMPRESSIONS',
}) {
  if (!adsLive(business)) {
    return { ok: true, dry_run: true, ad_set_id: `dry_run_adset_${Date.now()}` };
  }
  return graphCall({
    method: 'POST',
    path: `/act_${business.ad_account_id}/adsets`,
    accessToken: metaToken(business),
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
  if (!adsLive(business)) {
    return { ok: true, dry_run: true, ad_id: `dry_run_ad_${Date.now()}` };
  }
  return graphCall({
    method: 'POST',
    path: `/act_${business.ad_account_id}/ads`,
    accessToken: metaToken(business),
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
        business,
        adSetId,
        name: `${payload.name}_${variant.audience_label}_ad`,
        creative: variant.creative,
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
  if (!metaToken(business) || !business?.ad_account_id) {
    return { ok: true, campaigns: [], reason: 'meta token missing' };
  }
  const dateStart = since || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dateEnd = until || new Date().toISOString().slice(0, 10);

  const r = await graphCall({
    method: 'GET',
    path: `/act_${business.ad_account_id}/insights`,
    accessToken: metaToken(business),
    query: {
      level: 'campaign',
      time_range: JSON.stringify({ since: dateStart, until: dateEnd }),
      fields: 'campaign_id,campaign_name,spend,clicks,impressions,ctr,cpc,cpm,frequency,reach,actions,action_values',
      limit: '100',
    },
  });
  if (!r.ok) return { ok: false, reason: r.reason, campaigns: [] };

  const campaigns = (r.raw?.data || []).map((row) => {
    const conversions = Number((row.actions || []).find((a) => a.action_type === 'offsite_conversion')?.value || 0);
    const revenue = Number((row.action_values || []).find((a) => a.action_type === 'offsite_conversion')?.value || 0);
    const spend = Number(row.spend) || 0;
    return {
      id: row.campaign_id,
      name: row.campaign_name,
      spend,
      clicks: Number(row.clicks) || 0,
      impressions: Number(row.impressions) || 0,
      ctr: Number(row.ctr) || null,
      cpc: Number(row.cpc) || null,
      cpm: Number(row.cpm) || null,
      frequency: Number(row.frequency) || null,
      reach: Number(row.reach) || 0,
      conversions,
      conversions_30d: conversions, // approximation; daily audit uses 7d window by default
      roas: spend > 0 ? revenue / spend : null,
      cpa: conversions > 0 ? spend / conversions : null,
      learning_phase: false, // requires separate /act/insights call with delivery_estimate
      target_cpa: null,
    };
  });
  return { ok: true, campaigns };
}

// ─── Rich per-campaign insights (PART 3) ────────────────────────────────
// NOTE: Meta has no `roas` field — the real field is `purchase_roas` (an
// array of {action_type, value}). Requesting `roas` raw returns an API error.

const INSIGHT_FIELDS =
  'campaign_id,campaign_name,impressions,reach,clicks,spend,ctr,cpm,cpp,purchase_roas,actions,action_values,frequency';

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function _roasFromRow(row) {
  const direct = (row.purchase_roas || []).reduce((s, a) => s + Number(a.value || 0), 0);
  if (direct > 0) return direct;
  const rev = Number(
    (row.action_values || []).find((a) => /purchase|offsite_conversion/.test(a.action_type))?.value || 0
  );
  const spend = Number(row.spend || 0);
  return spend > 0 ? rev / spend : 0;
}

function _normalizeInsightRow(row = {}) {
  const conversions = Number(
    (row.actions || []).find((a) => /purchase|offsite_conversion|lead/.test(a.action_type))?.value || 0
  );
  const spend = _num(row.spend);
  return {
    campaign_id: row.campaign_id || null,
    campaign_name: row.campaign_name || null,
    impressions: _num(row.impressions),
    reach: _num(row.reach),
    clicks: _num(row.clicks),
    spend,
    ctr: row.ctr != null ? _num(row.ctr) : null,
    cpm: row.cpm != null ? _num(row.cpm) : null,
    cpp: row.cpp != null ? _num(row.cpp) : null,
    frequency: row.frequency != null ? _num(row.frequency) : null,
    conversions,
    roas: _roasFromRow(row),
    cpa: conversions > 0 ? spend / conversions : null,
    actions: row.actions || [],
    action_values: row.action_values || [],
  };
}

async function _insightsCall({ business, campaignId, datePreset, breakdowns }) {
  const query = {
    level: 'campaign',
    date_preset: datePreset,
    fields: INSIGHT_FIELDS,
    filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: [String(campaignId)] }]),
    limit: '200',
  };
  if (breakdowns) query.breakdowns = breakdowns;
  return graphCall({
    method: 'GET',
    path: `/act_${business.ad_account_id}/insights`,
    accessToken: business.meta_access_token,
    query,
  });
}

/**
 * Fresh per-campaign performance, pulled live from Meta. Used by the
 * ad-optimizer (last_7d window) and the weekly report (breakdowns).
 * Read-only — not gated by META_AD_LAUNCH_LIVE (reading data never spends).
 */
async function fetchCampaignInsights({
  business,
  campaignId,
  datePresets = ['last_7d', 'last_30d'],
  withBreakdowns = true,
}) {
  if (!business?.meta_access_token || !business?.ad_account_id) {
    return { ok: true, campaign_id: campaignId, windows: {}, breakdowns: {}, reason: 'meta token missing' };
  }
  if (!campaignId) return { ok: false, reason: 'campaignId required', windows: {}, breakdowns: {} };

  const windows = {};
  for (const dp of datePresets) {
    const r = await _insightsCall({ business, campaignId, datePreset: dp });
    windows[dp] = r.ok ? _normalizeInsightRow(r.raw?.data?.[0] || {}) : { error: r.reason };
  }

  const breakdowns = {};
  if (withBreakdowns) {
    const groups = { age: 'age', gender: 'gender', placement: 'publisher_platform' };
    for (const [key, bd] of Object.entries(groups)) {
      const r = await _insightsCall({ business, campaignId, datePreset: 'last_7d', breakdowns: bd });
      breakdowns[key] = r.ok
        ? (r.raw?.data || []).map((row) => ({ segment: row[bd] ?? null, ..._normalizeInsightRow(row) }))
        : [];
    }
  }

  return { ok: true, campaign_id: campaignId, windows, breakdowns };
}

// ─── Campaign actuator (PART 4) ─────────────────────────────────────────
// Low-level write to a campaign node. Dry-run gated like every other
// write in this module: when META_AD_LAUNCH_LIVE is not 'true' it returns
// the intended fields WITHOUT touching Meta.
//   fields examples: { status: 'PAUSED' } | { status: 'ACTIVE' }
//                    | { daily_budget: 1500 }  (cents) | { lifetime_budget: 30000 }
async function updateCampaign({ business, campaignId, fields }) {
  if (!fields || Object.keys(fields).length === 0) return { ok: false, reason: 'no fields to update' };
  if (!adsLive(business)) {
    return { ok: true, dry_run: true, campaign_id: campaignId, intended: fields, reason: DRY_RUN_REASON };
  }
  if (!business?.meta_access_token) return { ok: false, reason: 'meta token missing' };
  if (!campaignId) return { ok: false, reason: 'campaignId required' };
  return graphCall({
    method: 'POST',
    path: `/${campaignId}`,
    accessToken: business.meta_access_token,
    body: fields,
  });
}

// ─── Measurement health (EMQ + dedup) ───────────────────────────────────

async function fetchMeasurementHealth({ business }) {
  if (!metaToken(business) || !business?.ad_account_id) {
    return null;
  }
  // Pixel events stats endpoint — requires the pixel ID. We try to find it
  // off the ad account.
  const pxRes = await graphCall({
    method: 'GET',
    path: `/act_${business.ad_account_id}/customconversions`,
    accessToken: metaToken(business),
    query: { fields: 'pixel,id', limit: '5' },
  });
  const pixelId = pxRes.ok ? pxRes.raw?.data?.[0]?.pixel?.id : null;
  if (!pixelId) {
    return { emq: null, dedup: null, capi_events_24h: null, raw: { reason: 'pixel_id_unavailable' } };
  }

  const stats = await graphCall({
    method: 'GET',
    path: `/${pixelId}/stats`,
    accessToken: metaToken(business),
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
    if (typeof row.emq === 'number') {
      emqSum += row.emq;
      emqCount += 1;
    }
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
  if (!metaToken(business)) return { ok: false, reason: 'meta token missing' };
  const px = pixelId || business.meta_pixel_id;
  if (!px) return { ok: false, reason: 'pixel_id missing — cannot send CAPI event' };

  return graphCall({
    method: 'POST',
    path: `/${px}/events`,
    accessToken: metaToken(business),
    body: {
      data: [
        {
          event_name,
          event_time: Math.floor(Date.now() / 1000),
          event_id: event_id || `${event_name}_${Date.now()}`, // for dedup with browser pixel
          action_source: 'website',
          user_data: user_data || {},
          custom_data: event_data || {},
        },
      ],
    },
  });
}

// ─── Actuator: push ad-optimizer decisions to the live Meta account ──────────
// Gated by META_AD_LAUNCH_LIVE — dry-run (no API call) when off, so it ships safe.
async function updateCampaignStatus({ business, metaCampaignId, status }) {
  if (!metaCampaignId) return { ok: false, reason: 'metaCampaignId required' };
  const s = String(status).toUpperCase() === 'PAUSED' ? 'PAUSED' : 'ACTIVE';
  if (!adsLive(business)) {
    return { ok: true, dry_run: true, reason: DRY_RUN_REASON, metaCampaignId, status: s };
  }
  return graphCall({
    method: 'POST',
    path: `/${encodeURIComponent(metaCampaignId)}`,
    accessToken: metaToken(business),
    body: { status: s },
  });
}

async function updateCampaignBudget({ business, metaCampaignId, dailyBudgetCents }) {
  if (!metaCampaignId) return { ok: false, reason: 'metaCampaignId required' };
  const cents = Math.round(Number(dailyBudgetCents));
  if (!Number.isFinite(cents) || cents <= 0) return { ok: false, reason: 'invalid daily budget' };
  if (!adsLive(business)) {
    return { ok: true, dry_run: true, reason: DRY_RUN_REASON, metaCampaignId, daily_budget: cents };
  }
  return graphCall({
    method: 'POST',
    path: `/${encodeURIComponent(metaCampaignId)}`,
    accessToken: metaToken(business),
    body: { daily_budget: cents },
  });
}

module.exports = {
  isConfigured,
  createCampaign,
  createAdSet,
  createAd,
  createCampaignWithAdSetsAndAds,
  fetchInsights,
  fetchCampaignInsights,
  updateCampaign,
  fetchMeasurementHealth,
  sendConversionEvent,
  updateCampaignStatus,
  updateCampaignBudget,
  META_OBJECTIVE_MAP,
};
