'use strict';

/**
 * services/cold-start/registerRoutes.js
 * ---------------------------------------------------------------------------
 * Endpoints:
 *   POST /webhook/cold-start-trigger       — kick off (called from Stripe/Paddle webhook on sign-up)
 *   GET  /webhook/cold-start-status        — customer dashboard polls this
 *   POST /webhook/cold-start-resume        — manual resume (also auto-fires from Inngest)
 *   POST /webhook/cold-start-approve       — customer taps a concept tile to approve
 *   GET  /webhook/cold-start-concepts      — list proposed concepts for the dashboard
 * ---------------------------------------------------------------------------
 */

const expressRateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

function makeLimiter(windowMs, max, name) {
  return expressRateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const bizKey = req.body?.businessId || req.body?.business_id || req.query?.businessId || req.query?.business_id;
      return `${name}:${bizKey || ipKeyGenerator(req.ip)}`;
    },
    message: { error: 'rate_limited', message: `Too many ${name} requests` },
  });
}

function registerColdStartRoutes(deps) {
  const {
    app,
    coldStart,
    apiError,
    logger,
    sbGet,
    sbPost,
    sbPatch,
    sbRpc, // optional — enables atomic cold-start concept seeding via migration 071
    callClaude,
    brandVoice,
    creativeDirector,
    higgsfield,
    adOptimizer,
    aiSeo,
    wf1,
    sentry,
  } = deps;

  // Inngest sender (optional — if INNGEST_EVENT_KEY set we trigger durable run;
  // otherwise we fall back to running phases inline). Lazy-required so tests
  // and dev environments without inngest still load.
  let inngest = null;
  try {
    inngest = require('../inngest/client').inngest;
  } catch (e) {
    logger?.warn?.('cold-start.routes', null, 'inngest client not loaded; falling back to inline runs');
  }

  function buildPhaseDeps() {
    return {
      sbGet,
      sbPost,
      sbPatch,
      sbRpc, // forwarded to phases.js so generate_concepts can use the atomic RPC
      callClaude,
      brandVoice,
      creativeDirector,
      higgsfield,
      adOptimizer,
      aiSeo,
      wf1,
      logger,
      sentry,
    };
  }

  const limit = {
    trigger: makeLimiter(60 * 1000, 5, 'cold_start_trigger'),
    status: makeLimiter(60 * 1000, 60, 'cold_start_status'),
    approve: makeLimiter(60 * 1000, 10, 'cold_start_approve'),
    resume: makeLimiter(60 * 1000, 10, 'cold_start_resume'),
  };

  // ─── POST /webhook/cold-start-trigger ────────────────────────────────────
  // Called by sign-up flow (Stripe/Paddle webhook handler) right after the
  // business row is created. Idempotent — if a run already exists, returns
  // the existing one.
  app.post('/webhook/cold-start-trigger', limit.trigger, async (req, res) => {
    const businessId = req.body?.businessId || req.body?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const run = await coldStart.ensureRun({ businessId, sbGet, sbPost });
      if (!run) return apiError(res, 500, 'COLD_START_CREATE_FAILED', 'failed to create run');

      // Fire-and-forget Inngest event if available; durable retries handled there.
      if (inngest?.send) {
        try {
          await inngest.send({
            name: 'maroa/cold-start.run',
            data: { businessId, runId: run.id },
          });
        } catch (e) {
          logger?.warn?.('/webhook/cold-start-trigger', businessId, 'inngest send failed (non-fatal)', {
            error: e.message,
          });
        }
      }
      res.json({ ok: true, run_id: run.id, status: run.status, current_phase: run.current_phase });
    } catch (e) {
      logger?.error?.('/webhook/cold-start-trigger', businessId, 'failed', e);
      sentry?.captureException?.(e, { tags: { route: 'cold-start-trigger', business_id: businessId } });
      apiError(res, 500, 'COLD_START_TRIGGER_FAILED', e.message);
    }
  });

  // ─── GET /webhook/cold-start-status?businessId=... ───────────────────────
  // Customer dashboard polls this every few seconds to render progress.
  app.get('/webhook/cold-start-status', limit.status, async (req, res) => {
    const businessId = req.query?.businessId || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const run = await coldStart.getRun({ businessId, sbGet });
      if (!run) {
        return res.json({ exists: false });
      }
      res.json({
        exists: true,
        run_id: run.id,
        status: run.status,
        current_phase: run.current_phase,
        display_state: run.display_state || {},
        last_error: run.last_error || null,
        started_at: run.started_at,
        completed_at: run.completed_at,
      });
    } catch (e) {
      apiError(res, 500, 'COLD_START_STATUS_FAILED', e.message);
    }
  });

  // ─── POST /webhook/cold-start-resume ─────────────────────────────────────
  // Manual resume — used by the photo-upload-complete trigger and by the
  // approve endpoint. Also called from the Inngest function after waiting.
  app.post('/webhook/cold-start-resume', limit.resume, async (req, res) => {
    const businessId = req.body?.businessId || req.body?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const result = await coldStart.resume({ businessId, deps: buildPhaseDeps() });
      res.json({
        ok: !!result?.run && result.run.status !== 'failed',
        status: result?.run?.status,
        current_phase: result?.run?.current_phase,
        last_error: result?.run?.last_error || null,
      });
    } catch (e) {
      logger?.error?.('/webhook/cold-start-resume', businessId, 'failed', e);
      apiError(res, 500, 'COLD_START_RESUME_FAILED', e.message);
    }
  });

  // ─── GET /webhook/cold-start-concepts?businessId=... ─────────────────────
  app.get('/webhook/cold-start-concepts', limit.status, async (req, res) => {
    const businessId = req.query?.businessId || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const concepts = await sbGet(
        'cold_start_concepts',
        `business_id=eq.${businessId}&order=variant_index.asc&select=id,variant_index,concept,preview_image_url,preview_video_url,status`
      ).catch(() => []);
      res.json({ concepts: concepts || [] });
    } catch (e) {
      apiError(res, 500, 'COLD_START_CONCEPTS_FAILED', e.message);
    }
  });

  // ─── POST /webhook/cold-start-approve ────────────────────────────────────
  app.post('/webhook/cold-start-approve', limit.approve, async (req, res) => {
    const businessId = req.body?.businessId || req.body?.business_id;
    const conceptId = req.body?.conceptId || req.body?.concept_id;
    const userId = req.body?.userId || req.body?.user_id || null;
    if (!businessId || !conceptId) {
      return apiError(res, 400, 'INVALID_REQUEST', 'businessId + conceptId required');
    }
    try {
      const result = await coldStart.approveConcept({ businessId, conceptId, userId, deps: buildPhaseDeps() });
      if (result?.ok === false) return apiError(res, 400, 'COLD_START_APPROVE_FAILED', result.reason);

      // Fire Inngest event so the durable run picks up where it paused.
      if (inngest?.send) {
        try {
          await inngest.send({
            name: 'maroa/cold-start.resume',
            data: { businessId, reason: 'concept_approved' },
          });
        } catch (e) {
          logger?.warn?.('/webhook/cold-start-approve', businessId, 'inngest send failed (non-fatal)', {
            error: e.message,
          });
        }
      }
      res.json({
        ok: true,
        status: result?.run?.status,
        current_phase: result?.run?.current_phase,
      });
    } catch (e) {
      logger?.error?.('/webhook/cold-start-approve', businessId, 'failed', e);
      apiError(res, 500, 'COLD_START_APPROVE_FAILED', e.message);
    }
  });
}

module.exports = { registerColdStartRoutes };
