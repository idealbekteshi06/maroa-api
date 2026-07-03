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
const { mapConcurrent } = require('../../lib/mapConcurrent');

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
        sbGet(
          'ad_performance_logs',
          `business_id=eq.${businessId}&logged_at=gte.${since}&order=logged_at.asc&select=*`
        ).catch(() => []),
        sbGet('ad_campaigns', `business_id=eq.${businessId}&select=id,business_name`).catch(() => []),
      ]);
      const business = { ...(bizRows[0] || {}), ...(profileRows[0] || {}) };
      if (!business?.id && !business?.user_id) throw new Error(`business ${businessId} not found`);

      const thisWeekRows = allLogs.filter((r) => new Date(r.logged_at) >= new Date(split));
      const prevWeekRows = allLogs.filter((r) => new Date(r.logged_at) < new Date(split));
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
            extra: {
              cacheSystem: true,
              temperature: 0.5,
              businessId,
              skill: 'weekly_scorecard_narrative',
            },
          });
          commentary = extractJSON(raw);

          // Quality gate on the narrative — prior code shipped commentary
          // unchecked, so slop-heavy weekly scorecards landed in customer
          // inboxes verbatim. Now every narrative string goes through gate().
          try {
            const qualityGate = require('../prompts/quality-gate');
            const narrativeText = [commentary?.headline, commentary?.summary, commentary?.recommendation]
              .filter(Boolean)
              .join('\n\n');
            if (narrativeText) {
              const gr = await qualityGate.gate({
                text: narrativeText,
                business,
                contentType: 'scorecard_text',
                plan,
                callClaude,
                extractJSON,
                logger,
                sbPost,
                skillTag: 'weekly-scorecard',
              });
              if (gr.decision !== 'reject' && gr.final_text && gr.final_text !== narrativeText) {
                // Polish landed — keep the structured fields but rewrite the
                // joined narrative so the email body benefits. Individual
                // fields stay as the LLM produced them so downstream JSON
                // consumers see consistent shape.
                commentary.polished_summary = gr.final_text;
              }
              commentary._quality_gate = {
                decision: gr.decision,
                retries: gr.retries,
                blocking: gr.blocking_issues,
              };
            }
          } catch (gateErr) {
            logger?.warn?.('weekly-scorecard', businessId, 'quality-gate failed (soft)', { error: gateErr.message });
          }
        } catch (e) {
          logger?.warn?.('weekly-scorecard', businessId, 'LLM call failed — sending plain scorecard', e?.message);
        }
      }

      const html = scorecard.buildEmailHtml({ business, marketProfile, scorecardData, commentary });

      // Send email
      let emailResult = null;
      if (!dryRun && sendEmailToOwner && business.email && typeof sendEmail === 'function') {
        try {
          emailResult = await sendEmail(
            business.email,
            `${business.business_name || 'Your business'} — Weekly Scorecard`,
            html
          );
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
    // Bounded concurrency: a strict sequential sweep timed out the Sunday cron
    // past a few hundred businesses (each does 4 reads + an LLM call). 8 in
    // flight keeps it under the Inngest deadline without hammering the DB.
    const outcomes = await mapConcurrent(businesses, 8, (b) => generateForBusiness({ businessId: b.id, dryRun }));
    for (const o of outcomes) {
      if (o.ok) results.generated++;
      else {
        results.errors++;
        logger?.warn?.('weekly-scorecard.generateForAll', o.item?.id, 'failed', o.error?.message);
      }
    }
    return results;
  }

  return { generateForBusiness, generateForAll };
}

module.exports = createEngine;
