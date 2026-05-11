'use strict';

/**
 * services/tiktok-marketing/index.js
 * ---------------------------------------------------------------------------
 * Real TikTok Marketing API client.
 *
 * Endpoint base: https://business-api.tiktok.com/open_api/v1.3
 *
 * Auth: per-business access_token (TikTok OAuth Business). Stored on
 * businesses table as tiktok_access_token + tiktok_advertiser_id.
 *
 * Methods we use:
 *   /campaign/create/         — Smart+ campaign create
 *   /adgroup/create/          — ad group create
 *   /ad/create/               — Spark Ads or In-Feed ad
 *   /report/integrated/get/   — campaign performance
 *   /tt_user/info/get/        — diagnostics ping
 *
 * Public API:
 *   isConfigured(business)
 *   listOrganicPosts({ business, limit })   — for Spark Ads selection
 *   fetchInsights({ business })             — campaign performance
 *   fetchEventsHealth({ business })         — Events API health probe
 *   createSmartPlusCampaign({ business, payload })
 * ---------------------------------------------------------------------------
 */

const HOST = 'business-api.tiktok.com';
const VERSION = 'v1.3';
const TIKTOK_ADS_LIVE = () => String(process.env.TIKTOK_ADS_LIVE || '').toLowerCase() === 'true';

function isConfigured(business) {
  return !!(business?.tiktok_access_token && business?.tiktok_advertiser_id);
}

async function tiktokCall({ method, path, business, body, query }) {
  if (!isConfigured(business)) return { ok: false, reason: 'tiktok not configured for this business' };
  const params = query ? `?${new URLSearchParams(query).toString()}` : '';
  const url = `https://${HOST}/open_api/${VERSION}${path}${params}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Access-Token': business.tiktok_access_token,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || (typeof json?.code === 'number' && json.code !== 0)) {
      return {
        ok: false,
        status: res.status,
        reason: json?.message || `HTTP ${res.status}`,
        raw: json,
      };
    }
    return { ok: true, raw: json };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ─── Organic posts (for Spark Ads selection) ────────────────────────────

async function listOrganicPosts({ business, limit = 50 }) {
  // TikTok exposes organic posts via the Display API + Posts endpoint.
  // For business accounts, we use /post/list/ on the business-api.
  const r = await tiktokCall({
    method: 'GET',
    path: '/post/list/',
    business,
    query: {
      advertiser_id: business.tiktok_advertiser_id,
      page_size: String(Math.min(limit, 50)),
      include_metrics: 'true',
    },
  });
  if (!r.ok) return [];
  const data = r.raw?.data?.list || [];
  return data.map((p) => ({
    id: p.item_id || p.id,
    caption: p.description || p.title || '',
    views: Number(p.view_count) || 0,
    likes: Number(p.like_count) || 0,
    comments: Number(p.comment_count) || 0,
    shares: Number(p.share_count) || 0,
    completion_rate: typeof p.completion_rate === 'number' ? p.completion_rate : 0.1,
    posted_at: p.create_time,
  }));
}

// ─── Insights (campaign performance) ────────────────────────────────────

async function fetchInsights({ business, since, until }) {
  const start = since || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const end = until || new Date().toISOString().slice(0, 10);

  const r = await tiktokCall({
    method: 'GET',
    path: '/report/integrated/get/',
    business,
    query: {
      advertiser_id: business.tiktok_advertiser_id,
      report_type: 'BASIC',
      data_level: 'AUCTION_CAMPAIGN',
      dimensions: JSON.stringify(['campaign_id']),
      metrics: JSON.stringify([
        'spend',
        'impressions',
        'clicks',
        'ctr',
        'cpc',
        'conversion',
        'cost_per_conversion',
        'conversion_rate',
      ]),
      start_date: start,
      end_date: end,
      page_size: '100',
    },
  });
  if (!r.ok) return { ok: false, reason: r.reason, campaigns: [] };

  const list = r.raw?.data?.list || [];
  const campaigns = list.map((row) => {
    const dim = row.dimensions || {};
    const m = row.metrics || {};
    const spend = Number(m.spend) || 0;
    const conversions = Number(m.conversion) || 0;
    return {
      id: dim.campaign_id,
      spend,
      clicks: Number(m.clicks) || 0,
      impressions: Number(m.impressions) || 0,
      ctr: Number(m.ctr) || null,
      cpc: Number(m.cpc) || null,
      conversions,
      conversions_30d: conversions,
      cpa: Number(m.cost_per_conversion) || null,
      roas: null, // TikTok doesn't return revenue in this endpoint
      in_learning: false,
      target_cpa: null,
    };
  });
  return { ok: true, campaigns };
}

async function fetchEventsHealth({ business }) {
  // Quick ping — just confirms credentials work and returns a count of
  // events seen in the last 24h via /event/source/get/ (where available).
  const r = await tiktokCall({
    method: 'GET',
    path: '/event/source/get/',
    business,
    query: { advertiser_id: business.tiktok_advertiser_id },
  });
  if (!r.ok) return { events_api_health: 'error', events_24h: 0, raw: r };
  const sources = r.raw?.data?.event_sources || [];
  const totalEvents = sources.reduce((acc, s) => acc + (Number(s.event_count_24h) || 0), 0);
  return {
    events_api_health: sources.length > 0 ? 'ok' : 'no_sources',
    events_24h: totalEvents,
    raw: { source_count: sources.length },
  };
}

// ─── Smart+ campaign create (gated behind TIKTOK_ADS_LIVE) ──────────────

async function createSmartPlusCampaign({ business, payload }) {
  if (!TIKTOK_ADS_LIVE()) {
    return { ok: true, dry_run: true, campaign_id: `dry_run_${Date.now()}` };
  }
  return tiktokCall({
    method: 'POST',
    path: '/campaign/create/',
    business,
    body: {
      advertiser_id: business.tiktok_advertiser_id,
      campaign_name: payload.name,
      objective_type: payload.objective || 'CONVERSIONS',
      budget: Number(payload.daily_budget || 50),
      budget_mode: 'BUDGET_MODE_DAY',
      // Smart+ uses simplified delivery
      operation_status: 'DISABLE', // PAUSED equivalent
      app_promotion_type: 'NORMAL',
    },
  });
}

module.exports = {
  isConfigured,
  listOrganicPosts,
  fetchInsights,
  fetchEventsHealth,
  createSmartPlusCampaign,
};
