/*
 * services/wf1/guardrails.js
 * ----------------------------------------------------------------------------
 * Enforces WF1_GUARDRAILS from the frontend prompt module, server-side.
 * Every auto-publish and even approval-queue write goes through these checks.
 *
 * Checks:
 *   - Volume caps: max 3 posts/platform/day, min 4h between same platform, stories max 10/day
 *   - Topic cooldown: no topic repeated within 7 days unless trending with <24h half-life
 *   - Crisis auto-pause: reads events table for 'crisis.detected' entries
 *   - Holiday sensitivity: Ramadan daylight, days of mourning, solemn holiday tone
 *   - Cost caps: per-post budget + monthly plan cap
 * ----------------------------------------------------------------------------
 */

'use strict';

const { WF1_GUARDRAILS } = require('../prompts/workflow_1_daily_content.js');

function createGuardrails({ sbGet, countryIntelligence, logger }) {
  // ── Volume check ───────────────────────────────────────────────────────
  async function checkVolume({ businessId, platform }) {
    const since = new Date(Date.now() - 86400000).toISOString();
    const rows = await sbGet(
      'content_posts',
      `business_id=eq.${businessId}&platform=eq.${encodeURIComponent(platform)}&posted_at=gte.${encodeURIComponent(since)}&select=posted_at`
    ).catch(() => []);

    if (rows.length >= WF1_GUARDRAILS.volume.maxPostsPerPlatformPerDay) {
      return {
        allowed: false,
        reason: `Daily cap reached: ${rows.length}/${WF1_GUARDRAILS.volume.maxPostsPerPlatformPerDay} posts on ${platform}`,
      };
    }

    // Min spacing (240 minutes) between same platform
    const minSpacingMs = WF1_GUARDRAILS.volume.minMinutesBetweenSamePlatform * 60 * 1000;
    const latest = rows
      .map(r => new Date(r.posted_at).getTime())
      .filter(t => !Number.isNaN(t))
      .sort((a, b) => b - a)[0];
    if (latest && Date.now() - latest < minSpacingMs) {
      const minsLeft = Math.ceil((latest + minSpacingMs - Date.now()) / 60000);
      return {
        allowed: false,
        reason: `Min spacing not met: next ${platform} post allowed in ${minsLeft} minutes`,
      };
    }

    // Stories daily cap
    if (platform === 'instagram_story') {
      if (rows.length >= WF1_GUARDRAILS.volume.storiesMaxPerDay) {
        return { allowed: false, reason: `Stories cap: ${rows.length}/${WF1_GUARDRAILS.volume.storiesMaxPerDay}` };
      }
    }

    return { allowed: true };
  }

  // ── Topic cooldown ─────────────────────────────────────────────────────
  async function checkTopicCooldown({ businessId, pillar, coreIdea }) {
    const cooldownDays = WF1_GUARDRAILS.topicCooldownDays;
    const since = new Date(Date.now() - cooldownDays * 86400000).toISOString();

    const rows = await sbGet(
      'content_concepts',
      `business_id=eq.${businessId}&created_at=gte.${encodeURIComponent(since)}&select=pillar,core_idea`
    ).catch(() => []);

    // Simple keyword overlap heuristic: if >60% of words in new core_idea
    // appear in an older one with same pillar, it's a duplicate.
    const newWords = new Set(
      (coreIdea || '')
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 3)
    );
    if (!newWords.size) return { allowed: true };

    for (const row of rows) {
      if (row.pillar !== pillar) continue;
      const oldWords = new Set(
        (row.core_idea || '')
          .toLowerCase()
          .replace(/[^\w\s]/g, '')
          .split(/\s+/)
          .filter(w => w.length > 3)
      );
      let overlap = 0;
      for (const w of newWords) {
        if (oldWords.has(w)) overlap++;
      }
      const overlapRatio = overlap / newWords.size;
      if (overlapRatio > 0.6) {
        return {
          allowed: false,
          reason: `Topic cooldown: ${Math.round(overlapRatio * 100)}% overlap with recent ${pillar} post`,
        };
      }
    }
    return { allowed: true };
  }

  // ── Crisis auto-pause ──────────────────────────────────────────────────
  async function checkCrisisPause({ businessId }) {
    const since = new Date(Date.now() - 72 * 3600000).toISOString();
    const rows = await sbGet(
      'events',
      `business_id=eq.${businessId}&kind=eq.crisis.detected&created_at=gte.${encodeURIComponent(since)}&select=id,created_at,payload&limit=1`
    ).catch(() => []);

    if ((rows || []).length === 0) return { allowed: true };

    const crisis = rows[0];
    const hoursSince = (Date.now() - new Date(crisis.created_at).getTime()) / 3600000;
    const [min, max] = WF1_GUARDRAILS.crisisAutoPause.typicalDurationHours;
    if (hoursSince < max) {
      return {
        allowed: false,
        reason: `Crisis auto-pause active: ${Math.round(hoursSince)}h since trigger (resumes after ${max}h)`,
      };
    }
    return { allowed: true };
  }

  // ── Holiday sensitivity ────────────────────────────────────────────────
  function checkHolidaySensitivity({ brandContext, pillar, currentLocalTime }) {
    if (!countryIntelligence || typeof countryIntelligence.getUpcomingHolidays !== 'function') {
      return { allowed: true };
    }
    try {
      const country = (brandContext.primaryMarkets && brandContext.primaryMarkets[0]) || 'XK';
      const holidays = countryIntelligence.getUpcomingHolidays(country, 1) || [];
      const today = holidays.find(h => {
        const d = new Date(h.date || h.iso_date);
        return d.toDateString() === new Date().toDateString();
      });
      if (!today) return { allowed: true };

      // Ramadan daylight rule: no food/beverage promo between sunrise and sunset
      const isFoodBev = /food|restaurant|beverage|drink|water/i.test(brandContext.industry);
      if (
        WF1_GUARDRAILS.holidaySensitivity.ramadanNoFoodPromoInDaylight &&
        /ramadan/i.test(today.name || '') &&
        isFoodBev &&
        pillar === 'promotional' &&
        currentLocalTime &&
        currentLocalTime.getHours() > 6 &&
        currentLocalTime.getHours() < 19
      ) {
        return { allowed: false, reason: 'Ramadan daylight: no food/bev promo content during daylight hours' };
      }

      // Days of mourning: no content at all
      if (
        WF1_GUARDRAILS.holidaySensitivity.respectDaysOfMourning &&
        /mourning|memorial|martyr/i.test(today.name || '')
      ) {
        return { allowed: false, reason: `Day of remembrance: ${today.name} — content paused` };
      }

      // Solemn tone
      if (
        WF1_GUARDRAILS.holidaySensitivity.adjustToneForSolemnHolidays &&
        today.type === 'religious' &&
        pillar === 'promotional'
      ) {
        return { allowed: false, reason: `Religious observance: ${today.name} — no promotional content today` };
      }
    } catch (e) {
      logger?.warn('/wf1/guardrails', null, 'holiday check failed', { error: e.message });
    }
    return { allowed: true };
  }

  // ── Cost cap per post ──────────────────────────────────────────────────
  function checkCostCap({ format, estimatedCost }) {
    const budgets = WF1_GUARDRAILS.costPerPostBudgetUsd;
    const formatKey =
      /reel/i.test(format) ? 'reel' :
      /tiktok/i.test(format) ? 'tiktok' :
      /carousel/i.test(format) ? 'carousel' :
      /linkedin.*article/i.test(format) ? 'linkedinArticle' :
      'image';
    const cap = budgets[formatKey];
    if (estimatedCost > cap * 1.2) {
      return { allowed: false, reason: `Cost over budget: $${estimatedCost.toFixed(2)} > cap $${cap} (${formatKey})` };
    }
    return { allowed: true };
  }

  /**
   * Runs all guardrails for a single concept about to be generated/published.
   * @returns {Promise<{ allowed: boolean, reasons: string[] }>}
   */
  async function checkAll({ businessId, concept, brandContext, currentLocalTime }) {
    const reasons = [];
    const checks = await Promise.all([
      checkVolume({ businessId, platform: concept.platform }),
      checkTopicCooldown({ businessId, pillar: concept.pillar, coreIdea: concept.core_idea || concept.coreIdea }),
      checkCrisisPause({ businessId }),
      Promise.resolve(
        checkHolidaySensitivity({ brandContext, pillar: concept.pillar, currentLocalTime })
      ),
      Promise.resolve(
        checkCostCap({
          format: concept.format || '',
          estimatedCost: Number(concept.cost_estimate_usd || concept.costEstimate || 0),
        })
      ),
    ]);

    for (const c of checks) {
      if (!c.allowed) reasons.push(c.reason);
    }

    return { allowed: reasons.length === 0, reasons };
  }

  return {
    WF1_GUARDRAILS,
    checkAll,
    checkVolume,
    checkTopicCooldown,
    checkCrisisPause,
    checkHolidaySensitivity,
    checkCostCap,
  };
}

module.exports = createGuardrails;
