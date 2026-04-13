'use strict';

function registerWf3Routes({ app, wf3, apiError, logger }) {
  app.post('/webhook/wf3-run-optimization', async (req, res) => {
    const { businessId, weekStart, force } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try { res.json(await wf3.runOptimization({ businessId, weekStart, force: !!force })); }
    catch (e) { logger?.error('/webhook/wf3-run-optimization', businessId, 'failed', e); apiError(res, 500, 'WF3_RUN_FAILED', e.message); }
  });

  app.post('/webhook/wf3-apply-action', async (req, res) => {
    const { businessId, actionId } = req.body || {};
    if (!businessId || !actionId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf3.applyAction({ businessId, actionId })); }
    catch (e) { apiError(res, 500, 'WF3_APPLY_FAILED', e.message); }
  });

  async function latestHandler(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try { res.json((await wf3.getLatestRun(businessId)) || { run: null, actions: [] }); }
    catch (e) { apiError(res, 500, 'WF3_LATEST_FAILED', e.message); }
  }
  app.get('/webhook/wf3-latest-run', latestHandler);
  app.post('/webhook/wf3-latest-run', latestHandler);
}

module.exports = { registerWf3Routes };
