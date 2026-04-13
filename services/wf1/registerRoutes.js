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
        `business_id=eq.${businessId}&plan_date=eq.${resolvedDate}&select=*`
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
      const concepts = await sbGet(
        'content_concepts',
        `plan_id=eq.${plan.id}&order=created_at.asc&select=*`
      ).catch(() => []);

      // Fetch latest asset per concept
      const conceptIds = concepts.map(c => c.id);
      let assets = [];
      if (conceptIds.length) {
        const inList = conceptIds.map(id => `"${id}"`).join(',');
        assets = await sbGet(
          'content_assets',
          `concept_id=in.(${inList})&order=generated_at.desc&select=*`
        ).catch(() => []);
      }
      const assetByConcept = {};
      for (const a of assets) {
        if (!assetByConcept[a.concept_id]) assetByConcept[a.concept_id] = a;
      }

      res.json({
        date: plan.plan_date,
        status: plan.status,
        analysis: plan.analysis,
        concepts: concepts.map(c => ({
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
          predictedEngagementRange: [
            Number(c.predicted_engagement_low || 0),
            Number(c.predicted_engagement_high || 0),
          ],
          riskLevel: c.risk_level,
          qualityScore: c.quality_score != null ? Number(c.quality_score) : null,
          status: c.status,
          generatedAsset: assetByConcept[c.id] ? {
            caption: assetByConcept[c.id].caption,
            hashtags: assetByConcept[c.id].hashtags || [],
            visualBrief: assetByConcept[c.id].visual_brief,
            postingTime: {
              localTime: assetByConcept[c.id].posting_time_local,
              rationale: assetByConcept[c.id].posting_time_rationale,
            },
            predictedQualityScore: Number(assetByConcept[c.id].predicted_quality_score || 0),
          } : null,
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
    if (!['approve', 'reject', 'edit'].includes(decision))
      return apiError(res, 400, 'INVALID_REQUEST', 'decision must be approve|reject|edit');

    try {
      // Update concept row
      await sbPatch('content_concepts', `id=eq.${conceptId}`, {
        status: decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'approved',
        rejection_reason: decision === 'reject' ? reason || 'manual reject' : null,
        decided_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).catch(() => {});

      // Approvals row: try to find latest approval for this entity
      const approvalRows = await sbGet(
        'approvals',
        `workflow=eq.1_daily_content&entity_type=eq.asset&business_id=eq.${businessId}&status=eq.pending&order=created_at.desc&limit=5&select=id,entity_id`
      ).catch(() => []);
      for (const ap of approvalRows) {
        await sbPatch('approvals', `id=eq.${ap.id}`, {
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
          `concept_id=eq.${conceptId}&order=generated_at.desc&limit=1&select=id`
        ).catch(() => []);
        if (assetRows[0]) {
          if (editedCaption) {
            await sbPatch('content_assets', `id=eq.${assetRows[0].id}`, {
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
      await sbPatch('businesses', `id=eq.${businessId}`, {
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
  app.post('/webhook/wf1-run-daily', async (req, res) => {
    const { businessId, force } = req.body || {};
    try {
      if (businessId) {
        const r = await wf1.dailyRun.runForBusiness({ businessId, force: !!force });
        res.json(r);
      } else {
        const r = await wf1.dailyRun.runForAllBusinesses({ force: !!force });
        res.json(r);
      }
    } catch (e) {
      logger?.error('/webhook/wf1-run-daily', businessId, 'cron failed', e);
      apiError(res, 500, 'WF1_CRON_FAILED', e.message);
    }
  });

  // ─── POST /webhook/wf1-measure-performance (cron target) ──────────
  app.post('/webhook/wf1-measure-performance', async (req, res) => {
    try {
      const r = await wf1.learningLoop.sweepDuePosts({ limit: Number(req.body?.limit || 25) });
      const fallbacks = await wf1.dailyRun.processHybridFallbacks();
      res.json({ measurement: r, hybridFallbacks: fallbacks });
    } catch (e) {
      logger?.error('/webhook/wf1-measure-performance', null, 'sweep failed', e);
      apiError(res, 500, 'WF1_MEASURE_FAILED', e.message);
    }
  });
}

module.exports = { registerWf1Routes };
