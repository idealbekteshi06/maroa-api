'use strict';

/**
 * services/higgsfield/marketingStudio.js — Higgsfield Marketing Studio line
 * (2026-07 integration).
 *
 * Wraps the Marketing Studio product surface:
 *   - Brand kits      — logo + colors + fonts + tone folded into every prompt
 *                       (first-party replacement for the migration-088 "logo
 *                       as soft prompt cue" workaround)
 *   - DTC ad images   — ms_image: brand-kit-aware, style-driven ad creatives
 *   - Marketing video — one-click product ads (TikTok/Reels ready, 12–15s)
 *                       with hooks ("object flies into frame"), settings
 *                       ("sunlit kitchen"), avatars, product refs
 *   - Ad references   — "recreate this ad": a reference video's analyzed
 *                       scenario (composition, pacing, hook, narration)
 *                       drives the new video. This is the competitor-watch →
 *                       creative pipeline: winning competitor ad in, the
 *                       customer's product in that proven scenario out.
 *
 * Every endpoint path is env-overridable (HIGGSFIELD_PATH_MS_*) following the
 * service's established pattern, and every call degrades gracefully with a
 * reason code — a 404 from a not-yet-enabled endpoint must never break WF1 or
 * Studio (launch-gap rule: Higgsfield degradation is soft).
 *
 * DI factory — index.js injects hfPost/hfGet/submitVideoAndWait/etc.
 */

module.exports = function createMarketingStudio(deps) {
  const { hfPost, hfGet, submitVideoAndWait, submitImageAndWait, sbGet, sbPatch, logger } = deps;
  if (!hfPost || !hfGet) throw new Error('marketingStudio: hfPost + hfGet required');

  const PATH_MS_IMAGE = process.env.HIGGSFIELD_PATH_MS_IMAGE || '/higgsfield-ai/marketing-studio/image';
  const PATH_MS_VIDEO = process.env.HIGGSFIELD_PATH_MS_VIDEO || '/higgsfield-ai/marketing-studio/video';
  const PATH_BRAND_KITS = process.env.HIGGSFIELD_PATH_BRAND_KITS || '/marketing-studio/brand-kits';
  const PATH_AD_REFERENCES = process.env.HIGGSFIELD_PATH_AD_REFERENCES || '/marketing-studio/ad-references';
  const PATH_MS_PRODUCTS = process.env.HIGGSFIELD_PATH_MS_PRODUCTS || '/marketing-studio/products';
  const PATH_MS_IMAGE_STYLES = process.env.HIGGSFIELD_PATH_MS_IMAGE_STYLES || '/marketing-studio/image-styles';
  const PATH_MS_VIDEO_PRESETS = process.env.HIGGSFIELD_PATH_MS_VIDEO_PRESETS || '/marketing-studio/video-presets';

  const log = (msg, extra) => logger?.info?.('/higgsfield/marketing-studio', null, msg, extra);
  const warn = (msg, extra) => logger?.warn?.('/higgsfield/marketing-studio', null, msg, extra);

  /** Normalize a degradation result — callers branch on `ok`. */
  function degraded(reason, detail) {
    warn(`degraded: ${reason}`, { detail: String(detail || '').slice(0, 300) });
    return { ok: false, reason, detail: detail ? String(detail).slice(0, 300) : undefined };
  }

  function isNotEnabled(resp) {
    return resp && (resp.status === 404 || resp.status === 405 || resp.status === 501);
  }

  // ─── Brand kits ──────────────────────────────────────────────────────────

  /**
   * Ensure the business has a Higgsfield brand kit and return its id.
   * Reads businesses.higgsfield_brand_kit_id first; otherwise creates a kit
   * from logo_url + product_image_urls + brand fields and persists the id
   * (migration 099). Returns null (never throws) when the endpoint isn't
   * enabled — callers fall back to the logo-overlay path.
   */
  async function ensureBrandKit({ businessId, business = null }) {
    if (!businessId) return null;
    try {
      const rows = business
        ? [business]
        : await sbGet(
            'businesses',
            `id=eq.${encodeURIComponent(businessId)}&select=id,business_name,industry,logo_url,product_image_urls,brand_colors,brand_tone,higgsfield_brand_kit_id`
          );
      const biz = rows?.[0];
      if (!biz) return null;
      if (biz.higgsfield_brand_kit_id) return biz.higgsfield_brand_kit_id;

      const payload = {
        name: `${biz.business_name || 'Business'} brand kit`,
        logo_url: biz.logo_url || undefined,
        image_urls: Array.isArray(biz.product_image_urls) ? biz.product_image_urls.slice(0, 8) : undefined,
        colors: biz.brand_colors || undefined,
        tone: biz.brand_tone || undefined,
        industry: biz.industry || undefined,
      };
      const resp = await hfPost(PATH_BRAND_KITS, payload, 60000);
      if (isNotEnabled(resp)) return null;
      const kitId = resp?.body?.id || resp?.body?.brand_kit_id || null;
      if (resp.status >= 200 && resp.status < 300 && kitId) {
        await sbPatch('businesses', `id=eq.${encodeURIComponent(businessId)}`, {
          higgsfield_brand_kit_id: kitId,
        }).catch(() => {});
        log('brand kit created', { businessId, kitId });
        return kitId;
      }
      return null;
    } catch (e) {
      warn('ensureBrandKit failed (soft)', { error: e.message });
      return null;
    }
  }

  // ─── Products ────────────────────────────────────────────────────────────

  /**
   * Register a product in Marketing Studio (server pre-resolves media + IP
   * check). Returns { ok, productId } or a degraded result.
   */
  async function importProduct({ name, imageUrls = [], description }) {
    try {
      const resp = await hfPost(
        PATH_MS_PRODUCTS,
        { name, image_urls: imageUrls.slice(0, 6), description: description || undefined },
        60000
      );
      if (isNotEnabled(resp)) return degraded('ms_products_endpoint_pending');
      const productId = resp?.body?.id || resp?.body?.product_id || null;
      if (resp.status >= 200 && resp.status < 300 && productId) return { ok: true, productId };
      return degraded('ms_product_create_failed', JSON.stringify(resp.body || {}));
    } catch (e) {
      return degraded('ms_product_create_error', e.message);
    }
  }

  // ─── Catalog listings (for frontend pickers) ─────────────────────────────

  async function listImageStyles() {
    try {
      const resp = await hfGet(PATH_MS_IMAGE_STYLES, 30000);
      if (isNotEnabled(resp)) return { ok: false, reason: 'ms_styles_endpoint_pending', styles: [] };
      const styles = resp?.body?.items || resp?.body?.styles || (Array.isArray(resp?.body) ? resp.body : []);
      return { ok: true, styles };
    } catch (e) {
      return { ok: false, reason: 'ms_styles_error', styles: [], detail: e.message };
    }
  }

  async function listVideoPresets() {
    try {
      const resp = await hfGet(PATH_MS_VIDEO_PRESETS, 30000);
      if (isNotEnabled(resp)) return { ok: false, reason: 'ms_presets_endpoint_pending', presets: [] };
      const presets = resp?.body?.items || resp?.body?.presets || (Array.isArray(resp?.body) ? resp.body : []);
      return { ok: true, presets };
    } catch (e) {
      return { ok: false, reason: 'ms_presets_error', presets: [], detail: e.message };
    }
  }

  // ─── DTC ad image (ms_image) ─────────────────────────────────────────────

  /**
   * Brand-kit-aware DTC ad image. styleId is the dominant creative driver —
   * required by the API; callers surface listImageStyles() for selection and
   * may pass a curated default per industry.
   */
  async function generateDtcAdImage({
    businessId,
    prompt,
    styleId,
    brandKitId,
    productIds = [],
    imageUrls = [],
    aspectRatio = '1:1',
    resolution = '1k',
    quality = 'medium',
    batchSize = 1,
  }) {
    if (!styleId) return degraded('ms_image_style_required');
    const kit = brandKitId || (businessId ? await ensureBrandKit({ businessId }) : null);
    const payload = {
      prompt: prompt || '',
      style_id: styleId,
      ...(kit ? { brand_kit_id: kit } : {}),
      ...(productIds.length ? { product_ids: productIds.slice(0, 4) } : {}),
      ...(imageUrls.length ? { medias: imageUrls.slice(0, 14).map((url) => ({ type: 'image', url })) } : {}),
      aspect_ratio: aspectRatio,
      resolution,
      quality,
      batch_size: Math.min(Math.max(1, Number(batchSize) || 1), 20),
    };
    try {
      if (typeof submitImageAndWait === 'function') {
        const url = await submitImageAndWait(payload, PATH_MS_IMAGE);
        return { ok: true, imageUrl: url, brandKitId: kit || null };
      }
      const resp = await hfPost(PATH_MS_IMAGE, payload, 180000);
      if (isNotEnabled(resp)) return degraded('ms_image_endpoint_pending');
      if (resp.status >= 200 && resp.status < 300) {
        return {
          ok: true,
          imageUrl: resp?.body?.url || null,
          requestId: resp?.body?.request_id,
          brandKitId: kit || null,
        };
      }
      return degraded('ms_image_failed', JSON.stringify(resp.body || {}));
    } catch (e) {
      return degraded('ms_image_error', e.message);
    }
  }

  // ─── Marketing video ─────────────────────────────────────────────────────

  /**
   * One-click product marketing video (TikTok/Reels-ready).
   * hookId/settingId compose from building blocks; adReferenceId recreates a
   * reference video's scenario — the two approaches are mutually exclusive
   * (API contract), adReferenceId wins when both are passed.
   */
  async function generateMarketingVideo({
    businessId,
    prompt,
    mode,
    productIds = [],
    avatarIds = [],
    imageUrls = [],
    hookId,
    settingId,
    adReferenceId,
    aspectRatio = '9:16',
    resolution = '720p',
    generateAudio = true,
  }) {
    const payload = {
      prompt: prompt || '',
      ...(mode ? { mode } : {}),
      ...(productIds.length ? { product_ids: productIds.slice(0, 4) } : {}),
      ...(avatarIds.length ? { avatar_ids: avatarIds.slice(0, 1) } : {}),
      ...(imageUrls.length ? { medias: imageUrls.slice(0, 6).map((url) => ({ type: 'image', url })) } : {}),
      ...(adReferenceId
        ? { ad_reference_id: adReferenceId } // reference-driven scenario
        : {
            ...(hookId ? { hook_id: hookId } : {}),
            ...(settingId ? { setting_id: settingId } : {}),
          }),
      aspect_ratio: aspectRatio,
      resolution,
      generate_audio: !!generateAudio,
    };
    try {
      if (typeof submitVideoAndWait === 'function') {
        const url = await submitVideoAndWait(PATH_MS_VIDEO, payload);
        return { ok: true, videoUrl: url };
      }
      const resp = await hfPost(PATH_MS_VIDEO, payload, 300000);
      if (isNotEnabled(resp)) return degraded('ms_video_endpoint_pending');
      if (resp.status >= 200 && resp.status < 300) {
        return { ok: true, videoUrl: resp?.body?.url || null, requestId: resp?.body?.request_id };
      }
      return degraded('ms_video_failed', JSON.stringify(resp.body || {}));
    } catch (e) {
      return degraded('ms_video_error', e.message);
    }
  }

  // ─── Ad references ("recreate this ad") ──────────────────────────────────

  /**
   * Analyze a reference video (e.g. a winning competitor ad surfaced by
   * competitor-watch) into an ad_reference whose scenario drives future
   * generateMarketingVideo calls. Linked avatar/product on the reference are
   * organizational only — generation must pass product_ids explicitly.
   */
  async function createAdReference({ videoUrl, name }) {
    if (!videoUrl) return degraded('ad_reference_video_url_required');
    try {
      const resp = await hfPost(PATH_AD_REFERENCES, { video_url: videoUrl, name: name || undefined }, 120000);
      if (isNotEnabled(resp)) return degraded('ad_references_endpoint_pending');
      const referenceId = resp?.body?.id || resp?.body?.ad_reference_id || null;
      if (resp.status >= 200 && resp.status < 300 && referenceId) return { ok: true, referenceId };
      return degraded('ad_reference_create_failed', JSON.stringify(resp.body || {}));
    } catch (e) {
      return degraded('ad_reference_create_error', e.message);
    }
  }

  /**
   * Full competitor-ad-recreation pipeline: reference video in → the
   * customer's product in that ad's proven scenario out.
   */
  async function recreateAdForBusiness({ businessId, referenceVideoUrl, productIds = [], imageUrls = [], prompt }) {
    const ref = await createAdReference({ videoUrl: referenceVideoUrl, name: `recreate-${businessId}` });
    if (!ref.ok) return ref;
    return generateMarketingVideo({
      businessId,
      prompt: prompt || '',
      adReferenceId: ref.referenceId,
      productIds,
      imageUrls,
    });
  }

  return {
    PATH_MS_IMAGE,
    PATH_MS_VIDEO,
    ensureBrandKit,
    importProduct,
    listImageStyles,
    listVideoPresets,
    generateDtcAdImage,
    generateMarketingVideo,
    createAdReference,
    recreateAdForBusiness,
  };
};
