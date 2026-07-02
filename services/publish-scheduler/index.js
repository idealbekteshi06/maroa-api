'use strict';

/**
 * services/publish-scheduler/index.js — rebuild of lost feature #3.
 * ---------------------------------------------------------------------------
 * A 15-minute cron (services/inngest/functions.js `publish-scheduler-15m` →
 * /webhook/publish-scheduler-run) that publishes content whose scheduled slot
 * has arrived — timezone-correct per business and idempotent (no double-post):
 *
 *   • content_assets (canonical WF1): status=approved + published_at IS NULL +
 *     posting_time_local set. Published via the tested wf1 publishAsset() once
 *     the business's LOCAL time (business_profiles.timezone) reaches
 *     posting_time_local. publishAsset flips status→published + stamps
 *     published_at, so the next sweep skips it.
 *   • generated_content (legacy instant-content, incl. the evening variant-B):
 *     status=approved + published_at IS NULL + scheduled_for <= now(). Published
 *     by reusing the live /webhook/publish-approved-content route (injected as
 *     publishApprovedForBusiness); that route only touches published_at IS NULL
 *     rows, so it is idempotent.
 *
 * Timezone correctness: posting_time_local is local "HH:MM"; we compare it to
 * the business's current local "HH:MM" via Intl.DateTimeFormat in the
 * business_profiles.timezone — the same mechanism WF1's daily run uses.
 * ---------------------------------------------------------------------------
 */

const createPublisher = require('../wf1/publish');

const DEFAULT_TZ = 'Europe/Belgrade';

/** Current local time as zero-padded "HH:MM" in the given IANA timezone. */
function localHHMM(timezone, now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);
  } catch {
    return `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  }
}

/** Due when the asset's local slot is at or before the business's local now. */
function assetDue(postingTimeLocal, localNow) {
  if (!postingTimeLocal) return false;
  // zero-padded "HH:MM" compares lexicographically === chronologically
  return String(postingTimeLocal).slice(0, 5) <= String(localNow).slice(0, 5);
}

async function tzForBusiness(businessId, sbGet) {
  const rows = await sbGet('business_profiles', `user_id=eq.${encodeURIComponent(businessId)}&select=timezone`).catch(
    () => []
  );
  return rows?.[0]?.timezone || DEFAULT_TZ;
}

/** Publish due content_assets via the canonical wf1 publisher. */
async function publishDueAssets({ deps, now = new Date() }) {
  const { sbGet, logger } = deps;
  const publishAsset =
    deps.publishAsset ||
    createPublisher({
      apiRequest: deps.apiRequest,
      sbGet: deps.sbGet,
      sbPost: deps.sbPost,
      sbPatch: deps.sbPatch,
      logger,
    }).publishAsset;

  const assets = await sbGet(
    'content_assets',
    'status=eq.approved&published_at=is.null&posting_time_local=not.is.null' +
      '&select=id,business_id,posting_time_local&order=generated_at.asc&limit=1000'
  ).catch(() => []);

  const tzCache = new Map();
  let due = 0;
  let published = 0;
  let failed = 0;
  for (const a of assets || []) {
    if (!tzCache.has(a.business_id)) tzCache.set(a.business_id, await tzForBusiness(a.business_id, sbGet));
    if (!assetDue(a.posting_time_local, localHHMM(tzCache.get(a.business_id), now))) continue;
    due += 1;
    const r = await publishAsset({ assetId: a.id }).catch((e) => ({ ok: false, error: e.message }));
    if (r?.ok) published += 1;
    else failed += 1;
  }
  return { assets_due: due, assets_published: published, assets_failed: failed };
}

/** Publish due generated_content (scheduled_for) via the existing route. */
async function publishDueScheduled({ deps, now = new Date() }) {
  const { sbGet, publishApprovedForBusiness, logger } = deps;
  if (typeof publishApprovedForBusiness !== 'function') {
    return { scheduled_businesses_due: 0, scheduled_triggered: 0, skipped: 'no_publisher' };
  }
  const rows = await sbGet(
    'generated_content',
    `status=eq.approved&published_at=is.null&scheduled_for=lte.${now.toISOString()}&select=business_id&limit=1000`
  ).catch(() => []);
  const bizIds = [...new Set((rows || []).map((r) => r.business_id).filter(Boolean))];
  let triggered = 0;
  for (const businessId of bizIds) {
    try {
      await publishApprovedForBusiness(businessId);
      triggered += 1;
    } catch (e) {
      logger?.warn?.('publish-scheduler', businessId, 'scheduled publish failed', { error: e.message });
    }
  }
  return { scheduled_businesses_due: bizIds.length, scheduled_triggered: triggered };
}

async function runDuePublish({ deps, now = new Date() }) {
  const assets = await publishDueAssets({ deps, now });
  const scheduled = await publishDueScheduled({ deps, now });
  return { ok: true, ...assets, ...scheduled };
}

module.exports = { runDuePublish, publishDueAssets, publishDueScheduled, localHHMM, assetDue };
