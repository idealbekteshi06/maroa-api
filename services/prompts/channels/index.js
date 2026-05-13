'use strict';

/**
 * services/prompts/channels/index.js
 * ---------------------------------------------------------------------------
 * Channel-native format registry. Wave 60 Session 3.
 *
 * Per Rule 6 of the Wave 60 ground rules, customer-facing copy must respect
 * the channel-specific shape it'll publish into. Writing the SAME post for
 * Instagram, LinkedIn, X, and TikTok and cross-posting underperforms each
 * surface's native shape — every surface has implicit "feed laws" that
 * locals recognize. This registry codifies them.
 *
 * Each channel module exports:
 *   id                 — kebab-case channel ID (matches stage-rules channel IDs)
 *   name               — human-readable
 *   category           — one of social, paid-ads, owned, web, commerce
 *   surface_type       — short_video, feed_post, story, ad_image, ad_video,
 *                        search_result, long_form, email, sms, landing,
 *                        listing, message, notification, long_video
 *   source_citation    — research source (Buffer/Sprout/Later/HubSpot/etc.)
 *   format_rules       — length window, hook window, aspect ratio, emoji policy
 *   hook_patterns      — array of {name, template, why}
 *   anti_patterns      — array of {pattern, why} — strings that get downranked
 *   retention_mechanics — array of strings — how to hold attention on this surface
 *   applicability      — same shape as methodologies
 *   invariants         — array of {id, rule, kind}
 *   manipulation_risk  — 0..10 (channels are formal, mostly 0-2)
 *   applyToDraft(draft, context) → { score, fixes, reasoning }
 *   generateFromSpec(context) → { structure, prompt_segments }
 *
 * Used by:
 *   - stageRouter.routeContent — surfaces channel hints into prompt
 *   - creative-engine — calls applyToDraft on candidates before publish
 *   - methodologies/feed-native-laws — defers to deeper per-channel modules
 * ---------------------------------------------------------------------------
 */

const { CHANNEL_CATEGORIES } = require('./_helpers');

const _MODULE_PATHS = {
  // ── SOCIAL (organic) ───────────────────────────────────────────────────
  'instagram-post': './social/instagram-post',
  'instagram-reels': './social/instagram-reels',
  'instagram-stories': './social/instagram-stories',
  tiktok: './social/tiktok',
  'linkedin-post': './social/linkedin-post',
  'linkedin-article': './social/linkedin-article',
  'x-post': './social/x-post',
  'threads-post': './social/threads-post',
  'facebook-post': './social/facebook-post',
  'pinterest-pin': './social/pinterest-pin',
  'youtube-shorts': './social/youtube-shorts',
  'youtube-long': './social/youtube-long',

  // ── PAID ADS ───────────────────────────────────────────────────────────
  'meta-ads-image': './paid-ads/meta-ads-image',
  'meta-ads-video': './paid-ads/meta-ads-video',
  'meta-ads-carousel': './paid-ads/meta-ads-carousel',
  'google-ads-search': './paid-ads/google-ads-search',
  'google-ads-display': './paid-ads/google-ads-display',
  'google-ads-pmax': './paid-ads/google-ads-pmax',
  'tiktok-ads': './paid-ads/tiktok-ads',

  // ── OWNED (CRM) ────────────────────────────────────────────────────────
  'email-cold': './owned/email-cold',
  'email-nurture': './owned/email-nurture',
  'email-promo': './owned/email-promo',
  'email-retention': './owned/email-retention',
  sms: './owned/sms',
  whatsapp: './owned/whatsapp',
  'push-notification': './owned/push-notification',

  // ── WEB (long-form) ────────────────────────────────────────────────────
  'landing-page-long': './web/landing-page-long',
  'sales-page': './web/sales-page',
  'blog-seo': './web/blog-seo',
  'blog-thought-leadership': './web/blog-thought-leadership',
  webinar: './web/webinar',
  'podcast-script': './web/podcast-script',

  // ── COMMERCE ───────────────────────────────────────────────────────────
  'app-store-listing': './commerce/app-store-listing',
  'product-detail-page': './commerce/product-detail-page',
  'review-response': './commerce/review-response',
};

const NULL_MODULE = Object.freeze({
  id: 'null',
  name: '(unavailable)',
  category: 'unavailable',
  surface_type: 'unknown',
  source_citation: 'n/a',
  format_rules: {},
  hook_patterns: [],
  anti_patterns: [],
  retention_mechanics: [],
  applicability: { awareness_stages: [], funnel_stages: [], channels: [], industries: [], regions: [] },
  invariants: [],
  manipulation_risk: 0,
  applyToDraft: () => ({ score: 0, fixes: [], reasoning: 'module unavailable' }),
  generateFromSpec: () => ({ structure: '', prompt_segments: [] }),
});

const _loadedModules = new Map();

function getChannel(id) {
  if (_loadedModules.has(id)) return _loadedModules.get(id);
  const path = _MODULE_PATHS[id];
  if (!path) return null;
  try {
    const mod = require(path);
    _loadedModules.set(id, mod);
    return mod;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[channels] failed to load ${id}: ${e.message}`);
    _loadedModules.set(id, NULL_MODULE);
    return NULL_MODULE;
  }
}

function listChannels({ category, surface_type } = {}) {
  return Object.keys(_MODULE_PATHS)
    .map(getChannel)
    .filter((m) => m && m !== NULL_MODULE)
    .filter((m) => {
      if (category && m.category !== category) return false;
      if (surface_type && m.surface_type !== surface_type) return false;
      return true;
    });
}

function listAllIds() {
  return Object.keys(_MODULE_PATHS);
}

/**
 * Apply the channel rules for a given (channel, draft) — returns the
 * applyToDraft result for that channel only, or NULL_MODULE result if
 * channel unknown. Used in creative-engine post-generation gating.
 */
function applyChannel({ channelId, draft, context = {} } = {}) {
  const mod = getChannel(channelId);
  if (!mod || mod === NULL_MODULE) {
    return { id: channelId, error: 'channel not registered', score: 0, fixes: [] };
  }
  try {
    const r = mod.applyToDraft(draft, { ...context, channel: channelId }) || {
      score: 0,
      fixes: [],
      reasoning: '',
    };
    return {
      id: channelId,
      name: mod.name,
      category: mod.category,
      surface_type: mod.surface_type,
      score: typeof r.score === 'number' ? r.score : 0,
      fixes: Array.isArray(r.fixes) ? r.fixes : [],
      reasoning: r.reasoning || '',
    };
  } catch (e) {
    return { id: channelId, error: e.message, score: 0, fixes: [] };
  }
}

/**
 * Get the prompt segments for a channel — surfaced into the LLM prompt
 * during generation. Used by stageRouter.routeContent and creative-engine.
 */
function getChannelPromptSegments(channelId, context = {}) {
  const mod = getChannel(channelId);
  if (!mod || mod === NULL_MODULE) return [];
  try {
    const r = mod.generateFromSpec({ ...context, channel: channelId });
    return Array.isArray(r.prompt_segments) ? r.prompt_segments : [];
  } catch (e) {
    return [];
  }
}

module.exports = {
  CHANNEL_CATEGORIES,
  getChannel,
  listChannels,
  listAllIds,
  applyChannel,
  getChannelPromptSegments,
  NULL_MODULE,
};
