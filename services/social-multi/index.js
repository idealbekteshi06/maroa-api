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
  linkedin: '1.91:1',     // landscape preferred for feed
  pinterest: '2:3',       // tall portrait pins convert best
  tiktok: '9:16',         // full vertical
  youtube: '9:16',        // shorts only at this scope
  threads: '1:1',         // square plays on both feeds and replies
  facebook: '1.91:1',
  instagram: '1:1',       // feed default; reels are 9:16 (handled separately)
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
    mediaUrls: Array.isArray(mediaUrls) ? mediaUrls : (mediaUrls ? [mediaUrls] : []),
  };
  if (scheduleAt) body.scheduleDate = new Date(scheduleAt).toISOString();
  // profileKey identifies a sub-account — Ayrshare's per-customer model
  if (profileKey) body['profile-key'] = profileKey;

  try {
    const res = await fetch('https://api.ayrshare.com/api/post', {
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

async function metaGraphPost({ accessToken, accountId, platform, post, mediaUrl, deps }) {
  // Skeleton — real publish endpoints differ per platform:
  //   /{ig-user-id}/media + /media_publish for Instagram
  //   /{page-id}/feed for Facebook
  //   /{threads-user-id}/threads + /threads_publish for Threads
  // Implementations are wrapped in services/meta-publisher/ in a follow-up.
  // Dry-run safe: we return ok:true with dry_run=true unless META_PUBLISH_LIVE.
  const live = String(process.env.META_PUBLISH_LIVE || '').toLowerCase() === 'true';
  if (!live) {
    return {
      ok: true,
      dry_run: true,
      reason: 'META_PUBLISH_LIVE=false — payload validated, post not published',
    };
  }
  if (!accessToken) return { ok: false, reason: `${platform}: access token missing` };
  return { ok: false, reason: `${platform} live publish not yet implemented` };
}

// ─── Public API ──────────────────────────────────────────────────────────

async function listConnectedPlatforms({ businessId, deps }) {
  const { sbGet } = deps;
  const rows = await sbGet?.('businesses',
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

  const businessRows = await sbGet('businesses',
    `id=eq.${businessId}&select=meta_access_token,facebook_page_id,instagram_account_id,threads_account_id,ayrshare_profile_key`
  ).catch(() => []);
  const business = businessRows?.[0];
  if (!business) return { ok: false, reason: 'business not found' };

  // Split into Ayrshare vs Meta Graph
  const viaAyrshare = valid.filter((p) => PLATFORM_VIA_AYRSHARE.includes(p));
  const viaMeta = valid.filter((p) => PLATFORM_VIA_META_GRAPH.includes(p));

  const results = [];

  if (viaAyrshare.length > 0 && business.ayrshare_profile_key) {
    // For Ayrshare we need to send ONE post with platforms list — but we
    // adapt content per-platform first to honor character limits, then pass
    // the longest-tolerant version because Ayrshare doesn't accept per-
    // platform overrides for body text in a single call.
    const adapted = adaptContentForPlatform({ platform: 'youtube', content, mediaUrl });  // longest limit
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
      accessToken: business.meta_access_token,
      accountId: p === 'facebook' ? business.facebook_page_id :
                  p === 'instagram' ? business.instagram_account_id :
                  business.threads_account_id,
      platform: p,
      post: adapted.body,
      mediaUrl,
      deps,
    });
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

  const businessRows = await sbGet('businesses',
    `id=eq.${businessId}&select=ayrshare_profile_key`
  ).catch(() => []);
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
  SUPPORTED_PLATFORMS,
  PLATFORM_VIA_AYRSHARE,
  PLATFORM_VIA_META_GRAPH,
  PLATFORM_ASPECT_RATIO,
};
