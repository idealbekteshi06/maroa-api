'use strict';

const internalDispatcher = require('../../lib/internalDispatcher');

function registerWf11Routes({ app, wf11, apiError, logger }) {
  internalDispatcher.register('/webhook/wf11-sla-check-all', (body) => wf11.checkSlaBreaches(body || {}));
  app.post('/webhook/wf11-apply-routing', async (req, res) => {
    const { businessId, threadId, triage } = req.body || {};
    if (!businessId || !threadId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId + threadId required');
    try {
      res.json(await wf11.applyRouting({ businessId, threadId, triage }));
    } catch (e) {
      logger?.error('/webhook/wf11-apply-routing', businessId, 'failed', e);
      apiError(res, 500, 'WF11_ROUTE_FAILED', e.message);
    }
  });

  async function settingsGet(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id || req.query?.businessId;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try {
      res.json(await wf11.getSettings(businessId));
    } catch (e) {
      apiError(res, 500, 'WF11_SETTINGS_GET_FAILED', e.message);
    }
  }
  app.get('/webhook/wf11-settings-get', settingsGet);
  app.post('/webhook/wf11-settings-get', settingsGet);

  app.post('/webhook/wf11-settings-save', async (req, res) => {
    const { businessId, ...rest } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      res.json(await wf11.saveSettings({ businessId, ...rest }));
    } catch (e) {
      apiError(res, 500, 'WF11_SETTINGS_SAVE_FAILED', e.message);
    }
  });

  app.post('/webhook/wf11-sla-check-all', async (req, res) => {
    const { businessId } = req.body || {};
    try {
      res.json(await wf11.checkSlaBreaches({ businessId }));
    } catch (e) {
      apiError(res, 500, 'WF11_SLA_FAILED', e.message);
    }
  });

  async function escalationsList(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try {
      res.json(await wf11.listEscalations({ businessId }));
    } catch (e) {
      apiError(res, 500, 'WF11_ESC_LIST_FAILED', e.message);
    }
  }
  app.get('/webhook/wf11-escalations-list', escalationsList);
  app.post('/webhook/wf11-escalations-list', escalationsList);

  app.post('/webhook/wf11-escalation-resolve', async (req, res) => {
    const { businessId, escalationId } = req.body || {};
    if (!businessId || !escalationId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try {
      res.json(await wf11.resolveEscalation({ businessId, escalationId }));
    } catch (e) {
      apiError(res, 500, 'WF11_ESC_RESOLVE_FAILED', e.message);
    }
  });

  async function metricsHandler(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try {
      res.json(await wf11.getMetrics(businessId));
    } catch (e) {
      apiError(res, 500, 'WF11_METRICS_FAILED', e.message);
    }
  }
  app.get('/webhook/wf11-metrics', metricsHandler);
  app.post('/webhook/wf11-metrics', metricsHandler);
}

module.exports = { registerWf11Routes };
