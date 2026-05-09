'use strict';

/**
 * services/competitor-watch/index.js
 * ---------------------------------------------------------------------------
 * Competitor War Room — auto-detect when a competitor scales, launches a
 * new ad, pauses an existing one, or invades our keyword space. React in
 * <4h instead of waiting for a human's monthly competitor review.
 *
 * Sources:
 *   - Meta Ad Library API (free, official) — competitor active ads
 *   - Google Auction Insights API (free with Google Ads) — bid pressure
 *   - SerpAPI — SERP position changes
 *   - TikTok Creative Center (scraped — fallback)
 *
 * Decision rules:
 *   - new_ad_launched (severity: watch) — log, no action
 *   - new_ad_launched + same audience as our top campaign (severity: alert)
 *     → flag for creative refresh (existing maroa-ad-auditor decision)
 *   - spend_increase >50% week-over-week on top competitor (severity: alert)
 *     → consider matching (advisor recommends)
 *   - keyword_overlap > 30% on Google Auction Insights (severity: critical)
 *     → escalate to human review (creates pacing-alerts entry)
 *
 * Public API:
 *   scanForBusiness({ businessId })            — pull all sources, log signals
 *   detectChanges({ before, after, source })   — pure diff function
 *   classifyChange(change)                     — assigns signal_type + severity
 *   compileWarRoomBriefing({ businessId, days = 7 }) — daily customer brief
 * ---------------------------------------------------------------------------
 */

const SPEND_INCREASE_ALERT_THRESHOLD = 0.50;        // +50% WoW = alert
const KEYWORD_OVERLAP_CRITICAL_THRESHOLD = 0.30;    // 30%+ overlap = critical
const NEW_AD_AGE_HOURS = 6;                         // ad seen for first time within last 6h

// ─── Pure diff: before / after snapshot → list of changes ────────────────

function detectChanges({ before, after, source }) {
  const changes = [];
  const beforeMap = new Map((before || []).map((a) => [a.id || a.ad_id || a.url, a]));
  const afterMap = new Map((after || []).map((a) => [a.id || a.ad_id || a.url, a]));

  // New ads
  for (const [key, ad] of afterMap) {
    if (!beforeMap.has(key)) {
      changes.push({
        signal_type: 'new_ad_launched',
        source,
        payload: { ad },
      });
    }
  }
  // Paused ads (in before but not after)
  for (const [key, ad] of beforeMap) {
    if (!afterMap.has(key)) {
      changes.push({
        signal_type: 'ad_paused',
        source,
        payload: { ad },
      });
    }
  }
  return changes;
}

function classifyChange(change, context = {}) {
  const { signal_type, payload } = change;

  if (signal_type === 'new_ad_launched') {
    // If the new ad's audience overlaps with our top campaign's audience,
    // bump severity. Otherwise it's just `watch`.
    const overlap = audienceOverlap(payload?.ad?.audience, context.ourTopAudience);
    if (overlap > 0.6) {
      return {
        ...change,
        severity: 'alert',
        confidence: Math.min(0.5 + overlap * 0.4, 0.95),
        reason: `New competitor ad overlaps ${Math.round(overlap * 100)}% with our top audience`,
      };
    }
    return { ...change, severity: 'watch', confidence: 0.7, reason: 'New competitor ad detected' };
  }

  if (signal_type === 'spend_increase') {
    const delta = Number(payload?.spend_delta_pct || 0);
    if (delta >= SPEND_INCREASE_ALERT_THRESHOLD) {
      return { ...change, severity: 'alert', confidence: 0.8, reason: `Competitor spend +${(delta * 100).toFixed(0)}% WoW` };
    }
    return { ...change, severity: 'info', confidence: 0.6, reason: 'Minor competitor spend shift' };
  }

  if (signal_type === 'keyword_overlap') {
    const overlap = Number(payload?.overlap_pct || 0);
    if (overlap >= KEYWORD_OVERLAP_CRITICAL_THRESHOLD) {
      return { ...change, severity: 'critical', confidence: 0.9, reason: `${Math.round(overlap * 100)}% keyword overlap with competitor — direct bid pressure` };
    }
    return { ...change, severity: 'watch', confidence: 0.7, reason: `${Math.round(overlap * 100)}% keyword overlap — monitor` };
  }

  return { ...change, severity: 'info', confidence: 0.5 };
}

function audienceOverlap(a, b) {
  if (!a || !b) return 0;
  if (typeof a === 'string' && typeof b === 'string') {
    return a.toLowerCase() === b.toLowerCase() ? 1.0 : 0.0;
  }
  // Set-overlap on interest tags or location strings.
  const aSet = new Set(Array.isArray(a) ? a.map((x) => String(x).toLowerCase()) : []);
  const bSet = new Set(Array.isArray(b) ? b.map((x) => String(x).toLowerCase()) : []);
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let intersect = 0;
  for (const x of aSet) if (bSet.has(x)) intersect += 1;
  return intersect / Math.max(aSet.size, bSet.size);
}

// ─── Source adapter: Meta Ad Library ────────────────────────────────────

async function fetchMetaAdLibrary({ competitorName, country = 'US', deps }) {
  const { metaAdLibraryApi } = deps || {};
  if (!metaAdLibraryApi?.search) return [];
  try {
    return await metaAdLibraryApi.search({
      search_terms: competitorName,
      ad_reached_countries: [country],
      ad_active_status: 'ACTIVE',
      limit: 50,
    });
  } catch {
    return [];
  }
}

// ─── Public: scan all sources for a business ────────────────────────────

async function scanForBusiness({ businessId, deps }) {
  const { sbGet, sbPost, logger } = deps;

  const businessRows = await sbGet('businesses', `id=eq.${businessId}&select=competitors,country_code`).catch(() => []);
  const business = businessRows?.[0];
  if (!business || !Array.isArray(business.competitors) || business.competitors.length === 0) {
    return { ok: true, scanned: 0, signals: [], reason: 'no competitors configured' };
  }

  const country = business.country_code || 'US';
  const allSignals = [];

  for (const comp of business.competitors.slice(0, 5)) {
    const competitorName = typeof comp === 'string' ? comp : comp?.name;
    if (!competitorName) continue;

    // Fetch the most recent prior snapshot
    const priorRows = await sbGet('competitor_signals',
      `business_id=eq.${businessId}&competitor_name=eq.${encodeURIComponent(competitorName)}&source=eq.meta_ad_library&order=observed_at.desc&limit=1&select=signal_payload`
    ).catch(() => []);
    const priorAds = priorRows?.[0]?.signal_payload?.ads_snapshot || [];

    const currentAds = await fetchMetaAdLibrary({ competitorName, country, deps });

    // Snapshot the current state for next run's diff
    if (currentAds.length > 0) {
      await sbPost('competitor_signals', {
        business_id: businessId,
        competitor_name: competitorName,
        source: 'meta_ad_library',
        signal_type: 'new_creative',  // generic snapshot signal
        signal_payload: { ads_snapshot: currentAds.slice(0, 50) },
        severity: 'info',
      }).catch(() => {});
    }

    // Diff and persist real change signals
    const changes = detectChanges({ before: priorAds, after: currentAds, source: 'meta_ad_library' });
    for (const c of changes) {
      const classified = classifyChange(c, { ourTopAudience: null });
      await sbPost('competitor_signals', {
        business_id: businessId,
        competitor_name: competitorName,
        source: 'meta_ad_library',
        signal_type: classified.signal_type,
        signal_payload: classified.payload || {},
        severity: classified.severity,
        confidence: classified.confidence,
      }).catch((e) => logger?.warn?.('competitor-watch.scan', businessId, 'persist failed', { error: e.message }));
      allSignals.push(classified);
    }
  }

  return { ok: true, scanned: business.competitors.length, signals: allSignals };
}

async function compileWarRoomBriefing({ businessId, days = 7, deps }) {
  const { sbGet } = deps;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const signals = await sbGet('competitor_signals',
    `business_id=eq.${businessId}&observed_at=gte.${since}&order=observed_at.desc&limit=200&select=*`
  ).catch(() => []);

  const byCompetitor = {};
  let alerts = 0;
  let critical = 0;
  for (const s of signals) {
    const key = s.competitor_name;
    if (!byCompetitor[key]) byCompetitor[key] = { count: 0, severities: {}, latest: null };
    byCompetitor[key].count += 1;
    byCompetitor[key].severities[s.severity] = (byCompetitor[key].severities[s.severity] || 0) + 1;
    if (!byCompetitor[key].latest || new Date(s.observed_at) > new Date(byCompetitor[key].latest)) {
      byCompetitor[key].latest = s.observed_at;
    }
    if (s.severity === 'alert') alerts += 1;
    if (s.severity === 'critical') critical += 1;
  }

  return {
    business_id: businessId,
    window_days: days,
    competitors_tracked: Object.keys(byCompetitor).length,
    total_signals: signals.length,
    alerts,
    critical,
    by_competitor: byCompetitor,
  };
}

module.exports = {
  scanForBusiness,
  detectChanges,
  classifyChange,
  audienceOverlap,
  compileWarRoomBriefing,
  SPEND_INCREASE_ALERT_THRESHOLD,
  KEYWORD_OVERLAP_CRITICAL_THRESHOLD,
};
