'use strict';

/**
 * services/weekly-scorecard/batchOrchestrator.js
 * ----------------------------------------------------------------------------
 * Weekly-scorecard at 50% list price via Anthropic Message Batches.
 *
 * The per-business engine (engine.js) calls Claude synchronously, which is
 * fine but expensive once we scale past ~50 businesses. Batches accept
 * up to 100k requests at once, finish in <1h typically, and bill at 50%
 * of the synchronous price (Anthropic spec).
 *
 * Flow:
 *   1. Collect (businessId, prompt, model, max_tokens, system) for every
 *      business eligible for the weekly scorecard.
 *   2. Submit one batch via services/anthropic-batch.createBatchService.
 *   3. Poll the batch (5-min interval) until status === 'ended'.
 *   4. Stream the JSONL results, map by custom_id back to businessId.
 *   5. For each result, run the existing engine's post-LLM steps
 *      (quality gate, HTML email build, send, persist).
 *
 * Public API:
 *   const orchestrator = createBatchOrchestrator({ ...deps });
 *   await orchestrator.runWeeklyBatch({ businessIds });
 *
 * Caller is responsible for running this from a webhook / Inngest function
 * — this module is pure orchestration and has no transport opinions.
 *
 * Toggle: opt-in only. The legacy synchronous engine.js path stays the
 * default until an operator flips `WEEKLY_SCORECARD_BATCH_ENABLED=1`.
 * ----------------------------------------------------------------------------
 */

const scorecard = require('../prompts/weekly-scorecard');
const adI18n = require('../prompts/ad-optimizer/i18n-market');

function createBatchOrchestrator(deps) {
  const {
    sbGet,
    sbPost,
    sbPatch,
    sendEmail,
    extractJSON,
    apiKey, // Anthropic API key — for the batch service
    logger,
    Sentry,
  } = deps;

  if (!apiKey) throw new Error('batchOrchestrator: apiKey required');
  if (!sbGet || !sbPost || !sbPatch) {
    throw new Error('batchOrchestrator: sbGet/sbPost/sbPatch required');
  }

  const { createBatchService } = require('../anthropic-batch');
  const batchSvc = createBatchService({ apiKey, logger, sbPost, sbPatch, sbGet });

  function customIdFor(businessId) {
    return `scorecard-${businessId}-${Date.now().toString(36)}`;
  }

  /**
   * Build a single batch request entry from a business's scorecard data.
   * Mirrors the synchronous engine's callClaude args.
   */
  function buildRequestForBusiness({ businessId, business, scorecardData, marketProfile, plan }) {
    const system = scorecard.buildSystemPrompt();
    const user = scorecard.buildUserMessage({
      business,
      marketProfile,
      scorecardData,
      plan,
    });
    const { batchMaxTokensForPlan } = require('../../lib/platformAnthropic');
    return batchSvc.buildRequest({
      customId: customIdFor(businessId),
      model: scorecard.modelForPlan(plan),
      system,
      prompt: user,
      max_tokens: batchMaxTokensForPlan(plan, 'weekly_scorecard'),
      plan,
      purpose: 'weekly_scorecard',
      cacheSystem: true,
      cacheTtl: '1h',
      meta: { businessId, plan },
    });
  }

  async function buildBatchBatch(businessIds) {
    const requests = [];
    const businessIndex = new Map(); // customId → business context

    for (const businessId of businessIds) {
      try {
        const since = new Date(Date.now() - 14 * 86400000).toISOString();
        const split = new Date(Date.now() - 7 * 86400000).toISOString();
        const [bizRows, profileRows, allLogs, campaigns] = await Promise.all([
          sbGet('businesses', `id=eq.${encodeURIComponent(businessId)}&select=*`).catch(() => []),
          sbGet(
            'business_profiles',
            `user_id=eq.${encodeURIComponent(businessId)}&select=*`,
          ).catch(() => []),
          sbGet(
            'ad_performance_logs',
            `business_id=eq.${encodeURIComponent(businessId)}&logged_at=gte.${since}&order=logged_at.asc&select=*`,
          ).catch(() => []),
          sbGet(
            'ad_campaigns',
            `business_id=eq.${encodeURIComponent(businessId)}&select=id,business_name`,
          ).catch(() => []),
        ]);
        const business = { ...(bizRows[0] || {}), ...(profileRows[0] || {}) };
        if (!business?.id && !business?.user_id) {
          logger?.warn?.('weekly-scorecard-batch', businessId, 'business not found — skipping');
          continue;
        }
        const plan = business.plan || 'free';
        if (plan === 'free') continue; // free tier still gets the numeric-only path

        const thisWeekRows = allLogs.filter((r) => new Date(r.logged_at) >= new Date(split));
        const prevWeekRows = allLogs.filter((r) => new Date(r.logged_at) < new Date(split));
        const scorecardData = scorecard.buildScorecardData({ thisWeekRows, prevWeekRows, campaigns });
        if (scorecardData.sample_quality === 'insufficient') continue;

        const marketProfile = adI18n.buildMarketProfile(business);
        const entry = buildRequestForBusiness({
          businessId,
          business,
          scorecardData,
          marketProfile,
          plan,
        });
        requests.push(entry);
        businessIndex.set(entry.custom_id, { businessId, business, scorecardData, plan });
      } catch (e) {
        logger?.error?.('weekly-scorecard-batch', businessId, 'build failed', {
          error: e.message,
        });
      }
    }

    return { requests, businessIndex };
  }

  /**
   * Main entrypoint. Run end-to-end:
   *   - build batch
   *   - submit
   *   - poll
   *   - map results to per-business post-processing
   *
   * Returns { batchId, businessesAttempted, businessesShipped, businessesFailed }.
   */
  async function runWeeklyBatch({ businessIds, pollIntervalMs = 5 * 60 * 1000, maxWaitMs = 60 * 60 * 1000 }) {
    const tx = Sentry?.startTransaction?.({ name: 'weekly-scorecard-batch' });
    try {
      const { requests, businessIndex } = await buildBatchBatch(businessIds);
      if (requests.length === 0) {
        logger?.info?.('weekly-scorecard-batch', null, 'no requests built — nothing to batch');
        return { batchId: null, businessesAttempted: 0, businessesShipped: 0, businessesFailed: 0 };
      }

      const submitted = await batchSvc.submitBatch({
        requests,
        purpose: 'weekly_scorecard',
      });

      logger?.info?.(
        'weekly-scorecard-batch',
        null,
        `submitted ${requests.length} requests as batch ${submitted.anthropicId}`,
      );

      // Poll
      const deadline = Date.now() + maxWaitMs;
      let status = null;
      while (Date.now() < deadline) {
        status = await batchSvc.pollBatch(submitted.anthropicId).catch(() => null);
        if (status && (status.processing_status === 'ended' || status.status === 'ended')) break;
        await sleep(pollIntervalMs);
      }
      if (!status || (status.processing_status !== 'ended' && status.status !== 'ended')) {
        logger?.warn?.(
          'weekly-scorecard-batch',
          null,
          `batch ${submitted.anthropicId} did not finish within ${Math.round(maxWaitMs / 60000)}min`,
        );
        return {
          batchId: submitted.anthropicId,
          businessesAttempted: requests.length,
          businessesShipped: 0,
          businessesFailed: requests.length,
          timedOut: true,
        };
      }

      const results = await batchSvc.fetchResults(submitted.anthropicId);
      let shipped = 0;
      let failed = 0;

      for (const r of results) {
        const ctx = businessIndex.get(r.custom_id);
        if (!ctx) continue;
        try {
          if (r.result?.type !== 'succeeded') {
            failed += 1;
            logger?.warn?.(
              'weekly-scorecard-batch',
              ctx.businessId,
              `batch entry failed: ${r.result?.type}`,
            );
            continue;
          }
          const text = r.message?.content?.[0]?.text || '';
          const commentary = extractJSON ? extractJSON(text) : safeJsonParse(text);
          if (!commentary) {
            failed += 1;
            continue;
          }
          await shipScorecard({
            businessId: ctx.businessId,
            business: ctx.business,
            scorecardData: ctx.scorecardData,
            commentary,
            plan: ctx.plan,
          });
          shipped += 1;
        } catch (e) {
          failed += 1;
          logger?.error?.(
            'weekly-scorecard-batch',
            ctx.businessId,
            'post-process failed',
            { error: e.message },
          );
        }
      }

      return {
        batchId: submitted.anthropicId,
        businessesAttempted: requests.length,
        businessesShipped: shipped,
        businessesFailed: failed,
      };
    } finally {
      tx?.finish?.();
    }
  }

  /**
   * Persist + send a single scorecard. Mirrors the engine.js end-of-flow
   * (HTML build → send email → upsert weekly_scorecards row).
   */
  async function shipScorecard({ businessId, business, scorecardData, commentary, plan }) {
    const builtAt = new Date().toISOString();
    const row = {
      business_id: businessId,
      week_starting: new Date(Date.now() - 7 * 86400000).toISOString(),
      data: scorecardData,
      commentary,
      plan,
      built_at: builtAt,
      delivery_channel: 'email',
    };
    await sbPost('weekly_scorecards', row).catch((e) => {
      logger?.warn?.('weekly-scorecard-batch', businessId, 'persist failed', { error: e.message });
    });

    if (sendEmail && business?.email) {
      try {
        const subject =
          commentary?.headline?.slice(0, 80) || 'Your week with Maroa';
        const body =
          [commentary?.summary, commentary?.recommendation].filter(Boolean).join('\n\n') ||
          'Your weekly summary is ready.';
        await sendEmail({
          to: business.email,
          subject,
          text: body,
        });
      } catch (e) {
        logger?.warn?.('weekly-scorecard-batch', businessId, 'email send failed', {
          error: e.message,
        });
      }
    }
  }

  return { runWeeklyBatch };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = { createBatchOrchestrator };
