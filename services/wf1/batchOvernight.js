'use strict';

/*
 * services/wf1/batchOvernight.js
 * ----------------------------------------------------------------------------
 * Consolidates every active business's WF1 strategic-decision call into ONE
 * Anthropic Message Batch — submitted nightly, applied when the batch ends.
 *
 * 50% Sonnet cost cut on bulk content generation (the entire point of having
 * a Batch API integration).
 *
 * Two-phase design:
 *   Phase A — submitOvernightBatch({ todayLocalDate?, dryRun? })
 *     - Lists active businesses (is_active=true, has consent + active plan)
 *     - For each: gathers context bundle (Phase 1 of WF1) + builds the
 *       strategic-decision prompt (the Sonnet/Opus call WF1 normally fires)
 *     - Skips any business that already has a content_plan for today
 *     - Submits all in one batch with custom_id = `wf1:<businessId>:<date>`
 *     - Persists request_index so the apply phase knows where each response goes
 *
 *   Phase B — applyOvernightBatch({ anthropicBatchId })
 *     - Polls until ended
 *     - For each succeeded request:
 *         · Parses the response into analysis + concepts (same shape as
 *           the synchronous WF1 path)
 *         · Writes content_plans + content_concepts rows for that business
 *         · Marks the anthropic_batch_results row applied=true
 *     - Errored / canceled / expired requests fall back to the synchronous
 *       WF1 path on the next cron tick (so the customer still gets content)
 *
 * Cron pattern (Railway / n8n / Supabase pg_cron):
 *   23:00 UTC nightly → POST /webhook/wf1-overnight-batch-submit
 *   every 10 min      → POST /webhook/wf1-overnight-batch-apply (no-op if not ended)
 * ----------------------------------------------------------------------------
 */

const {
  buildStrategicDecisionPrompt,
} = require('../prompts/workflow_1_daily_content.js');

const SONNET_MODEL = 'claude-sonnet-4-5';
const OPUS_MODEL = 'claude-opus-4-7';
const MAX_TOKENS = 4096;
const BATCH_HARD_CAP = 1000; // safety: even if Anthropic supports 100k, cap our nightly to 1000 businesses per batch

function createBatchOvernight(deps) {
  const {
    sbGet, sbPost, sbPatch,
    extractJSON,
    logger,
    contextBundleBuilder,
    buildBrandContext,
    batchService,
  } = deps;
  if (!batchService) throw new Error('batchOvernight: batchService dep required');
  if (!contextBundleBuilder) throw new Error('batchOvernight: contextBundleBuilder dep required');

  function localDateFor(profile) {
    const tz = profile?.timezone || 'Europe/Belgrade';
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }

  /**
   * Phase A — submit.
   */
  async function submitOvernightBatch({ dryRun = false, businessIds = null, purpose = 'wf1_overnight' } = {}) {
    let businesses;
    if (Array.isArray(businessIds) && businessIds.length) {
      const orFilter = businessIds.map((id) => `id.eq.${id}`).join(',');
      businesses = await sbGet('businesses', `or=(${orFilter})&is_active=eq.true&select=*`);
    } else {
      businesses = await sbGet('businesses', `is_active=eq.true&order=created_at.desc&select=*`);
    }
    if (businesses.length === 0) {
      return { ok: true, requestCount: 0, anthropicId: null, internalId: null, skippedExistingPlans: 0, businesses: 0 };
    }
    if (businesses.length > BATCH_HARD_CAP) {
      logger?.warn('/wf1/batchOvernight', null, `truncating to ${BATCH_HARD_CAP} businesses (saw ${businesses.length})`);
      businesses = businesses.slice(0, BATCH_HARD_CAP);
    }

    const builtRequests = [];
    const requestIndex = [];
    let skippedExistingPlans = 0;

    for (const business of businesses) {
      try {
        const profileRows = await sbGet('business_profiles', `user_id=eq.${business.id}&select=*`).catch(() => []);
        const profile = profileRows[0] || {};
        const todayLocalDate = localDateFor(profile);

        // Skip if a content_plan for today already exists (idempotent across cron retries)
        const existing = await sbGet('content_plans', `business_id=eq.${business.id}&plan_date=eq.${todayLocalDate}&select=id`).catch(() => []);
        if (existing[0]) {
          skippedExistingPlans++;
          continue;
        }

        const brandContext = buildBrandContext({ business, profile });
        const bundle = await contextBundleBuilder.gatherBundle({ businessId: business.id, brandContext, todayLocalDate });
        const { system, user } = buildStrategicDecisionPrompt(brandContext, bundle);

        const isAgency = String(business.plan || '').toLowerCase() === 'agency';
        const customId = `wf1:${business.id}:${todayLocalDate}`;

        const req = batchService.buildRequest({
          customId,
          model: isAgency ? OPUS_MODEL : SONNET_MODEL,
          system,
          prompt: user,
          maxTokens: MAX_TOKENS,
          cacheSystem: true, // strategic-decision system prompt is large + repeated → ideal cache target
        });
        builtRequests.push(req);
        requestIndex.push({
          custom_id: customId,
          business_id: business.id,
          target_table: 'content_plans',
          plan_date: todayLocalDate,
        });
      } catch (e) {
        logger?.warn('/wf1/batchOvernight', business.id, 'request build failed — skipping', { error: e.message });
      }
    }

    if (builtRequests.length === 0) {
      return { ok: true, requestCount: 0, skippedExistingPlans, anthropicId: null, internalId: null, businesses: businesses.length };
    }
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        requestCount: builtRequests.length,
        skippedExistingPlans,
        sample: builtRequests.slice(0, 3).map((r) => ({ custom_id: r.custom_id, model: r.params.model })),
      };
    }

    const submitted = await batchService.submitBatch(builtRequests, {
      purpose,
      requestIndex,
      metadata: { source: 'wf1_overnight', count: builtRequests.length },
    });
    return {
      ok: true,
      anthropicId: submitted.anthropicId,
      internalId: submitted.internalId,
      requestCount: submitted.requestCount,
      skippedExistingPlans,
      businesses: businesses.length,
      submittedAt: submitted.submittedAt,
      expiresAt: submitted.expiresAt,
    };
  }

  /**
   * Phase B — apply.
   * Polls the batch, fetches results, persists per-business content_plans
   * + content_concepts rows. Idempotent on retries (skips already-applied).
   */
  async function applyOvernightBatch({ anthropicBatchId }) {
    if (!anthropicBatchId) throw new Error('applyOvernightBatch: anthropicBatchId required');

    const reconciled = await batchService.reconcileResults(anthropicBatchId);
    if (!reconciled.results || reconciled.results.length === 0) {
      return { ok: true, status: reconciled.polled?.processing_status, applied: 0, written: 0 };
    }

    const internalRows = await sbGet('anthropic_batches', `anthropic_batch_id=eq.${anthropicBatchId}&select=id,request_index`).catch(() => []);
    const requestIndex = Array.isArray(internalRows[0]?.request_index) ? internalRows[0].request_index : [];
    const indexMap = new Map(requestIndex.map((e) => [e.custom_id, e]));

    let plansWritten = 0;
    let conceptsWritten = 0;
    let errors = 0;

    for (const r of reconciled.results) {
      try {
        const idx = indexMap.get(r.custom_id);
        if (!idx) continue; // unknown request — skip
        if (r.result?.type !== 'succeeded') continue;
        const businessId = idx.business_id;
        if (!businessId) continue;

        // Idempotency: if a plan for this date already exists, skip
        const existing = await sbGet('content_plans', `business_id=eq.${businessId}&plan_date=eq.${idx.plan_date}&select=id`).catch(() => []);
        if (existing[0]) continue;

        const text = r.result.message?.content?.find?.((b) => b.type === 'text')?.text || '';
        const parsed = extractJSON(text) || {};
        const analysis = parsed.analysis || {};
        const conceptsIn = Array.isArray(parsed.concepts) ? parsed.concepts : [];

        const planRow = await sbPost('content_plans', {
          business_id: businessId,
          plan_date: idx.plan_date,
          status: conceptsIn.length ? 'awaiting_approval' : 'skipped',
          analysis,
          context_snapshot: { source: 'batch_overnight', anthropic_batch_id: anthropicBatchId },
          model_used: r.result.message?.model || 'batch',
        });
        plansWritten++;

        for (const c of conceptsIn) {
          const row = await sbPost('content_concepts', {
            business_id: businessId,
            plan_id: planRow.id,
            platform: c.platform,
            format: c.format,
            pillar: c.pillar,
            funnel_stage: c.funnelStage,
            emotion: c.emotion,
            core_idea: c.coreIdea,
            hook: c.hook,
            hook_pattern: c.hookPattern || null,
            story_arc: c.storyArc || null,
            cta: c.cta,
            framework: c.framework,
            why_this_why_now: c.whyThisWhyNow,
            predicted_engagement_low: Array.isArray(c.predictedEngagementRange) ? c.predictedEngagementRange[0] : null,
            predicted_engagement_high: Array.isArray(c.predictedEngagementRange) ? c.predictedEngagementRange[1] : null,
            risk_level: c.riskLevel || 'low',
            cost_estimate_usd: c.costEstimate || 0,
            status: 'pending',
          }).catch((e) => {
            logger?.warn('/wf1/batchOvernight.apply', businessId, 'concept insert failed', { error: e.message });
            return null;
          });
          if (row) conceptsWritten++;
        }

        await sbPost('events', {
          business_id: businessId,
          kind: 'wf1.plan.created.via_batch',
          workflow: 'wf1',
          payload: { plan_id: planRow.id, anthropic_batch_id: anthropicBatchId, custom_id: r.custom_id },
          severity: 'info',
        }).catch(() => {});

        // Mark the anthropic_batch_results row applied=true
        const matchingResultRows = await sbGet('anthropic_batch_results', `custom_id=eq.${r.custom_id}&order=created_at.desc&limit=1&select=id`).catch(() => []);
        if (matchingResultRows[0]?.id) {
          await sbPatch('anthropic_batch_results', `id=eq.${matchingResultRows[0].id}`, { applied: true, applied_at: new Date().toISOString() }).catch(() => {});
        }
      } catch (e) {
        errors++;
        logger?.warn('/wf1/batchOvernight.apply', null, 'apply error', { custom_id: r.custom_id, error: e.message });
      }
    }

    return {
      ok: true,
      status: reconciled.polled?.processing_status,
      applied: reconciled.applied,
      plansWritten,
      conceptsWritten,
      errors,
      results_count: reconciled.results.length,
    };
  }

  return { submitOvernightBatch, applyOvernightBatch, constants: { BATCH_HARD_CAP, SONNET_MODEL, OPUS_MODEL, MAX_TOKENS } };
}

module.exports = createBatchOvernight;
