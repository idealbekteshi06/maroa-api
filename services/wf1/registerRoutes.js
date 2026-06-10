/*
 * services/wf1/registerRoutes.js
 * ----------------------------------------------------------------------------
 * Mounts the 8 WF1 Express routes matching the frontend api.ts contract:
 *
 *   POST /webhook/wf1-strategic-decision   — run Phase 1+2 now
 *   POST /webhook/wf1-plan-get             — fetch plan + concepts + assets
 *   GET  /webhook/wf1-plan-get             — same via query params
 *   POST /webhook/wf1-generate-asset       — run Phase 3+4 for one concept
 *   POST /webhook/wf1-decision             — approve/reject/edit
 *   POST /webhook/wf1-learning-state       — read learning loop state
 *   GET  /webhook/wf1-learning-state       — same via query params
 *   POST /webhook/wf1-autonomy-mode        — update autonomy
 *   POST /webhook/wf1-run-daily            — cron target for daily run
 *   POST /webhook/wf1-measure-performance  — cron target for 48h learning
 *
 * All routes use the existing `/webhook` auth middleware (x-webhook-secret).
 * ----------------------------------------------------------------------------
 */

'use strict';

const internalDispatcher = require('../../lib/internalDispatcher');

// Tenant-isolation: every entity id interpolated into a PostgREST filter must
// be UUID-validated + encoded, and every row touched by entity id must be
// scoped to the caller's already-verified business_id (the /webhook owner gate
// only verifies the business_id itself, not that a secondary entity belongs to
// it). See lib/assertBusinessOwner.js + CLAUDE.md Rule 4.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const enc = encodeURIComponent;

function registerWf1Routes({ app, wf1, sbGet, sbPost, sbPatch, apiError, logger }) {
  // ─── POST /webhook/wf1-strategic-decision ──────────────────────────
  app.post('/webhook/wf1-strategic-decision', async (req, res) => {
    const { businessId, forceReplan } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const result = await wf1.engine.runStrategicDecision({ businessId, forceReplan: !!forceReplan });
      res.json({
        runId: result.runId,
        analysis: result.analysis,
        concepts: result.concepts,
        reused: result.reused,
      });
    } catch (e) {
      logger?.error('/webhook/wf1-strategic-decision', businessId, 'run failed', e);
      apiError(res, 500, 'WF1_STRATEGIC_FAILED', e.message);
    }
  });

  // ─── GET/POST /webhook/wf1-plan-get ────────────────────────────────
  async function planGetHandler(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    const date = req.body?.date || req.query?.date;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');

    try {
      // Default date: today in business local TZ
      const resolvedDate = date || (await wf1.engine.resolveLocalDate(businessId));

      const planRows = await sbGet(
        'content_plans',
        `business_id=eq.${enc(businessId)}&plan_date=eq.${enc(resolvedDate)}&select=*`
      ).catch(() => []);

      if (!planRows[0]) {
        return res.json({
          date: resolvedDate,
          status: 'draft',
          analysis: null,
          concepts: [],
        });
      }
      const plan = planRows[0];
      // plan already scoped to business_id above; concepts/assets chain off it.
      const concepts = await sbGet(
        'content_concepts',
        `plan_id=eq.${enc(plan.id)}&order=created_at.asc&select=*`
      ).catch(() => []);

      // Fetch latest asset per concept
      const conceptIds = concepts.map((c) => c.id);
      let assets = [];
      if (conceptIds.length) {
        const inList = conceptIds.map((id) => `"${enc(id)}"`).join(',');
        assets = await sbGet('content_assets', `concept_id=in.(${inList})&order=generated_at.desc&select=*`).catch(
          () => []
        );
      }
      const assetByConcept = {};
      for (const a of assets) {
        if (!assetByConcept[a.concept_id]) assetByConcept[a.concept_id] = a;
      }

      res.json({
        date: plan.plan_date,
        status: plan.status,
        analysis: plan.analysis,
        concepts: concepts.map((c) => ({
          id: c.id,
          platform: c.platform,
          format: c.format,
          pillar: c.pillar,
          funnelStage: c.funnel_stage,
          emotion: c.emotion,
          coreIdea: c.core_idea,
          hook: c.hook,
          cta: c.cta,
          framework: c.framework,
          whyThisWhyNow: c.why_this_why_now,
          predictedEngagementRange: [Number(c.predicted_engagement_low || 0), Number(c.predicted_engagement_high || 0)],
          riskLevel: c.risk_level,
          qualityScore: c.quality_score != null ? Number(c.quality_score) : null,
          status: c.status,
          generatedAsset: assetByConcept[c.id]
            ? {
                caption: assetByConcept[c.id].caption,
                hashtags: assetByConcept[c.id].hashtags || [],
                visualBrief: assetByConcept[c.id].visual_brief,
                postingTime: {
                  localTime: assetByConcept[c.id].posting_time_local,
                  rationale: assetByConcept[c.id].posting_time_rationale,
                },
                predictedQualityScore: Number(assetByConcept[c.id].predicted_quality_score || 0),
              }
            : null,
        })),
      });
    } catch (e) {
      logger?.error('/webhook/wf1-plan-get', businessId, 'fetch failed', e);
      apiError(res, 500, 'WF1_PLAN_GET_FAILED', e.message);
    }
  }
  app.post('/webhook/wf1-plan-get', planGetHandler);
  app.get('/webhook/wf1-plan-get', planGetHandler);

  // ─── POST /webhook/wf1-generate-asset ──────────────────────────────
  app.post('/webhook/wf1-generate-asset', async (req, res) => {
    const { businessId, conceptId } = req.body || {};
    if (!businessId || !conceptId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId + conceptId required');
    try {
      const result = await wf1.engine.generateAssetForConcept({ businessId, conceptId });
      if (result.blocked) {
        return res.status(422).json({ blocked: true, reasons: result.reasons });
      }
      res.json({ assetId: result.assetId, qualityScore: result.qualityScore });
    } catch (e) {
      logger?.error('/webhook/wf1-generate-asset', businessId, 'gen failed', e);
      apiError(res, 500, 'WF1_GEN_FAILED', e.message);
    }
  });

  // ─── POST /webhook/wf1-decision ────────────────────────────────────
  app.post('/webhook/wf1-decision', async (req, res) => {
    const { businessId, conceptId, decision, editedCaption, reason } = req.body || {};
    if (!businessId || !conceptId || !decision)
      return apiError(res, 400, 'INVALID_REQUEST', 'businessId, conceptId, decision required');
    if (!isUuid(conceptId)) return apiError(res, 400, 'INVALID_REQUEST', 'conceptId must be a valid UUID');
    if (!['approve', 'reject', 'edit'].includes(decision))
      return apiError(res, 400, 'INVALID_REQUEST', 'decision must be approve|reject|edit');

    try {
      // Tenant-isolation: the owner gate verified businessId, NOT that this
      // concept belongs to it. Scope every concept/asset filter to businessId
      // so a victim's conceptId can never be touched cross-tenant.
      // Update concept row
      await sbPatch('content_concepts', `id=eq.${enc(conceptId)}&business_id=eq.${enc(businessId)}`, {
        status: decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'approved',
        rejection_reason: decision === 'reject' ? reason || 'manual reject' : null,
        decided_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).catch(() => {});

      // Approvals row: try to find latest approval for this entity
      const approvalRows = await sbGet(
        'approvals',
        `workflow=eq.1_daily_content&entity_type=eq.asset&business_id=eq.${enc(businessId)}&status=eq.pending&order=created_at.desc&limit=5&select=id,entity_id`
      ).catch(() => []);
      for (const ap of approvalRows) {
        await sbPatch('approvals', `id=eq.${enc(ap.id)}&business_id=eq.${enc(businessId)}`, {
          status: decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'edited',
          decided_at: new Date().toISOString(),
          decision_reason: reason || null,
          edited_payload: editedCaption ? { caption: editedCaption } : null,
        }).catch(() => {});
      }

      // If approved, trigger publish of the latest asset for this concept
      let publishResult = null;
      if (decision === 'approve' || decision === 'edit') {
        const assetRows = await sbGet(
          'content_assets',
          `concept_id=eq.${enc(conceptId)}&business_id=eq.${enc(businessId)}&order=generated_at.desc&limit=1&select=id`
        ).catch(() => []);
        if (assetRows[0]) {
          if (editedCaption) {
            await sbPatch('content_assets', `id=eq.${enc(assetRows[0].id)}&business_id=eq.${enc(businessId)}`, {
              caption: editedCaption,
            }).catch(() => {});
          }
          publishResult = await wf1.publisher.publishAsset({ assetId: assetRows[0].id });
        }
      }

      // Event
      await sbPost('events', {
        business_id: businessId,
        kind: `wf1.decision.${decision}`,
        workflow: '1_daily_content',
        payload: { concept_id: conceptId, decision, reason, publish: publishResult },
        severity: 'info',
      }).catch(() => {});

      res.json({ ok: true, decision, publish: publishResult });
    } catch (e) {
      logger?.error('/webhook/wf1-decision', businessId, 'decision failed', e);
      apiError(res, 500, 'WF1_DECISION_FAILED', e.message);
    }
  });

  // ─── GET/POST /webhook/wf1-learning-state ──────────────────────────
  async function learningHandler(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try {
      const state = await wf1.learningLoop.getLearningState(businessId);
      res.json(state);
    } catch (e) {
      logger?.error('/webhook/wf1-learning-state', businessId, 'fetch failed', e);
      apiError(res, 500, 'WF1_LEARNING_FAILED', e.message);
    }
  }
  app.post('/webhook/wf1-learning-state', learningHandler);
  app.get('/webhook/wf1-learning-state', learningHandler);

  // ─── POST /webhook/wf1-autonomy-mode ───────────────────────────────
  app.post('/webhook/wf1-autonomy-mode', async (req, res) => {
    const { businessId, mode, hybridWindowHours } = req.body || {};
    if (!businessId || !mode) return apiError(res, 400, 'INVALID_REQUEST', 'businessId + mode required');
    if (!['full_autopilot', 'hybrid', 'approve_everything'].includes(mode))
      return apiError(res, 400, 'INVALID_REQUEST', 'mode must be full_autopilot|hybrid|approve_everything');
    try {
      await sbPatch('businesses', `id=eq.${enc(businessId)}`, {
        wf1_autonomy_mode: mode,
        wf1_hybrid_window_hours: hybridWindowHours ?? 4,
      });
      await sbPost('events', {
        business_id: businessId,
        kind: 'wf1.autonomy.changed',
        workflow: '1_daily_content',
        payload: { mode, hybridWindowHours },
        severity: 'info',
      }).catch(() => {});
      res.json({ ok: true, mode, hybridWindowHours: hybridWindowHours ?? 4 });
    } catch (e) {
      logger?.error('/webhook/wf1-autonomy-mode', businessId, 'set failed', e);
      apiError(res, 500, 'WF1_AUTONOMY_FAILED', e.message);
    }
  });

  // ─── POST /webhook/wf1-run-daily (cron target) ─────────────────────
  // Highest-volume cron in the system — runs daily for every business.
  // Registered with the in-process dispatcher so Inngest skips loopback.
  // See ADR-0006.
  async function runWf1Daily({ businessId, force }) {
    if (businessId) {
      return wf1.dailyRun.runForBusiness({ businessId, force: !!force });
    }
    return wf1.dailyRun.runForAllBusinesses({ force: !!force });
  }
  internalDispatcher.register('/webhook/wf1-run-daily', (body) => runWf1Daily(body || {}));

  app.post('/webhook/wf1-run-daily', async (req, res) => {
    const { businessId } = req.body || {};
    try {
      const r = await runWf1Daily(req.body || {});
      res.json(r);
    } catch (e) {
      logger?.error('/webhook/wf1-run-daily', businessId, 'cron failed', e);
      apiError(res, 500, 'WF1_CRON_FAILED', e.message);
    }
  });

  async function runWf1MeasurePerformance(body = {}) {
    const r = await wf1.learningLoop.sweepDuePosts({ limit: Number(body.limit || 25) });
    const fallbacks = await wf1.dailyRun.processHybridFallbacks();
    return { measurement: r, hybridFallbacks: fallbacks };
  }
  internalDispatcher.register('/webhook/wf1-measure-performance', (body) => runWf1MeasurePerformance(body || {}));

  // ─── POST /webhook/wf1-measure-performance (cron target) ──────────
  app.post('/webhook/wf1-measure-performance', async (req, res) => {
    try {
      res.json(await runWf1MeasurePerformance(req.body || {}));
    } catch (e) {
      logger?.error('/webhook/wf1-measure-performance', null, 'sweep failed', e);
      apiError(res, 500, 'WF1_MEASURE_FAILED', e.message);
    }
  });

  async function runWf1OvernightBatchSubmit(body = {}) {
    if (!wf1.batchOvernight) throw new Error('batchService not configured');
    const { dryRun, businessIds } = body;
    return wf1.batchOvernight.submitOvernightBatch({
      dryRun: !!dryRun,
      businessIds: Array.isArray(businessIds) ? businessIds : null,
    });
  }
  internalDispatcher.register('/webhook/wf1-overnight-batch-submit', (body) => runWf1OvernightBatchSubmit(body || {}));

  async function runWf1MonthlyBatchSubmit(body = {}) {
    if (!wf1.batchOvernight) throw new Error('batchService not configured');
    return wf1.batchOvernight.submitOvernightBatch({
      dryRun: !!body.dryRun,
      businessIds: Array.isArray(body.businessIds) ? body.businessIds : null,
      purpose: 'wf1_monthly',
    });
  }
  internalDispatcher.register('/webhook/wf1-monthly-batch-submit', (body) => runWf1MonthlyBatchSubmit(body || {}));

  app.post('/webhook/wf1-monthly-batch-submit', async (req, res) => {
    if (!wf1.batchOvernight) {
      return apiError(res, 503, 'BATCH_OVERNIGHT_DISABLED', 'batchService not configured');
    }
    try {
      res.json(await runWf1MonthlyBatchSubmit(req.body || {}));
    } catch (e) {
      logger?.error('/webhook/wf1-monthly-batch-submit', null, 'submit failed', e);
      apiError(res, 500, 'WF1_MONTHLY_BATCH_FAILED', e.message);
    }
  });

  app.post('/webhook/wf1-overnight-batch-submit', async (req, res) => {
    if (!wf1.batchOvernight) {
      return apiError(res, 503, 'BATCH_OVERNIGHT_DISABLED', 'batchService not configured');
    }
    try {
      res.json(await runWf1OvernightBatchSubmit(req.body || {}));
    } catch (e) {
      logger?.error('/webhook/wf1-overnight-batch-submit', null, 'submit failed', e);
      apiError(res, 500, 'WF1_BATCH_SUBMIT_FAILED', e.message);
    }
  });

  // ─── POST /webhook/wf1-overnight-batch-apply (cron target, every 10 min) ─
  // Polls a submitted batch; when ended, parses each succeeded response and
  // writes content_plans + content_concepts rows. Idempotent on retries.
  // Body: { anthropicBatchId: string }
  app.post('/webhook/wf1-overnight-batch-apply', async (req, res) => {
    if (!wf1.batchOvernight) {
      return apiError(
        res,
        503,
        'BATCH_OVERNIGHT_DISABLED',
        'batchService not configured — overnight batch unavailable'
      );
    }
    const { anthropicBatchId } = req.body || {};
    if (!anthropicBatchId) return apiError(res, 400, 'INVALID_REQUEST', 'anthropicBatchId required');
    try {
      const result = await wf1.batchOvernight.applyOvernightBatch({ anthropicBatchId });
      res.json(result);
    } catch (e) {
      logger?.error('/webhook/wf1-overnight-batch-apply', null, 'apply failed', e);
      apiError(res, 500, 'WF1_BATCH_APPLY_FAILED', e.message);
    }
  });

  async function runWf1OvernightBatchApplyAll() {
    if (!wf1.batchOvernight) throw new Error('batchService not configured');
    const inflight = await sbGet(
      'anthropic_batches',
      'status=eq.in_progress&purpose=eq.wf1_overnight&select=anthropic_batch_id&limit=50'
    ).catch(() => []);
    const results = [];
    let applied = 0;
    let errors = 0;
    for (const row of inflight) {
      try {
        const r = await wf1.batchOvernight.applyOvernightBatch({ anthropicBatchId: row.anthropic_batch_id });
        results.push({ anthropicBatchId: row.anthropic_batch_id, ...r });
        if (r?.status === 'ended' || r?.applied) applied += 1;
      } catch (e) {
        errors += 1;
        results.push({ anthropicBatchId: row.anthropic_batch_id, ok: false, error: e.message });
        logger?.error('/webhook/wf1-overnight-batch-apply-all', null, 'apply failed', {
          anthropicBatchId: row.anthropic_batch_id,
          error: e.message,
        });
      }
    }
    return { scanned: inflight.length, applied, errors, results };
  }
  internalDispatcher.register('/webhook/wf1-overnight-batch-apply-all', () => runWf1OvernightBatchApplyAll());

  app.post('/webhook/wf1-overnight-batch-apply-all', async (req, res) => {
    if (!wf1.batchOvernight) {
      return apiError(res, 503, 'BATCH_OVERNIGHT_DISABLED', 'batchService not configured');
    }
    try {
      res.json(await runWf1OvernightBatchApplyAll());
    } catch (e) {
      logger?.error('/webhook/wf1-overnight-batch-apply-all', null, 'fanout failed', e);
      apiError(res, 500, 'WF1_BATCH_APPLY_ALL_FAILED', e.message);
    }
  });
}

module.exports = { registerWf1Routes };
