/*
 * services/wf1/scheduler.js
 * ----------------------------------------------------------------------------
 * Honors content_assets.posting_time_local. Before this existed, every approved
 * or auto-approved asset published the instant it was decided — the optimal
 * "HH:MM" slot the WF1 engine computed from grounded best-time signals was
 * stored and ignored. Now:
 *
 *   publishOrSchedule()  — at decision time, if the slot is still ahead today
 *                          (in the business timezone) the asset is parked as
 *                          status='scheduled' with a UTC scheduled_at; if the
 *                          slot already passed (or there's no slot) it publishes
 *                          immediately, exactly as before.
 *   sweepDuePublishes()  — a 15-minute cron drains due rows. The claim is an
 *                          atomic compare-and-swap (scheduled → publishing) so
 *                          overlapping sweeps or retries never double-publish.
 *
 * Timezone math is DST-correct and dependency-free (Intl only) — see
 * computeScheduledAt. Pure functions are exported for unit testing.
 * ----------------------------------------------------------------------------
 */

'use strict';

// Publish now (instead of scheduling) if the optimal slot is within this many
// minutes — no point parking an asset for a 6-minute wait, and it absorbs
// clock skew between the decision and the sweep.
const GRACE_MINUTES = 10;
// Stop retrying a failing scheduled publish after this many attempts; the asset
// is left 'failed' and a give-up event is emitted (never silently stuck).
const MAX_PUBLISH_ATTEMPTS = 5;
// A row claimed (status='publishing') but not resolved within this window is
// assumed orphaned (process died mid-publish) and returned to 'scheduled'.
const STALE_CLAIM_MINUTES = 15;

/**
 * Offset of `timeZone` from UTC at instant `date`, in milliseconds
 * (positive = ahead of UTC). Works across DST because it asks Intl what the
 * wall clock reads at that specific instant.
 */
function tzOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUTC - date.getTime();
}

/** Today's calendar date (Y, M, D) as seen in `timeZone` at instant `now`. */
function localYMD(now, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(now)) parts[p.type] = p.value;
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

/**
 * The UTC instant for "today at HH:MM in `timeZone`", DST-correct.
 *
 * @returns {Date|null} null when postingTimeLocal isn't a valid "HH:MM".
 *
 * Two-pass offset: guess using the offset at the naive instant, then re-resolve
 * the offset at the candidate instant. This corrects the case where the slot
 * lands on the far side of a DST boundary from `now`. For a spring-forward gap
 * (a wall time that doesn't exist), the result lands on an adjacent valid
 * instant — fine for a marketing scheduler (slots are 09:00/14:30, never 02:30).
 */
function computeScheduledAt({ postingTimeLocal, timeZone = 'Europe/Belgrade', now = new Date() }) {
  if (typeof postingTimeLocal !== 'string') return null;
  const match = postingTimeLocal.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;

  let tz = timeZone;
  const { y, m, d } = (() => {
    try {
      return localYMD(now, tz);
    } catch {
      // Invalid timezone string → fall back to the WF1 default rather than throw.
      tz = 'Europe/Belgrade';
      return localYMD(now, tz);
    }
  })();

  const naiveUTC = Date.UTC(y, m - 1, d, hour, minute, 0);
  const firstOffset = tzOffsetMs(new Date(naiveUTC), tz);
  let instant = naiveUTC - firstOffset;
  const secondOffset = tzOffsetMs(new Date(instant), tz);
  if (secondOffset !== firstOffset) instant = naiveUTC - secondOffset;
  return new Date(instant);
}

/**
 * Decide whether to schedule `scheduledAt` or publish now, given `now`.
 * Pure so the policy is unit-testable independent of the DB.
 *   future beyond grace → { action:'schedule' }
 *   past / within grace / no slot → { action:'publish_now' }
 */
function decidePublishTiming({ scheduledAt, now = new Date(), graceMinutes = GRACE_MINUTES }) {
  if (!scheduledAt) return { action: 'publish_now', reason: 'no_slot' };
  const deltaMs = scheduledAt.getTime() - now.getTime();
  if (deltaMs > graceMinutes * 60000) return { action: 'schedule', scheduledAt };
  if (deltaMs < 0) return { action: 'publish_now', reason: 'slot_passed' };
  return { action: 'publish_now', reason: 'within_grace' };
}

function createScheduler({ sbGet, sbPost, sbPatch, sbPatchReturning, publisher, logger }) {
  if (!sbGet || !sbPatch || !publisher) throw new Error('WF1 scheduler: sbGet/sbPatch/publisher required');

  async function resolveTimezone(businessId) {
    const rows = await sbGet('business_profiles', `user_id=eq.${businessId}&select=timezone`).catch(() => []);
    return rows?.[0]?.timezone || 'Europe/Belgrade';
  }

  /**
   * Park the asset for its optimal slot, or publish immediately when the slot
   * has passed / is imminent / is unknown. Returns a descriptive result; never
   * throws (publish failures come back as { ok:false } from publishAsset).
   */
  async function publishOrSchedule({ assetId, businessId, now = new Date() }) {
    const rows = await sbGet('content_assets', `id=eq.${assetId}&select=posting_time_local`).catch(() => []);
    const postingTimeLocal = rows?.[0]?.posting_time_local || null;
    const timeZone = await resolveTimezone(businessId);
    const scheduledAt = computeScheduledAt({ postingTimeLocal, timeZone, now });
    const decision = decidePublishTiming({ scheduledAt, now });

    if (decision.action === 'publish_now') {
      return publisher.publishAsset({ assetId });
    }

    await sbPatch('content_assets', `id=eq.${assetId}`, {
      status: 'scheduled',
      scheduled_at: scheduledAt.toISOString(),
      publish_attempts: 0,
      publish_claimed_at: null,
    });
    await sbPost?.('events', {
      business_id: businessId,
      kind: 'wf1.asset.scheduled',
      workflow: '1_daily_content',
      payload: {
        asset_id: assetId,
        scheduled_at: scheduledAt.toISOString(),
        posting_time_local: postingTimeLocal,
        timezone: timeZone,
      },
      severity: 'info',
    }).catch(() => {});
    logger?.info?.('/wf1/scheduler', businessId, 'asset scheduled', {
      asset_id: assetId,
      scheduled_at: scheduledAt.toISOString(),
      posting_time_local: postingTimeLocal,
    });
    return { ok: true, scheduled: true, scheduledAt: scheduledAt.toISOString() };
  }

  // Return claimed-but-orphaned rows (status='publishing' past the stale window)
  // to 'scheduled' so they get retried instead of silently stuck.
  async function reclaimStaleClaims({ now = new Date() } = {}) {
    const cutoff = new Date(now.getTime() - STALE_CLAIM_MINUTES * 60000).toISOString();
    const stale = await sbGet(
      'content_assets',
      `status=eq.publishing&publish_claimed_at=lt.${encodeURIComponent(cutoff)}&select=id&limit=100`
    ).catch(() => []);
    for (const row of stale) {
      await sbPatch('content_assets', `id=eq.${row.id}&status=eq.publishing`, {
        status: 'scheduled',
        publish_claimed_at: null,
      }).catch(() => {});
    }
    return stale.length;
  }

  /**
   * Drain due scheduled publishes. Each row is claimed with an atomic CAS
   * (scheduled → publishing via a status-guarded PATCH that returns the row);
   * only the sweep that wins the CAS publishes it, so overlapping sweeps and
   * step retries can never double-publish. Failures retry with backoff up to
   * MAX_PUBLISH_ATTEMPTS, then surface as 'failed' + a give-up event.
   */
  async function sweepDuePublishes({ limit = 25, now = new Date() } = {}) {
    const reclaimed = await reclaimStaleClaims({ now });
    const nowIso = now.toISOString();
    const due = await sbGet(
      'content_assets',
      `status=eq.scheduled&scheduled_at=lte.${encodeURIComponent(nowIso)}&select=id,business_id,publish_attempts&order=scheduled_at.asc&limit=${limit}`
    ).catch(() => []);

    const results = [];
    for (const row of due) {
      // Atomic claim: only succeeds if the row is still 'scheduled'.
      let claimed = [];
      try {
        claimed = await sbPatchReturning('content_assets', `id=eq.${row.id}&status=eq.scheduled`, {
          status: 'publishing',
          publish_claimed_at: new Date().toISOString(),
        });
      } catch (e) {
        logger?.warn?.('/wf1/scheduler', row.business_id, 'claim failed', { asset_id: row.id, error: e.message });
        continue;
      }
      if (!Array.isArray(claimed) || claimed.length === 0) {
        results.push({ assetId: row.id, action: 'lost_claim' });
        continue;
      }

      const pub = await publisher.publishAsset({ assetId: row.id });
      if (pub.ok) {
        results.push({ assetId: row.id, action: 'published', postId: pub.postId });
        continue;
      }

      // publishAsset set status='failed'. Retry with backoff, or give up.
      const attempts = Number(row.publish_attempts || 0) + 1;
      if (attempts < MAX_PUBLISH_ATTEMPTS) {
        const backoffMs = attempts * 10 * 60000; // 10, 20, 30, 40 min
        await sbPatch('content_assets', `id=eq.${row.id}`, {
          status: 'scheduled',
          scheduled_at: new Date(now.getTime() + backoffMs).toISOString(),
          publish_attempts: attempts,
          publish_claimed_at: null,
        }).catch(() => {});
        results.push({ assetId: row.id, action: 'retry_scheduled', attempts, error: pub.error });
      } else {
        await sbPatch('content_assets', `id=eq.${row.id}`, { publish_attempts: attempts }).catch(() => {});
        await sbPost?.('events', {
          business_id: row.business_id,
          kind: 'wf1.scheduled_publish.gave_up',
          workflow: '1_daily_content',
          payload: { asset_id: row.id, attempts, error: pub.error },
          severity: 'error',
        }).catch(() => {});
        results.push({ assetId: row.id, action: 'gave_up', attempts, error: pub.error });
      }
    }

    return { reclaimed, due: due.length, processed: results.length, results };
  }

  return { publishOrSchedule, sweepDuePublishes, reclaimStaleClaims };
}

module.exports = createScheduler;
module.exports.computeScheduledAt = computeScheduledAt;
module.exports.decidePublishTiming = decidePublishTiming;
module.exports.tzOffsetMs = tzOffsetMs;
module.exports.GRACE_MINUTES = GRACE_MINUTES;
module.exports.MAX_PUBLISH_ATTEMPTS = MAX_PUBLISH_ATTEMPTS;
module.exports.STALE_CLAIM_MINUTES = STALE_CLAIM_MINUTES;
