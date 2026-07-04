'use strict';

/**
 * routes/competitor-ads.js — competitor winning-ad discovery + one-click
 * recreation (2026-07).
 *
 *   GET  /webhook/competitor-ads-search    — a competitor's live ads ranked
 *                                            by longevity (winner proxy)
 *   POST /webhook/competitor-ad-make-version — turn a winning competitor ad
 *                                            into a marketing video featuring
 *                                            the customer's product
 *
 * /webhook/* rides the global JWT + owner middleware; the generation POST is
 * costGuard-gated in server.js. The Ad Library never exposes raw video
 * files, so recreation composes from the winning ad's proven structure
 * (hook/offer/CTA) — see services/competitor-ads buildRecreationBrief.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (v) => typeof v === 'string' && UUID_RE.test(v);

function register({ app, competitorAds, higgsfieldAI, sbGet, apiError, logger }) {
  if (!app || !competitorAds) throw new Error('competitor-ads routes: app + competitorAds required');

  app.get('/webhook/competitor-ads-search', async (req, res) => {
    const businessId = req.query?.business_id;
    if (!isUUID(businessId)) return apiError(res, 400, 'INVALID_BUSINESS_ID', 'business_id (UUID) required');
    try {
      const result = await competitorAds.findWinningAds({
        businessId,
        competitorName: typeof req.query?.competitor === 'string' ? req.query.competitor.slice(0, 100) : undefined,
        country: typeof req.query?.country === 'string' ? req.query.country.slice(0, 2).toUpperCase() : undefined,
        limit: Number(req.query?.limit) || 10,
      });
      res.json(result);
    } catch (e) {
      logger?.error?.('/webhook/competitor-ads-search', businessId, e.message);
      apiError(res, 500, 'COMPETITOR_ADS_SEARCH_FAILED', 'Competitor ad search failed');
    }
  });

  app.post('/webhook/competitor-ad-make-version', async (req, res) => {
    const businessId = req.body?.businessId || req.body?.business_id;
    if (!isUUID(businessId)) return apiError(res, 400, 'INVALID_BUSINESS_ID', 'businessId (UUID) required');
    const ad = req.body?.ad;
    if (!ad || typeof ad !== 'object' || (!ad.text && !ad.headline)) {
      return apiError(res, 400, 'AD_REQUIRED', 'ad object with text and/or headline required');
    }
    try {
      const bizRows = await sbGet(
        'businesses',
        `id=eq.${encodeURIComponent(businessId)}&select=business_name,product_image_urls`
      ).catch(() => []);
      const business = bizRows?.[0] || {};
      const prompt = competitorAds.buildRecreationBrief({
        ad: {
          headline: typeof ad.headline === 'string' ? ad.headline.slice(0, 200) : null,
          text: typeof ad.text === 'string' ? ad.text.slice(0, 1000) : null,
          runtime_days: Number(ad.runtime_days) || null,
          is_active: !!ad.is_active,
        },
        business,
      });
      const imageUrls = (Array.isArray(req.body?.imageUrls) ? req.body.imageUrls : business.product_image_urls || [])
        .filter((u) => typeof u === 'string' && u.length < 2048)
        .slice(0, 6);
      const result = await higgsfieldAI.generateMarketingVideo({
        businessId,
        prompt,
        mode: typeof req.body?.mode === 'string' ? req.body.mode : 'ugc',
        imageUrls,
        aspectRatio: '9:16',
      });
      res.status(result.ok ? 200 : 502).json({ ...result, brief: prompt });
    } catch (e) {
      logger?.error?.('/webhook/competitor-ad-make-version', businessId, e.message);
      apiError(res, 500, 'MAKE_VERSION_FAILED', 'Ad recreation failed');
    }
  });
}

module.exports = { register };
