'use strict';

/**
 * Smart model routing by WF10 / brief content_type (2026 lineup).
 * Slugs use hyphen form; pathForModel() expects spaced canonical names.
 */

const CONTENT_TYPE_MODEL = {
  ugc_testimonial: 'wan-2.5',
  ugc_lipsync: 'wan-2.5',
  cinematic: 'kling-3.0',
  product_video: 'kling-3.0',
  social_reel: 'nano-banana-pro',
  ugc_audio_ambient: 'wan-2.5',
  // Reference-driven product videos (consistent identity, multi-SKU, native
  // audio) — Seedance 2.0; the mini variant is the budget tier below.
  product_video_reference: 'seedance-2.0',
  product_video_budget: 'seedance-2.0-mini',
};

const DEFAULT_MODEL = (process.env.HIGGSFIELD_DEFAULT_MODEL || 'nano-banana-pro').trim() || 'nano-banana-pro';

const ENV_OVERRIDES = {
  cinematic: process.env.HIGGSFIELD_CINEMATIC_MODEL,
  ugc_testimonial: process.env.HIGGSFIELD_UGC_MODEL,
  ugc_lipsync: process.env.HIGGSFIELD_UGC_MODEL,
  ugc_audio_ambient: process.env.HIGGSFIELD_UGC_MODEL,
};

/** Hyphen slug → canonical id used by pathForModel / PATHS_BY_MODEL */
const SLUG_TO_CANONICAL = {
  'kling-3.0': 'kling 3.0',
  'kling-3': 'kling 3.0',
  'nano-banana-pro': 'nano banana pro',
  'nan-banana-pro': 'nano banana pro',
  'wan-2.5': 'wan 2.5',
  'wan-2.7': 'wan 2.7',
  'veo-3.1': 'veo 3.1',
  'sora-2': 'sora 2',
  'soul-2.0': 'soul 2.0',
  'seedance-2.0': 'seedance 2.0',
  'seedance-2.0-mini': 'seedance 2.0 mini',
  'seedance-2-mini': 'seedance 2.0 mini',
  'cinema-studio-3.5': 'cinema studio 3.5',
};

const SORA_SUNSET_MSG = 'Sora 2 sunsets Sept 24 2026 — migrate to kling-3.0';

function normalizeSlug(model) {
  return String(model || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

function slugToCanonical(slug) {
  const key = normalizeSlug(slug);
  if (SLUG_TO_CANONICAL[key]) return SLUG_TO_CANONICAL[key];
  return String(slug || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, ' ');
}

/**
 * Apply Sora 2 deprecation: log warning and fall back to kling-3.0.
 * @returns {{ modelSlug: string, canonical: string, soraMigrated: boolean }}
 */
function resolveModelSlug(modelSlug, logFn) {
  let slug = normalizeSlug(modelSlug) || DEFAULT_MODEL;
  let soraMigrated = false;
  if (slug === 'sora-2' || slug === 'sora2') {
    if (typeof logFn === 'function') logFn(SORA_SUNSET_MSG);
    else console.warn(`[higgsfield:modelRouter] ${SORA_SUNSET_MSG}`);
    slug = 'kling-3.0';
    soraMigrated = true;
  }
  return { modelSlug: slug, canonical: slugToCanonical(slug), soraMigrated };
}

/**
 * Pick model slug from content_type (and optional explicit model override).
 */
function routeModelForContentType(contentType, explicitModel, logFn) {
  const ct = String(contentType || '')
    .trim()
    .toLowerCase();
  let slug =
    explicitModel && String(explicitModel).trim()
      ? normalizeSlug(explicitModel)
      : CONTENT_TYPE_MODEL[ct] || DEFAULT_MODEL;
  if (!explicitModel && ENV_OVERRIDES[ct]) {
    const envSlug = normalizeSlug(ENV_OVERRIDES[ct]);
    if (envSlug) slug = envSlug;
  }
  const resolved = resolveModelSlug(slug, logFn);
  return {
    content_type: ct || null,
    model_slug: resolved.modelSlug,
    model: resolved.canonical,
    sora_migrated: resolved.soraMigrated,
  };
}

module.exports = {
  CONTENT_TYPE_MODEL,
  DEFAULT_MODEL,
  SORA_SUNSET_MSG,
  routeModelForContentType,
  resolveModelSlug,
  slugToCanonical,
  normalizeSlug,
};
