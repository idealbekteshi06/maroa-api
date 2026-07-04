'use strict';

/**
 * services/competitor-ads/index.js — competitor winning-ad discovery →
 * creative recreation pipeline (2026-07).
 *
 * The Meta Ad Library exposes every competitor's live ads. The single best
 * public predictor of a winning ad is LONGEVITY: advertisers kill losers in
 * days, so an ad still running after 30/60/90 days is paying for itself.
 * findWinningAds ranks a competitor's ads by runtime (with an active bonus
 * and copy-quality tiebreaks) and buildRecreationBrief turns a winner into a
 * Marketing Studio video brief featuring the CUSTOMER's product — the Ad
 * Library never exposes raw video files, so recreation composes from the
 * ad's proven copy structure (hook, offer, CTA), not the video bytes.
 *
 * DI factory — deps: { metaAdLibrary, sbGet, logger }.
 */

const DAY_MS = 86400000;

function runtimeDays(ad, now = Date.now()) {
  const start = ad?.ad_delivery_start_time ? new Date(ad.ad_delivery_start_time).getTime() : null;
  if (!start || Number.isNaN(start)) return 0;
  const stopRaw = ad?.ad_delivery_stop_time ? new Date(ad.ad_delivery_stop_time).getTime() : null;
  const stop = stopRaw && !Number.isNaN(stopRaw) ? stopRaw : now;
  return Math.max(0, Math.round((stop - start) / DAY_MS));
}

function isActive(ad, now = Date.now()) {
  if (!ad?.ad_delivery_stop_time) return true;
  const stop = new Date(ad.ad_delivery_stop_time).getTime();
  return Number.isNaN(stop) || stop >= now;
}

/**
 * Longevity-first winner score. Active ads get a 1.25x boost (still spending
 * = still working); substantial copy beats bare link ads on tiebreaks.
 */
function scoreAd(ad, now = Date.now()) {
  const days = runtimeDays(ad, now);
  let score = Math.min(days, 365); // cap so ancient evergreen ads don't dominate absurdly
  if (isActive(ad, now)) score *= 1.25;
  const textLen = String(ad?.text || '').length;
  if (textLen > 80) score += 5;
  if (ad?.headline) score += 3;
  return Math.round(score * 100) / 100;
}

module.exports = function createCompetitorAds(deps = {}) {
  const { metaAdLibrary, sbGet, logger } = deps;

  /**
   * Find a competitor's winning ads, ranked by longevity.
   * When competitorName is omitted, sweeps the business's configured
   * competitors (up to 3) and merges results.
   */
  async function findWinningAds({ businessId, competitorName, country, limit = 10 }) {
    if (!metaAdLibrary?.search) return { ok: false, reason: 'ad_library_unavailable', ads: [] };

    let names = [];
    let resolvedCountry = country;
    if (competitorName) {
      names = [String(competitorName).slice(0, 100)];
    } else if (businessId && sbGet) {
      const rows = await sbGet(
        'businesses',
        `id=eq.${encodeURIComponent(businessId)}&select=competitors,country_code`
      ).catch(() => []);
      const biz = rows?.[0];
      names = (Array.isArray(biz?.competitors) ? biz.competitors : [])
        .map((c) => (typeof c === 'string' ? c : c?.name))
        .filter(Boolean)
        .slice(0, 3);
      if (!resolvedCountry) resolvedCountry = biz?.country_code || 'US';
    }
    if (!names.length) return { ok: true, ads: [], reason: 'no_competitors_configured' };

    const now = Date.now();
    const all = [];
    for (const name of names) {
      const ads = await metaAdLibrary
        .search({ search_terms: name, country: resolvedCountry || 'US', limit: 50 })
        .catch(() => []);
      for (const ad of ads || []) {
        // Ad Library keyword search is fuzzy — keep only ads actually run by
        // a page whose name matches the competitor (case-insensitive).
        const pageName = String(ad?.page_name || '').toLowerCase();
        if (!pageName.includes(String(name).toLowerCase().split(' ')[0])) continue;
        all.push({
          id: ad.id,
          competitor: name,
          page_name: ad.page_name,
          headline: ad.headline || null,
          text: String(ad.text || '').slice(0, 1000),
          description: ad.description || null,
          platforms: ad.platforms || [],
          url: ad.url,
          runtime_days: runtimeDays(ad, now),
          is_active: isActive(ad, now),
          winner_score: scoreAd(ad, now),
          started_at: ad.ad_delivery_start_time || null,
        });
      }
    }

    all.sort((a, b) => b.winner_score - a.winner_score);
    const top = all.slice(0, Math.min(Math.max(1, Number(limit) || 10), 25));
    logger?.info?.('/competitor-ads', businessId || null, `ranked ${all.length} ads, returning ${top.length}`);
    return { ok: true, ads: top, scanned: all.length };
  }

  /**
   * Turn a winning competitor ad into a Marketing Studio video brief for the
   * customer's own product. Explicitly instructs structure-borrowing, not
   * copy-theft: the proven scenario shape carries over, every claim must be
   * about the customer's product.
   */
  function buildRecreationBrief({ ad, business }) {
    const bizName = business?.business_name || 'the business';
    const lines = [
      `Create a short product marketing video for ${bizName}.`,
      `Model it on a proven competitor ad that has run for ${ad?.runtime_days || 'many'} days${ad?.is_active ? ' and is still running' : ''}:`,
    ];
    if (ad?.headline) lines.push(`- Their hook/headline: "${ad.headline}"`);
    if (ad?.text) lines.push(`- Their copy: "${String(ad.text).slice(0, 400)}"`);
    lines.push(
      '',
      'Borrow the STRUCTURE that makes this ad work — the hook mechanic, pacing,',
      'offer framing, and call-to-action placement — but every claim, product',
      `shot, and benefit must be about ${bizName}'s own product (shown in the`,
      'provided product images). Do not copy their brand name, slogans, or any',
      'verbatim sentence.'
    );
    return lines.join('\n');
  }

  return { findWinningAds, buildRecreationBrief, runtimeDays, isActive, scoreAd };
};
