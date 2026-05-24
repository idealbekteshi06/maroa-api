'use strict';

/**
 * services/social-multi/index.js
 * ---------------------------------------------------------------------------
 * Multi-platform social posting via Ayrshare aggregator ($99/mo Maroa-side).
 * Single OAuth flow, single API surface for: LinkedIn, Pinterest, TikTok,
 * YouTube Shorts. Threads goes direct via Meta Graph API (we already have
 * that App). Facebook + Instagram stay direct (already wired).
 *
 * Why Ayrshare for v1: research showed direct integrations require LinkedIn
 * MDP approval (3-6 weeks), TikTok audit (6-10 weeks), and Pinterest T&S
 * review. Ayrshare maintains those approvals at the platform level — we
 * inherit them. Once Maroa hits ~500 customers, the economics flip and we
 * graduate the top 1-2 platforms to direct integrations.
 *
 * Public API:
 *   listConnectedPlatforms({ businessId })    — what does this customer have?
 *   schedulePost({ businessId, platforms, content, mediaUrl, scheduleAt })
 *   postNow({ businessId, platforms, content, mediaUrl })
 *   listPosts({ businessId, days })
 *
 * Honest constraints encoded:
 *   - X (Twitter) is NOT in the platform list — Basic tier is $200/mo and
 *     not worth it until a paying customer asks.
 *   - Reddit is NOT supported — policy minefield per research.
 *   - Google Business Profile organic posts API was deprecated in 2024.
 *     We replace with GBP Q&A + Reviews monitoring (already in voc).
 * ---------------------------------------------------------------------------
 */

const SUPPORTED_PLATFORMS = ['linkedin', 'pinterest', 'tiktok', 'youtube', 'threads', 'facebook', 'instagram'];
const PLATFORM_VIA_AYRSHARE = ['linkedin', 'pinterest', 'tiktok', 'youtube'];
const PLATFORM_VIA_META_GRAPH = ['threads', 'facebook', 'instagram'];

// Platform → preferred aspect ratio for native rendering
const PLATFORM_ASPECT_RATIO = {
  linkedin: '1.91:1', // landscape preferred for feed
  pinterest: '2:3', // tall portrait pins convert best
  tiktok: '9:16', // full vertical
  youtube: '9:16', // shorts only at this scope
  threads: '1:1', // square plays on both feeds and replies
  facebook: '1.91:1',
  instagram: '1:1', // feed default; reels are 9:16 (handled separately)
};

function adaptContentForPlatform({ platform, content, mediaUrl }) {
  // Different platforms have different ideal lengths and conventions.
  const adapted = { ...content };
  if (platform === 'linkedin') {
    // 700-1200 chars sweet spot, professional tone, hashtags at end
    adapted.body = String(content.body || '').slice(0, 2900);
  } else if (platform === 'pinterest') {
    // 100 chars title, 500 chars description
    adapted.body = String(content.body || '').slice(0, 500);
  } else if (platform === 'tiktok') {
    // Caption ≤2200 chars, but 100-150 performs best
    adapted.body = String(content.body || '').slice(0, 2200);
  } else if (platform === 'youtube') {
    // Title ≤100, description ≤5000
    adapted.body = String(content.body || '').slice(0, 5000);
  } else if (platform === 'threads') {
    // 500 char limit
    adapted.body = String(content.body || '').slice(0, 500);
  } else if (platform === 'instagram') {
    adapted.body = String(content.body || '').slice(0, 2200);
  } else if (platform === 'facebook') {
    adapted.body = String(content.body || '').slice(0, 5000);
  }
  return { ...adapted, media_url: mediaUrl, aspect_ratio: PLATFORM_ASPECT_RATIO[platform] };
}

// ─── Ayrshare adapter ────────────────────────────────────────────────────

async function ayrsharePost({ apiKey, profileKey, platforms, post, mediaUrls, scheduleAt, deps }) {
  if (!apiKey) return { ok: false, reason: 'AYRSHARE_API_KEY not configured' };
  const body = {
    post,
    platforms,
    mediaUrls: Array.isArray(mediaUrls) ? mediaUrls : mediaUrls ? [mediaUrls] : [],
  };
  if (scheduleAt) body.scheduleDate = new Date(scheduleAt).toISOString();
  // profileKey identifies a sub-account — Ayrshare's per-customer model
  if (profileKey) body['profile-key'] = profileKey;

  try {
    const res = await fetch('https://api.ayrshare.com/api/post', {
      signal: AbortSignal.timeout(30000),
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, status: res.status, error: json?.message || `HTTP ${res.status}`, raw: json };
    }
    return { ok: true, id: json?.id, raw: json };
  } catch (e) {
    deps?.logger?.warn?.('social-multi.ayrshare', null, 'fetch failed', { error: e.message });
    return { ok: false, error: e.message };
  }
}

// ─── Meta Graph adapter (Threads + FB + IG share the App) ────────────────

const META_GRAPH_VERSION = 'v21.0';
const META_GRAPH_HOST = 'graph.facebook.com';

/**
 * Parse Meta's X-Business-Use-Case-Usage header and surface the worst-case
 * rate-limit utilization across all reported buckets. Each bucket maps to
 * a different Marketing-API resource (ad_account, campaign, etc.); the API
 * starts throttling individual operations when any single bucket exceeds
 * 75%, and hard-blocks at 100%.
 *
 * Returns { worstPct, throttleHints } so callers can react (back off,
 * surface to dashboard, log a warning).
 */
function parseRateLimitHeader(headerValue) {
  if (!headerValue) return null;
  let parsed;
  try {
    parsed = JSON.parse(headerValue);
  } catch {
    return null;
  }
  let worstPct = 0;
  const hints = [];
  for (const accountId of Object.keys(parsed || {})) {
    const buckets = parsed[accountId] || [];
    for (const b of buckets) {
      const pct = Math.max(Number(b.call_count || 0), Number(b.total_cputime || 0), Number(b.total_time || 0));
      if (pct > worstPct) worstPct = pct;
      if (pct >= 75)
        hints.push({
          account: accountId,
          type: b.type,
          pct,
          estimated_time_to_regain_access: b.estimated_time_to_regain_access,
        });
    }
  }
  return { worstPct, throttleHints: hints };
}

/**
 * Map Meta's error_subcode → human-actionable {category, retryable, hint}.
 * Documented Meta error codes that matter for marketing operations.
 * Reference: https://developers.facebook.com/docs/marketing-api/error-reference
 */
function classifyMetaError(json) {
  const code = json?.error?.code;
  const subcode = json?.error?.error_subcode;
  const msg = json?.error?.message || '';

  // Rate limit
  if (code === 4 || code === 17 || code === 32 || code === 613) {
    return {
      category: 'rate_limit',
      retryable: true,
      hint: 'back off + retry after X-Business-Use-Case-Usage drops',
      code,
      subcode,
    };
  }
  if (subcode === 1487390)
    return { category: 'daily_spend_cap', retryable: false, hint: 'ad account hit daily spend cap', code, subcode };
  if (subcode === 80004)
    return { category: 'api_throttle', retryable: true, hint: 'API throttled — retry in 5 minutes', code, subcode };

  // Auth / permissions
  if (code === 190)
    return {
      category: 'token_expired',
      retryable: false,
      hint: 'access token expired — user must re-auth',
      code,
      subcode,
    };
  if (code === 200 || code === 10)
    return { category: 'permission_denied', retryable: false, hint: 'missing scope or page admin role', code, subcode };
  if (code === 102)
    return {
      category: 'session_expired',
      retryable: false,
      hint: 'session expired — full re-auth required',
      code,
      subcode,
    };

  // Validation
  if (code === 100)
    return { category: 'validation', retryable: false, hint: msg || 'invalid parameter', code, subcode };
  if (subcode === 1815004)
    return {
      category: 'duplicate_post',
      retryable: false,
      hint: 'identical post within last 5 minutes — Meta blocks dupes',
      code,
      subcode,
    };

  // IG-specific
  if (subcode === 2207001)
    return {
      category: 'ig_media_unavailable',
      retryable: true,
      hint: 'media still uploading — retry in 10s',
      code,
      subcode,
    };

  // Default
  return { category: 'unknown', retryable: code >= 500, hint: msg || `HTTP error code ${code}`, code, subcode };
}

async function metaGraph({ method, path, accessToken, query = {}, body }) {
  const url = new URL(`https://${META_GRAPH_HOST}/${META_GRAPH_VERSION}${path}`);
  for (const [k, v] of Object.entries({ access_token: accessToken, ...query })) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(30000),
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  const rateLimit = parseRateLimitHeader(res.headers.get('x-business-use-case-usage'));
  if (!res.ok || json?.error) {
    const cls = classifyMetaError(json);
    return { ok: false, status: res.status, error: cls, rateLimit, raw: json };
  }
  return { ok: true, status: res.status, rateLimit, body: json };
}

/**
 * Publish a post to Facebook page, Instagram business account, or Threads.
 *
 * - Facebook page feed: POST /{page_id}/feed with `message` + optional `link`
 *   or POST /{page_id}/photos for images. Requires page access token (not
 *   user access token).
 * - Instagram: 2-step create-container + publish flow.
 *     POST /{ig_user_id}/media → returns creation_id
 *     POST /{ig_user_id}/media_publish with creation_id
 *   Image URL must be publicly accessible (Higgsfield → Supabase Storage).
 * - Threads: 2-step similar to IG.
 *     POST /{threads_user_id}/threads → returns creation_id
 *     POST /{threads_user_id}/threads_publish with creation_id
 *
 * Returns { ok, post_id, dry_run?, error?, rateLimit? }.
 */
async function metaGraphPost({ accessToken, pageAccessToken, accountId, platform, post, mediaUrl, deps }) {
  const live = String(process.env.META_PUBLISH_LIVE || '').toLowerCase() === 'true';
  if (!live) {
    return {
      ok: true,
      dry_run: true,
      reason: 'META_PUBLISH_LIVE=false — payload validated, post not published',
    };
  }
  if (!accessToken && !pageAccessToken) {
    return { ok: false, reason: `${platform}: access token missing` };
  }
  if (!accountId) {
    return { ok: false, reason: `${platform}: target account id missing` };
  }

  const logger = deps?.logger;
  const text = String(post || '').trim();

  if (platform === 'facebook') {
    // FB page posts use the page-scoped access token.
    const token = pageAccessToken || accessToken;
    const body = mediaUrl ? { url: mediaUrl, caption: text, published: true } : { message: text, published: true };
    const endpoint = mediaUrl ? `/${accountId}/photos` : `/${accountId}/feed`;
    const r = await metaGraph({ method: 'POST', path: endpoint, accessToken: token, body });
    if (!r.ok) {
      logger?.warn?.('social-multi.facebook', null, 'publish failed', r.error);
      return { ok: false, error: r.error, rateLimit: r.rateLimit };
    }
    return { ok: true, post_id: r.body?.id || r.body?.post_id, rateLimit: r.rateLimit };
  }

  if (platform === 'instagram') {
    // 2-step container + publish. IG REQUIRES a media URL — text-only not allowed.
    if (!mediaUrl) {
      return { ok: false, reason: 'instagram: media_url required (Meta does not allow text-only posts)' };
    }
    const token = accessToken;
    // Step 1 — create media container
    const containerRes = await metaGraph({
      method: 'POST',
      path: `/${accountId}/media`,
      accessToken: token,
      body: { image_url: mediaUrl, caption: text },
    });
    if (!containerRes.ok) {
      return { ok: false, error: containerRes.error, rateLimit: containerRes.rateLimit, step: 'create_container' };
    }
    const creationId = containerRes.body?.id;
    if (!creationId) return { ok: false, reason: 'instagram: no creation_id returned' };
    // Step 2 — publish (IG may need a moment to process the upload)
    let publishRes;
    for (let attempt = 0; attempt < 3; attempt++) {
      publishRes = await metaGraph({
        method: 'POST',
        path: `/${accountId}/media_publish`,
        accessToken: token,
        body: { creation_id: creationId },
      });
      if (publishRes.ok) break;
      // 2207001 = media still uploading — retry after 10s
      if (publishRes.error?.subcode === 2207001 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 10_000));
        continue;
      }
      break;
    }
    if (!publishRes.ok) return { ok: false, error: publishRes.error, rateLimit: publishRes.rateLimit, step: 'publish' };
    return { ok: true, post_id: publishRes.body?.id, rateLimit: publishRes.rateLimit };
  }

  if (platform === 'threads') {
    // 2-step like IG. Threads supports text-only OR image.
    const token = accessToken;
    const body = mediaUrl ? { media_type: 'IMAGE', image_url: mediaUrl, text } : { media_type: 'TEXT', text };
    const containerRes = await metaGraph({
      method: 'POST',
      path: `/${accountId}/threads`,
      accessToken: token,
      body,
    });
    if (!containerRes.ok) {
      return { ok: false, error: containerRes.error, rateLimit: containerRes.rateLimit, step: 'create_container' };
    }
    const creationId = containerRes.body?.id;
    if (!creationId) return { ok: false, reason: 'threads: no creation_id returned' };
    let publishRes;
    for (let attempt = 0; attempt < 3; attempt++) {
      publishRes = await metaGraph({
        method: 'POST',
        path: `/${accountId}/threads_publish`,
        accessToken: token,
        body: { creation_id: creationId },
      });
      if (publishRes.ok) break;
      if (publishRes.error?.retryable && attempt < 2) {
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      break;
    }
    if (!publishRes.ok) return { ok: false, error: publishRes.error, rateLimit: publishRes.rateLimit, step: 'publish' };
    return { ok: true, post_id: publishRes.body?.id, rateLimit: publishRes.rateLimit };
  }

  return { ok: false, reason: `unknown platform: ${platform}` };
}

// ─── Public API ──────────────────────────────────────────────────────────

async function listConnectedPlatforms({ businessId, deps }) {
  const { sbGet } = deps;
  const rows = await sbGet?.(
    'businesses',
    `id=eq.${businessId}&select=meta_access_token,facebook_page_id,instagram_account_id,threads_account_id,ayrshare_profile_key,ayrshare_connected_platforms`
  ).catch(() => []);
  const business = rows?.[0];
  if (!business) return { connected: [], missing: SUPPORTED_PLATFORMS };

  const connected = [];
  if (business.facebook_page_id) connected.push('facebook');
  if (business.instagram_account_id) connected.push('instagram');
  if (business.threads_account_id) connected.push('threads');
  if (business.ayrshare_profile_key) {
    const ayrConnected = Array.isArray(business.ayrshare_connected_platforms)
      ? business.ayrshare_connected_platforms.filter((p) => PLATFORM_VIA_AYRSHARE.includes(p))
      : [];
    connected.push(...ayrConnected);
  }
  const missing = SUPPORTED_PLATFORMS.filter((p) => !connected.includes(p));
  return { connected, missing, ayrshare_enabled: !!business.ayrshare_profile_key };
}

async function postNow({ businessId, platforms, content, mediaUrl, deps }) {
  const { sbGet, sbPost, logger } = deps;
  const valid = (platforms || []).filter((p) => SUPPORTED_PLATFORMS.includes(p));
  if (valid.length === 0) return { ok: false, reason: 'no supported platforms in request' };

  const businessRows = await sbGet(
    'businesses',
    `id=eq.${businessId}&select=meta_access_token,meta_access_token_enc,facebook_page_id,facebook_page_access_token,facebook_page_access_token_enc,instagram_account_id,threads_account_id,ayrshare_profile_key`
  ).catch(() => []);
  const business = businessRows?.[0];
  if (!business) return { ok: false, reason: 'business not found' };

  // Read encrypted tokens preferentially (post-migration-056 schema) and
  // fall back to legacy plaintext. lib/oauthCrypto.readToken handles both.
  const oauthCrypto = require('../../lib/oauthCrypto');
  const metaToken = oauthCrypto.readToken(business, 'meta_access_token');
  const pageToken = oauthCrypto.readToken(business, 'facebook_page_access_token');

  // Split into Ayrshare vs Meta Graph
  const viaAyrshare = valid.filter((p) => PLATFORM_VIA_AYRSHARE.includes(p));
  const viaMeta = valid.filter((p) => PLATFORM_VIA_META_GRAPH.includes(p));

  const results = [];

  if (viaAyrshare.length > 0 && business.ayrshare_profile_key) {
    // For Ayrshare we need to send ONE post with platforms list — but we
    // adapt content per-platform first to honor character limits, then pass
    // the longest-tolerant version because Ayrshare doesn't accept per-
    // platform overrides for body text in a single call.
    const adapted = adaptContentForPlatform({ platform: 'youtube', content, mediaUrl }); // longest limit
    const r = await ayrsharePost({
      apiKey: process.env.AYRSHARE_API_KEY,
      profileKey: business.ayrshare_profile_key,
      platforms: viaAyrshare,
      post: adapted.body,
      mediaUrls: mediaUrl,
      deps,
    });
    results.push({ via: 'ayrshare', platforms: viaAyrshare, ...r });
  }

  for (const p of viaMeta) {
    const adapted = adaptContentForPlatform({ platform: p, content, mediaUrl });
    const r = await metaGraphPost({
      accessToken: metaToken,
      pageAccessToken: pageToken,
      accountId:
        p === 'facebook'
          ? business.facebook_page_id
          : p === 'instagram'
            ? business.instagram_account_id
            : business.threads_account_id,
      platform: p,
      post: adapted.body,
      mediaUrl,
      deps,
    });
    if (r.rateLimit && r.rateLimit.worstPct >= 75) {
      logger?.warn?.('social-multi.meta', businessId, 'rate-limit pressure', {
        platform: p,
        worst_pct: r.rateLimit.worstPct,
        throttle_hints: r.rateLimit.throttleHints,
      });
    }
    results.push({ via: 'meta_graph', platform: p, ...r });
  }

  // Persist a post_drafts row for tracking (existing table in schema)
  await sbPost?.('post_drafts', {
    business_id: businessId,
    post_text: content.body || '',
    image_url: mediaUrl || null,
    platforms_selected: valid,
    status: results.every((r) => r.ok) ? 'posted' : 'partial_failure',
    scheduled_at: null,
  }).catch(() => {});

  const sentCount = results.filter((r) => r.ok && !r.dry_run).length;
  const dryCount = results.filter((r) => r.ok && r.dry_run).length;
  return {
    ok: results.every((r) => r.ok),
    sent: sentCount,
    dry_run_count: dryCount,
    results,
  };
}

async function schedulePost({ businessId, platforms, content, mediaUrl, scheduleAt, deps }) {
  // Same as postNow but routes to Ayrshare's scheduler. Meta Graph doesn't
  // have native scheduling — we'd handle Meta scheduling via a post_drafts
  // row + Inngest cron (similar to email-lifecycle).
  const { sbGet, sbPost } = deps;
  const valid = (platforms || []).filter((p) => SUPPORTED_PLATFORMS.includes(p));
  if (valid.length === 0) return { ok: false, reason: 'no supported platforms' };

  const businessRows = await sbGet('businesses', `id=eq.${businessId}&select=ayrshare_profile_key`).catch(() => []);
  const business = businessRows?.[0];
  if (!business?.ayrshare_profile_key) {
    // Persist as draft for our cron to handle when we add Meta scheduling
    await sbPost('post_drafts', {
      business_id: businessId,
      post_text: content.body || '',
      image_url: mediaUrl || null,
      platforms_selected: valid,
      status: 'scheduled',
      scheduled_at: new Date(scheduleAt).toISOString(),
    }).catch(() => {});
    return { ok: true, queued_local: true };
  }

  const viaAyrshare = valid.filter((p) => PLATFORM_VIA_AYRSHARE.includes(p));
  if (viaAyrshare.length === 0) {
    return { ok: true, queued_local: true, reason: 'no Ayrshare-supported platforms in selection' };
  }

  const adapted = adaptContentForPlatform({ platform: 'youtube', content, mediaUrl });
  const r = await ayrsharePost({
    apiKey: process.env.AYRSHARE_API_KEY,
    profileKey: business.ayrshare_profile_key,
    platforms: viaAyrshare,
    post: adapted.body,
    mediaUrls: mediaUrl,
    scheduleAt,
    deps,
  });
  return { ok: r.ok, ayrshare_id: r.id, error: r.error };
}

module.exports = {
  listConnectedPlatforms,
  postNow,
  schedulePost,
  adaptContentForPlatform,
  // Exposed for tests / per-platform reuse
  parseRateLimitHeader,
  classifyMetaError,
  metaGraphPost,
  SUPPORTED_PLATFORMS,
  PLATFORM_VIA_AYRSHARE,
  PLATFORM_VIA_META_GRAPH,
  PLATFORM_ASPECT_RATIO,
};
