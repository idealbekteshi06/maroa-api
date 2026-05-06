'use strict';

/**
 * services/voc/engine.js
 * ----------------------------------------------------------------------------
 * Voice-of-Customer orchestrator.
 *
 * Two modes:
 *   1. Pre-fetched: caller passes { google, facebook, instagram, email } arrays
 *   2. Self-fetch: caller passes only { businessId } — engine fetches via
 *      injected serpSearch / apiRequest helpers (Meta Graph + Google Reviews)
 *
 * Self-fetch is best-effort: if a source is unavailable (no FB token, no Gmail
 * OAuth, etc.), it's silently skipped. The synthesis runs on whatever was
 * collected. Caveats surface what wasn't fetched.
 * ----------------------------------------------------------------------------
 */

const voc = require('../prompts/voc');

function createEngine(deps) {
  const {
    sbGet, sbPost, sbPatch,
    callClaude, extractJSON,
    serpSearch, apiRequest,
    logger, Sentry,
  } = deps;
  if (!sbGet || !sbPost || !sbPatch) throw new Error('voc engine: sbGet/sbPost/sbPatch required');
  if (!callClaude || !extractJSON)     throw new Error('voc engine: callClaude + extractJSON required');

  // ─── Source fetchers (best-effort, may be no-ops if helpers missing) ──

  async function _fetchGoogleReviews({ business }) {
    if (typeof serpSearch !== 'function') return [];
    if (!business?.business_name && !business?.location) return [];
    const query = business.google_business_id
      ? `place_id:${business.google_business_id}`
      : `${business.business_name} ${business.location || ''} reviews`;
    try {
      const r = await serpSearch({ engine: 'google_maps', q: query, num: 50 });
      const placeReviews = r?.place_results?.user_reviews
        || r?.local_results?.[0]?.reviews
        || [];
      // Normalize SerpAPI shape
      return Array.isArray(placeReviews) ? placeReviews.map(rv => ({
        review_id: rv.review_id || rv.id,
        snippet: rv.snippet || rv.text || rv.description,
        rating: rv.rating,
        iso_date: rv.iso_date || rv.date,
        user: rv.user,
      })) : [];
    } catch (e) {
      logger?.warn?.('voc.fetchGoogleReviews', business.id, e?.message);
      return [];
    }
  }

  async function _fetchFacebookReviews({ business }) {
    if (typeof apiRequest !== 'function') return [];
    if (!business?.facebook_page_id || !business?.meta_access_token) return [];
    try {
      const r = await apiRequest({
        method: 'GET',
        url: `https://graph.facebook.com/v19.0/${business.facebook_page_id}/ratings?access_token=${business.meta_access_token}&fields=created_time,recommendation_type,review_text,reviewer&limit=50`,
      });
      return r?.data || [];
    } catch (e) {
      logger?.warn?.('voc.fetchFacebookReviews', business.id, e?.message);
      return [];
    }
  }

  async function _fetchInstagramComments({ business, recentPostIds }) {
    if (typeof apiRequest !== 'function') return [];
    if (!business?.instagram_account_id || !business?.meta_access_token) return [];
    if (!Array.isArray(recentPostIds) || !recentPostIds.length) return [];
    const out = [];
    for (const postId of recentPostIds.slice(0, 10)) {
      try {
        const r = await apiRequest({
          method: 'GET',
          url: `https://graph.facebook.com/v19.0/${postId}/comments?access_token=${business.meta_access_token}&limit=20`,
        });
        if (r?.data) out.push(...r.data);
      } catch (e) {
        logger?.warn?.('voc.fetchInstagramComments', business.id, e?.message);
      }
    }
    return out;
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Pre-fetched mode. Caller has already gathered the source data.
   */
  async function synthesize({ businessId, google, facebook, instagram, email, knownCompetitors }) {
    const tx = Sentry?.startTransaction?.({ name: 'voc.synthesize' });
    try {
      const [bizRows, profileRows] = await Promise.all([
        sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
        sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
      ]);
      const business = { ...(bizRows[0] || {}), ...(profileRows[0] || {}) };
      if (!business?.id && !business?.user_id) throw new Error(`business ${businessId} not found`);

      const competitorList = knownCompetitors
        || (Array.isArray(business.competitors) ? business.competitors : []);

      const result = await voc.synthesizeVoc({
        business,
        google, facebook, instagram, email,
        plan: business.plan || 'free',
        knownCompetitors: competitorList,
        callClaude, extractJSON, logger,
      });

      // Persist
      await sbPost('voc_analyses', {
        business_id: businessId,
        analyzed_at: new Date().toISOString(),
        source_count: result.source_count,
        total_reviews_analyzed: result.total_reviews_analyzed,
        primary_language: result.primary_language,
        review_languages_detected: result.review_languages_detected,
        pain_points: result.pain_points,
        jtbd_signals: result.jtbd_signals,
        persona_refinement: result.persona_refinement,
        sentiment: result.sentiment,
        competitor_mentions: result.competitor_mentions,
        recommendations_for_marketing: result.recommendations_for_marketing,
        data_quality: result.data_quality,
        caveats: result.caveats,
        short_circuited: !!result.short_circuited,
        short_circuit_reason: result.short_circuit_reason || null,
        plan_used: business.plan || 'free',
      }).catch((e) => logger?.warn?.('voc', businessId, 'persist failed', e));

      return result;
    } catch (e) {
      Sentry?.captureException?.(e);
      throw e;
    } finally {
      tx?.finish?.();
    }
  }

  /**
   * Self-fetch mode. Engine pulls from available sources before synthesis.
   */
  async function fetchAndSynthesize({ businessId, knownCompetitors, recentPostIds }) {
    const [bizRows, profileRows] = await Promise.all([
      sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
    ]);
    const business = { ...(bizRows[0] || {}), ...(profileRows[0] || {}) };

    const [google, facebook, instagram] = await Promise.all([
      _fetchGoogleReviews({ business }),
      _fetchFacebookReviews({ business }),
      _fetchInstagramComments({ business, recentPostIds }),
    ]);

    return synthesize({
      businessId,
      google, facebook, instagram,
      email: [], // gmail integration deferred
      knownCompetitors,
    });
  }

  return { synthesize, fetchAndSynthesize };
}

module.exports = createEngine;
