'use strict';

/**
 * routes/agency-generate.js — Wave 60 master pipeline HTTP surface.
 *
 * Public endpoint:
 *   POST /webhook/agency-generate
 *
 * Body:
 *   {
 *     businessId: uuid,
 *     goal: string,
 *     channel?: string,
 *     industry?: string,
 *     customer_history?: object,
 *     current_content?: string,
 *     customer_type?: 'new' | 'existing',
 *   }
 *
 * Response:
 *   {
 *     ok: boolean,
 *     refused: boolean,
 *     refusal_reason?: string,
 *     run_id?: uuid,
 *     detection, route, specialist,
 *     generation, compliance, channel_validation,
 *     methodology_score, ethics,
 *     reasoning_trace, duration_ms
 *   }
 *
 * Feature gate: AGENCY_PIPELINE_ENABLED must be truthy. Otherwise returns
 * 503 with { reason: 'feature_disabled' }. Lets us deploy this surface dark
 * and flip it on per-environment without code changes.
 *
 * Telemetry:
 *   - increment agency_pipeline_calls_total{outcome,specialist}
 *   - observeHistogram agency_pipeline_duration_ms{outcome}
 *   - increment agency_pipeline_refusals_total{reason} on refusal
 */

function register({
  app,
  env,
  callClaude,
  sbPost,
  metrics,
  logger,
  aiRateLimit,
  costGuard,
  requireAuthOrWebhookSecret,
}) {
  const ENABLED = String(env.AGENCY_PIPELINE_ENABLED || '').match(/^(1|true|yes|on)$/i);

  if (!ENABLED) {
    // Register a thin 503 stub so callers get a clear answer + telemetry
    // when the flag is off. Don't crash boot if the flag is missing.
    app.post('/webhook/agency-generate', (req, res) => {
      if (metrics?.increment) metrics.increment('agency_pipeline_calls_total', { outcome: 'feature_disabled' });
      res.status(503).json({ ok: false, reason: 'feature_disabled', flag: 'AGENCY_PIPELINE_ENABLED' });
    });
    return;
  }

  // Lazy-require pipeline so a syntax error in any registry doesn't
  // crash boot for callers that don't use this surface.
  let pipeline;
  try {
    pipeline = require('../services/agency-pipeline');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[agency-generate] failed to load pipeline:', e.message);
    app.post('/webhook/agency-generate', (req, res) => {
      res.status(500).json({ ok: false, reason: 'pipeline_unavailable', detail: e.message });
    });
    return;
  }

  // Auth + rate limit + cost guard are applied via Express middleware
  // chains. Each is optional because some test harnesses don't wire all.
  const middlewares = [];
  if (requireAuthOrWebhookSecret) middlewares.push(requireAuthOrWebhookSecret);
  if (aiRateLimit) middlewares.push(aiRateLimit);
  if (costGuard) middlewares.push(costGuard);

  app.post('/webhook/agency-generate', ...middlewares, async (req, res) => {
    const startedAt = Date.now();
    const body = req.body || {};

    // Minimal validation — pipeline does deeper checks
    if (!body.businessId) {
      if (metrics?.increment) metrics.increment('agency_pipeline_calls_total', { outcome: 'bad_request' });
      return res.status(400).json({ ok: false, error: 'businessId required' });
    }
    if (!body.goal) {
      if (metrics?.increment) metrics.increment('agency_pipeline_calls_total', { outcome: 'bad_request' });
      return res.status(400).json({ ok: false, error: 'goal required' });
    }

    // Persist function: write to agency_pipeline_runs via Supabase REST
    async function persistRun(row) {
      if (!sbPost) return null;
      try {
        const inserted = await sbPost('agency_pipeline_runs', row, { returning: 'representation' });
        return inserted && inserted[0] ? inserted[0].id : null;
      } catch (e) {
        // Don't fail the request on audit write failure — log + count
        if (logger?.warn) logger.warn('agency-generate', null, 'persist failed', { err: e.message });
        if (metrics?.increment) metrics.increment('agency_pipeline_persist_errors_total');
        return null;
      }
    }

    let result;
    try {
      result = await pipeline.runAgencyPipeline(body, { callClaude, persistRun });
    } catch (e) {
      if (metrics?.increment) {
        metrics.increment('agency_pipeline_calls_total', { outcome: 'error' });
        metrics.observeHistogram('agency_pipeline_duration_ms', Date.now() - startedAt, { outcome: 'error' });
      }
      if (logger?.error) logger.error('agency-generate', null, 'pipeline crash', { err: e.message });
      return res.status(500).json({ ok: false, error: 'pipeline_crash', detail: e.message });
    }

    const outcome = result.refused
      ? result.refusal_reason && /compliance/i.test(result.refusal_reason)
        ? 'refused_compliance'
        : result.refusal_reason && /ethics/i.test(result.refusal_reason)
        ? 'refused_ethics'
        : 'refused'
      : 'ok';

    if (metrics?.increment) {
      metrics.increment('agency_pipeline_calls_total', {
        outcome,
        specialist: (result.specialist && result.specialist.id) || 'unknown',
      });
      metrics.observeHistogram('agency_pipeline_duration_ms', result.duration_ms || Date.now() - startedAt, {
        outcome,
      });
      if (result.refused) {
        metrics.increment('agency_pipeline_refusals_total', {
          reason: result.refusal_reason ? result.refusal_reason.split(':')[0] : 'unknown',
        });
      }
      if (result.ethics && typeof result.ethics.manipulation_risk_total === 'number') {
        metrics.observeHistogram('agency_pipeline_manipulation_risk', result.ethics.manipulation_risk_total, {
          specialist: (result.specialist && result.specialist.id) || 'unknown',
        });
      }
    }

    // Strip prompt_segments from response by default (can be large). Caller
    // can opt in with ?trace=1 for debugging.
    if (req.query?.trace !== '1') {
      delete result.prompt_segments;
    }

    return res.status(result.ok ? 200 : 422).json(result);
  });
}

module.exports = { register };
