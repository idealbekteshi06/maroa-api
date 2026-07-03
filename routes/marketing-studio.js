'use strict';

/**
 * routes/marketing-studio.js — Higgsfield Marketing Studio surface (2026-07).
 *
 * Endpoints backing the Studio's DTC-ads upgrade + the competitor-watch →
 * creative pipeline:
 *
 *   GET  /webhook/studio-image-styles     — ms_image style catalog (picker)
 *   GET  /webhook/studio-video-presets    — marketing-video format catalog
 *   POST /webhook/studio-brand-kit-sync   — logo/colors/products → brand kit
 *   POST /webhook/studio-dtc-image        — brand-kit-aware DTC ad image
 *   POST /webhook/studio-marketing-video  — one-click product video
 *                                           (hooks/settings or ad_reference)
 *   POST /webhook/studio-recreate-ad      — reference video (e.g. winning
 *                                           competitor ad) → customer's
 *                                           product in that proven scenario
 *
 * /webhook/* rides the global JWT + owner middleware; the three generation
 * POSTs additionally get costGuard mounted in server.js. Higgsfield
 * degradation is soft — endpoints return { ok:false, reason } instead of 500
 * when a Marketing Studio endpoint isn't enabled on the account yet.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (v) => typeof v === 'string' && UUID_RE.test(v);

function register({ app, higgsfieldAI, sbGet, apiError, logger }) {
  const ms = higgsfieldAI?.marketingStudio;
  if (!app || !ms) throw new Error('marketing-studio routes: app + higgsfieldAI.marketingStudio required');

  const bizIdOf = (req) => req.body?.businessId || req.body?.business_id || req.query?.business_id;

  function requireBiz(req, res) {
    const businessId = bizIdOf(req);
    if (!isUUID(businessId)) {
      apiError(res, 400, 'INVALID_BUSINESS_ID', 'businessId (UUID) required');
      return null;
    }
    return businessId;
  }

  const strArr = (v, max) =>
    (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x.length < 2048).slice(0, max);

  app.get('/webhook/studio-image-styles', async (_req, res) => {
    res.json(await ms.listImageStyles());
  });

  app.get('/webhook/studio-video-presets', async (_req, res) => {
    res.json(await ms.listVideoPresets());
  });

  app.post('/webhook/studio-brand-kit-sync', async (req, res) => {
    const businessId = requireBiz(req, res);
    if (!businessId) return;
    try {
      const kitId = await ms.ensureBrandKit({ businessId });
      res.json(kitId ? { ok: true, brand_kit_id: kitId } : { ok: false, reason: 'brand_kit_unavailable' });
    } catch (e) {
      logger?.error?.('/webhook/studio-brand-kit-sync', businessId, e.message);
      apiError(res, 500, 'BRAND_KIT_SYNC_FAILED', 'Brand kit sync failed');
    }
  });

  app.post('/webhook/studio-dtc-image', async (req, res) => {
    const businessId = requireBiz(req, res);
    if (!businessId) return;
    const { prompt, styleId, style_id, aspectRatio, resolution, quality, batchSize } = req.body || {};
    const style = styleId || style_id;
    if (!style || typeof style !== 'string') {
      return apiError(
        res,
        400,
        'STYLE_REQUIRED',
        'styleId is required — list options via /webhook/studio-image-styles'
      );
    }
    try {
      const result = await ms.generateDtcAdImage({
        businessId,
        prompt: typeof prompt === 'string' ? prompt.slice(0, 4000) : '',
        styleId: style,
        productIds: strArr(req.body?.productIds, 4),
        imageUrls: strArr(req.body?.imageUrls, 14),
        aspectRatio: typeof aspectRatio === 'string' ? aspectRatio : undefined,
        resolution: typeof resolution === 'string' ? resolution : undefined,
        quality: typeof quality === 'string' ? quality : undefined,
        batchSize,
      });
      res.status(result.ok ? 200 : 502).json(result);
    } catch (e) {
      logger?.error?.('/webhook/studio-dtc-image', businessId, e.message);
      apiError(res, 500, 'DTC_IMAGE_FAILED', 'DTC ad image generation failed');
    }
  });

  app.post('/webhook/studio-marketing-video', async (req, res) => {
    const businessId = requireBiz(req, res);
    if (!businessId) return;
    const { prompt, mode, hookId, settingId, adReferenceId, aspectRatio, resolution, generateAudio } = req.body || {};
    try {
      const result = await ms.generateMarketingVideo({
        businessId,
        prompt: typeof prompt === 'string' ? prompt.slice(0, 4000) : '',
        mode: typeof mode === 'string' ? mode : undefined,
        productIds: strArr(req.body?.productIds, 4),
        avatarIds: strArr(req.body?.avatarIds, 1),
        imageUrls: strArr(req.body?.imageUrls, 6),
        hookId: typeof hookId === 'string' ? hookId : undefined,
        settingId: typeof settingId === 'string' ? settingId : undefined,
        adReferenceId: typeof adReferenceId === 'string' ? adReferenceId : undefined,
        aspectRatio: typeof aspectRatio === 'string' ? aspectRatio : undefined,
        resolution: typeof resolution === 'string' ? resolution : undefined,
        generateAudio: generateAudio !== false,
      });
      res.status(result.ok ? 200 : 502).json(result);
    } catch (e) {
      logger?.error?.('/webhook/studio-marketing-video', businessId, e.message);
      apiError(res, 500, 'MARKETING_VIDEO_FAILED', 'Marketing video generation failed');
    }
  });

  app.post('/webhook/studio-recreate-ad', async (req, res) => {
    const businessId = requireBiz(req, res);
    if (!businessId) return;
    const { referenceVideoUrl, reference_video_url, prompt } = req.body || {};
    const refUrl = referenceVideoUrl || reference_video_url;
    if (typeof refUrl !== 'string' || !/^https?:\/\//i.test(refUrl)) {
      return apiError(res, 400, 'REFERENCE_URL_REQUIRED', 'referenceVideoUrl (http/https) required');
    }
    try {
      // Default product imagery from the business profile when none passed —
      // "recreate this competitor ad with MY product" should be one click.
      let imageUrls = strArr(req.body?.imageUrls, 6);
      if (!imageUrls.length && sbGet) {
        const rows = await sbGet(
          'businesses',
          `id=eq.${encodeURIComponent(businessId)}&select=product_image_urls`
        ).catch(() => []);
        imageUrls = strArr(rows?.[0]?.product_image_urls, 6);
      }
      const result = await ms.recreateAdForBusiness({
        businessId,
        referenceVideoUrl: refUrl,
        productIds: strArr(req.body?.productIds, 4),
        imageUrls,
        prompt: typeof prompt === 'string' ? prompt.slice(0, 4000) : '',
      });
      res.status(result.ok ? 200 : 502).json(result);
    } catch (e) {
      logger?.error?.('/webhook/studio-recreate-ad', businessId, e.message);
      apiError(res, 500, 'RECREATE_AD_FAILED', 'Ad recreation failed');
    }
  });
}

module.exports = { register };
