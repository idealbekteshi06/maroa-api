'use strict';

/**
 * services/weekly-scorecard/engine.js
 * ----------------------------------------------------------------------------
 * Weekly Scorecard orchestrator. Runs Sundays 10pm via cron (replaces WF17's
 * monthly report — we go weekly because SMBs need faster feedback).
 *
 * Per business:
 *   1. Pull last 14 days of ad_performance_logs (for this-vs-prev compare)
 *   2. Build deterministic scorecard data
 *   3. Call LLM for commentary
 *   4. Build HTML email
 *   5. Send via injected sendEmail
 *   6. Persist to weekly_scorecards table
 * ----------------------------------------------------------------------------
 */

const scorecard = require('../prompts/weekly-scorecard');
const adI18n = require('../prompts/ad-optimizer/i18n-market');

function createEngine(deps) {
  const { sbGet, sbPost, sbPatch, callClaude, extractJSON, sendEmail, logger, Sentry } = deps;
  if (!sbGet || !sbPost || !sbPatch) throw new Error('weekly-scorecard engine: sbGet/sbPost/sbPatch required');

  async function generateForBusiness({ businessId, dryRun = false, sendEmailToOwner = true }) {
    const tx = Sentry?.startTransaction?.({ name: 'weekly-scorecard.generate' });
    try {
      const since = new Date(Date.now() - 14 * 86400000).toISOString();
      const split = new Date(Date.now() - 7 * 86400000).toISOString();

      const [bizRows, profileRows, allLogs, campaigns] = await Promise.all([
        sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
        sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
        sbGet('ad_performance_logs',
          `business_id=eq.${businessId}&logged_at=gte.${since}&order=logged_at.asc&select=*`
        ).catch(() => []),
        sbGet('ad_campaigns', `business_id=eq.${businessId}&select=id,business_name`).catch(() => []),
      ]);
      const business = { ...(bizRows[0] || {}), ...(profileRows[0] || {}) };
      if (!business?.id && !business?.user_id) throw new Error(`business ${businessId} not found`);

      const thisWeekRows = allLogs.filter(r => new Date(r.logged_at) >= new Date(split));
      const prevWeekRows = allLogs.filter(r => new Date(r.logged_at) < new Date(split));
      const scorecardData = scorecard.buildScorecardData({ thisWeekRows, prevWeekRows, campaigns });

      const marketProfile = adI18n.buildMarketProfile(business);

      // LLM commentary (skip on free tier — they get plain numbers)
      let commentary = null;
      const plan = business.plan || 'free';
      if (plan !== 'free' && scorecardData.sample_quality !== 'insufficient') {
        try {
          const raw = await callClaude({
            system: scorecard.buildSystemPrompt(),
            user: scorecard.buildUserMessage({ business, marketProfile, scorecardData, plan }),
            model: scorecard.modelForPlan(plan),
            max_tokens: scorecard.maxTokensForPlan(plan),
            extra: { cacheSystem: true, temperature: 0.5 },
          });
          commentary = extractJSON(raw);
        } catch (e) {
          logger?.warn?.('weekly-scorecard', businessId, 'LLM call failed — sending plain scorecard', e?.message);
        }
      }

      const html = scorecard.buildEmailHtml({ business, marketProfile, scorecardData, commentary });

      // Send email
      let emailResult = null;
      if (!dryRun && sendEmailToOwner && business.email && typeof sendEmail === 'function') {
        try {
          emailResult = await sendEmail(business.email, `${business.business_name || 'Your business'} — Weekly Scorecard`, html);
        } catch (e) {
          logger?.warn?.('weekly-scorecard', businessId, 'sendEmail failed', e?.message);
        }
      }

      // Persist
      if (!dryRun) {
        await sbPost('weekly_scorecards', {
          business_id: businessId,
          generated_at: new Date().toISOString(),
          week_data: scorecardData.week,
          previous_week_data: scorecardData.previous_week,
          deltas: scorecardData.deltas,
          best_campaign: scorecardData.best_campaign,
          worst_campaign: scorecardData.worst_campaign,
          commentary,
          html,
          plan_used: plan,
          email_sent: !!emailResult,
        }).catch((e) => logger?.warn?.('weekly-scorecard', businessId, 'persist failed', e));
      }

      return { scorecardData, commentary, html, emailResult };
    } catch (e) {
      Sentry?.captureException?.(e);
      throw e;
    } finally {
      tx?.finish?.();
    }
  }

  async function generateForAll({ dryRun = false } = {}) {
    const businesses = await sbGet('businesses', `is_active=eq.true&select=id`).catch(() => []);
    const results = { total: businesses.length, generated: 0, errors: 0 };
    for (const b of businesses) {
      try {
        await generateForBusiness({ businessId: b.id, dryRun });
        results.generated++;
      } catch (e) {
        results.errors++;
        logger?.warn?.('weekly-scorecard.generateForAll', b.id, 'failed', e?.message);
      }
    }
    return results;
  }

  return { generateForBusiness, generateForAll };
}

module.exports = createEngine;
