/*
 * services/wf2/registerRoutes.js
 * Mounts WF2 endpoints matching frontend api.ts lines 633–778.
 */

'use strict';

function registerWf2Routes({ app, wf2, apiError, logger }) {
  async function listHandler(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try {
      const r = await wf2.listLeads({
        businessId,
        tier: req.body?.tier || req.query?.tier,
        status: req.body?.status || req.query?.status,
        ownerId: req.body?.owner_id || req.query?.owner_id,
        limit: Number(req.body?.limit || req.query?.limit || 50),
        cursor: req.body?.cursor || req.query?.cursor,
        q: req.body?.q || req.query?.q,
      });
      res.json(r);
    } catch (e) { apiError(res, 500, 'WF2_LIST_FAILED', e.message); }
  }
  app.get('/webhook/wf2-leads-list', listHandler);
  app.post('/webhook/wf2-leads-list', listHandler);

  async function getHandler(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    const leadId = req.body?.lead_id || req.query?.lead_id;
    if (!businessId || !leadId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id + lead_id required');
    try {
      const r = await wf2.getLead({ businessId, leadId });
      res.json(r);
    } catch (e) { apiError(res, 500, 'WF2_GET_FAILED', e.message); }
  }
  app.get('/webhook/wf2-lead-get', getHandler);
  app.post('/webhook/wf2-lead-get', getHandler);

  app.post('/webhook/wf2-lead-rescore', async (req, res) => {
    const { businessId, leadId } = req.body || {};
    if (!businessId || !leadId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try {
      const r = await wf2.rescoreLead({ businessId, leadId });
      res.json(r);
    } catch (e) { apiError(res, 500, 'WF2_RESCORE_FAILED', e.message); }
  });

  app.post('/webhook/wf2-generate-response', async (req, res) => {
    const { businessId, leadId } = req.body || {};
    if (!businessId || !leadId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try {
      const r = await wf2.generateResponse({ businessId, leadId });
      res.json(r);
    } catch (e) { apiError(res, 500, 'WF2_GEN_FAILED', e.message); }
  });

  app.post('/webhook/wf2-send-response', async (req, res) => {
    const { businessId, leadId, subject, body, force } = req.body || {};
    if (!businessId || !leadId || !subject || !body) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try {
      const r = await wf2.sendResponse({ businessId, leadId, subject, body, force });
      res.json(r);
    } catch (e) { apiError(res, 500, 'WF2_SEND_FAILED', e.message); }
  });

  app.post('/webhook/wf2-lead-update', async (req, res) => {
    const { businessId, leadId, tier, status, ownerId, tagAsJunk, unjunk } = req.body || {};
    if (!businessId || !leadId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try {
      const r = await wf2.updateLead({ businessId, leadId, tier, status, ownerId, tagAsJunk, unjunk });
      res.json(r);
    } catch (e) { apiError(res, 500, 'WF2_UPDATE_FAILED', e.message); }
  });

  async function routingGetHandler(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try {
      res.json(await wf2.getRoutingRules(businessId));
    } catch (e) { apiError(res, 500, 'WF2_ROUTING_GET_FAILED', e.message); }
  }
  app.get('/webhook/wf2-routing-rules-get', routingGetHandler);
  app.post('/webhook/wf2-routing-rules-get', routingGetHandler);

  app.post('/webhook/wf2-routing-rules-save', async (req, res) => {
    const { businessId, rules } = req.body || {};
    if (!businessId || !Array.isArray(rules)) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try {
      res.json(await wf2.saveRoutingRules({ businessId, rules }));
    } catch (e) { apiError(res, 500, 'WF2_ROUTING_SAVE_FAILED', e.message); }
  });

  async function calibrationHandler(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try {
      res.json(await wf2.getCalibration(businessId));
    } catch (e) { apiError(res, 500, 'WF2_CAL_FAILED', e.message); }
  }
  app.get('/webhook/wf2-calibration', calibrationHandler);
  app.post('/webhook/wf2-calibration', calibrationHandler);

  async function icpGetHandler(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try {
      res.json(await wf2.getIcp(businessId));
    } catch (e) { apiError(res, 500, 'WF2_ICP_GET_FAILED', e.message); }
  }
  app.get('/webhook/wf2-icp-get', icpGetHandler);
  app.post('/webhook/wf2-icp-get', icpGetHandler);

  app.post('/webhook/wf2-icp-save', async (req, res) => {
    const { businessId, ...rest } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      res.json(await wf2.saveIcp({ businessId, ...rest }));
    } catch (e) { apiError(res, 500, 'WF2_ICP_SAVE_FAILED', e.message); }
  });
}

module.exports = { registerWf2Routes };
