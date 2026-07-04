'use strict';

/**
 * routes/ab-testing.js — creative A/B experiments (2026-07).
 *
 *   POST /webhook/ab-test-create    — pin two variant campaigns + metric
 *   POST /webhook/ab-test-evaluate  — run the z-test now, persist verdict
 *   GET  /webhook/ab-tests-list     — experiments for a business
 *
 * /webhook/* rides the global JWT + owner middleware. The engine only
 * recommends — budget moves stay with the gated ad-optimizer actuator.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (v) => typeof v === 'string' && UUID_RE.test(v);

function register({ app, abTesting, apiError, logger }) {
  if (!app || !abTesting) throw new Error('ab-testing routes: app + abTesting required');

  app.post('/webhook/ab-test-create', async (req, res) => {
    const businessId = req.body?.businessId || req.body?.business_id;
    if (!isUUID(businessId)) return apiError(res, 400, 'INVALID_BUSINESS_ID', 'businessId (UUID) required');
    try {
      const row = await abTesting.createExperiment({
        businessId,
        name: req.body?.name,
        metric: req.body?.metric,
        minImpressionsPerArm: req.body?.minImpressionsPerArm,
        variantA: req.body?.variantA || req.body?.variant_a,
        variantB: req.body?.variantB || req.body?.variant_b,
      });
      res.json({ ok: true, experiment: row });
    } catch (e) {
      if (/required|must be/.test(e.message)) return apiError(res, 400, 'INVALID_EXPERIMENT', e.message);
      logger?.error?.('/webhook/ab-test-create', businessId, e.message);
      apiError(res, 500, 'AB_TEST_CREATE_FAILED', 'Experiment creation failed');
    }
  });

  app.post('/webhook/ab-test-evaluate', async (req, res) => {
    const businessId = req.body?.businessId || req.body?.business_id;
    const experimentId = req.body?.experimentId || req.body?.experiment_id;
    if (!isUUID(businessId) || !isUUID(experimentId)) {
      return apiError(res, 400, 'INVALID_IDS', 'businessId + experimentId (UUIDs) required');
    }
    try {
      const verdict = await abTesting.evaluateExperiment({ experimentId, businessId });
      res.status(verdict.ok ? 200 : 404).json(verdict);
    } catch (e) {
      logger?.error?.('/webhook/ab-test-evaluate', businessId, e.message);
      apiError(res, 500, 'AB_TEST_EVALUATE_FAILED', 'Experiment evaluation failed');
    }
  });

  app.get('/webhook/ab-tests-list', async (req, res) => {
    const businessId = req.query?.business_id;
    if (!isUUID(businessId)) return apiError(res, 400, 'INVALID_BUSINESS_ID', 'business_id (UUID) required');
    try {
      const experiments = await abTesting.listExperiments({
        businessId,
        status: typeof req.query?.status === 'string' ? req.query.status : undefined,
      });
      res.json({ ok: true, experiments });
    } catch (e) {
      logger?.error?.('/webhook/ab-tests-list', businessId, e.message);
      apiError(res, 500, 'AB_TESTS_LIST_FAILED', 'Experiment list failed');
    }
  });
}

module.exports = { register };
