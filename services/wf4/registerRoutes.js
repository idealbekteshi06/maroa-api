/*
 * services/wf4/registerRoutes.js
 * WF4 endpoints matching api.ts:851-953.
 */

'use strict';

function registerWf4Routes({ app, wf4, apiError, logger }) {
  async function listHandler(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try {
      const r = await wf4.listReviews({
        businessId,
        category: req.body?.category || req.query?.category,
        platform: req.body?.platform || req.query?.platform,
        responseStatus: req.body?.response_status || req.query?.response_status,
        limit: Number(req.body?.limit || req.query?.limit || 50),
        cursor: req.body?.cursor || req.query?.cursor,
        q: req.body?.q || req.query?.q,
      });
      res.json(r);
    } catch (e) { apiError(res, 500, 'WF4_LIST_FAILED', e.message); }
  }
  app.get('/webhook/wf4-reviews-list', listHandler);
  app.post('/webhook/wf4-reviews-list', listHandler);

  async function getHandler(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    const reviewId = req.body?.review_id || req.query?.review_id;
    if (!businessId || !reviewId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf4.getReview({ businessId, reviewId })); }
    catch (e) { apiError(res, 500, 'WF4_GET_FAILED', e.message); }
  }
  app.get('/webhook/wf4-review-get', getHandler);
  app.post('/webhook/wf4-review-get', getHandler);

  app.post('/webhook/wf4-generate-response', async (req, res) => {
    const { businessId, reviewId, regenerate } = req.body || {};
    if (!businessId || !reviewId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf4.generateResponse({ businessId, reviewId, regenerate })); }
    catch (e) { apiError(res, 500, 'WF4_GEN_FAILED', e.message); }
  });

  app.post('/webhook/wf4-publish-response', async (req, res) => {
    const { businessId, reviewId, draftId, editedBody } = req.body || {};
    if (!businessId || !reviewId || !draftId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf4.publishResponse({ businessId, reviewId, draftId, editedBody })); }
    catch (e) { apiError(res, 500, 'WF4_PUBLISH_FAILED', e.message); }
  });

  app.post('/webhook/wf4-dispute-review', async (req, res) => {
    const { businessId, reviewId } = req.body || {};
    if (!businessId || !reviewId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf4.disputeReview({ businessId, reviewId })); }
    catch (e) { apiError(res, 500, 'WF4_DISPUTE_FAILED', e.message); }
  });

  app.post('/webhook/wf4-ignore-review', async (req, res) => {
    const { businessId, reviewId, reason } = req.body || {};
    if (!businessId || !reviewId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf4.ignoreReview({ businessId, reviewId, reason })); }
    catch (e) { apiError(res, 500, 'WF4_IGNORE_FAILED', e.message); }
  });

  app.post('/webhook/wf4-request-review', async (req, res) => {
    const body = req.body || {};
    if (!body.businessId || !body.customerName) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf4.requestReview(body)); }
    catch (e) { apiError(res, 500, 'WF4_REQ_REVIEW_FAILED', e.message); }
  });

  async function repSnapshotHandler(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try { res.json(await wf4.getReputationSnapshot({ businessId })); }
    catch (e) { apiError(res, 500, 'WF4_SNAPSHOT_FAILED', e.message); }
  }
  app.get('/webhook/wf4-reputation-snapshot', repSnapshotHandler);
  app.post('/webhook/wf4-reputation-snapshot', repSnapshotHandler);

  async function testimonialsHandler(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try { res.json(await wf4.getTestimonialLibrary(businessId)); }
    catch (e) { apiError(res, 500, 'WF4_TESTIMONIALS_FAILED', e.message); }
  }
  app.get('/webhook/wf4-testimonials-get', testimonialsHandler);
  app.post('/webhook/wf4-testimonials-get', testimonialsHandler);

  app.post('/webhook/wf4-testimonial-request-permission', async (req, res) => {
    const { businessId, reviewId } = req.body || {};
    if (!businessId || !reviewId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf4.requestTestimonialPermission({ businessId, reviewId })); }
    catch (e) { apiError(res, 500, 'WF4_PERMISSION_FAILED', e.message); }
  });
}

module.exports = { registerWf4Routes };
