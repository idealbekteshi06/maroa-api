/*
 * services/wf_batch_routes.js
 * ----------------------------------------------------------------------------
 * Mounts endpoints for WF5, WF6, WF7, WF8, WF9/11, WF10, WF12, WF14 in a
 * single file. These workflows do not yet have frontend api.ts contracts, so
 * the endpoints use a consistent REST-ish pattern that the frontend can
 * bind to once it's refactored.
 * ----------------------------------------------------------------------------
 */

'use strict';

function registerBatchRoutes({ app, wf5, wf6, wf7, wf8, wf9, wf10, wf12, wf14, apiError, logger }) {
  // ─── WF5 — Competitor Intelligence ────────────────────────────────
  app.post('/webhook/wf5-run-analysis', async (req, res) => {
    const { businessId, force } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try { res.json(await wf5.runAnalysis({ businessId, force: !!force })); }
    catch (e) { apiError(res, 500, 'WF5_FAILED', e.message); }
  });
  async function wf5latest(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json((await wf5.getLatest(businessId)) || null); }
    catch (e) { apiError(res, 500, 'WF5_LATEST_FAILED', e.message); }
  }
  app.get('/webhook/wf5-latest', wf5latest);
  app.post('/webhook/wf5-latest', wf5latest);

  // ─── WF6 — Local + Digital Presence ───────────────────────────────
  app.post('/webhook/wf6-run-audit', async (req, res) => {
    const { businessId, auditInput } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf6.runAudit({ businessId, auditInput })); }
    catch (e) { apiError(res, 500, 'WF6_AUDIT_FAILED', e.message); }
  });
  app.post('/webhook/wf6-generate-schema', async (req, res) => {
    const { businessId, page } = req.body || {};
    if (!businessId || !page) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf6.generateSchema({ businessId, page })); }
    catch (e) { apiError(res, 500, 'WF6_SCHEMA_FAILED', e.message); }
  });
  async function wf6latest(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json((await wf6.getLatestAudit(businessId)) || null); }
    catch (e) { apiError(res, 500, 'WF6_LATEST_FAILED', e.message); }
  }
  app.get('/webhook/wf6-latest-audit', wf6latest);
  app.post('/webhook/wf6-latest-audit', wf6latest);

  // ─── WF7 — Email Lifecycle ────────────────────────────────────────
  app.post('/webhook/wf7-segment-create', async (req, res) => {
    const body = req.body || {};
    if (!body.businessId || !body.name) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf7.createSegment(body)); }
    catch (e) { apiError(res, 500, 'WF7_SEG_FAILED', e.message); }
  });
  app.post('/webhook/wf7-design-sequence', async (req, res) => {
    const { businessId, segmentId } = req.body || {};
    if (!businessId || !segmentId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf7.designSequence({ businessId, segmentId })); }
    catch (e) { apiError(res, 500, 'WF7_DESIGN_FAILED', e.message); }
  });
  app.post('/webhook/wf7-enroll', async (req, res) => {
    const { businessId, sequenceId, contactId } = req.body || {};
    if (!businessId || !sequenceId || !contactId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf7.enrollContact({ businessId, sequenceId, contactId })); }
    catch (e) { apiError(res, 500, 'WF7_ENROLL_FAILED', e.message); }
  });
  app.post('/webhook/wf7-dispatch-due', async (req, res) => {
    const { businessId } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try { res.json(await wf7.dispatchDue({ businessId })); }
    catch (e) { apiError(res, 500, 'WF7_DISPATCH_FAILED', e.message); }
  });

  // ─── WF8 — Customer Insights ──────────────────────────────────────
  app.post('/webhook/wf8-generate-report', async (req, res) => {
    const { businessId } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try { res.json(await wf8.generateInsightReport({ businessId })); }
    catch (e) { apiError(res, 500, 'WF8_FAILED', e.message); }
  });
  async function wf8latest(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json((await wf8.getLatestReport(businessId)) || null); }
    catch (e) { apiError(res, 500, 'WF8_LATEST_FAILED', e.message); }
  }
  app.get('/webhook/wf8-latest-report', wf8latest);
  app.post('/webhook/wf8-latest-report', wf8latest);

  // ─── WF9/11 — Unified Inbox ───────────────────────────────────────
  app.post('/webhook/wf9-intake', async (req, res) => {
    const body = req.body || {};
    if (!body.businessId || !body.channel || !body.body) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf9.intakeThread(body)); }
    catch (e) { apiError(res, 500, 'WF9_INTAKE_FAILED', e.message); }
  });
  app.post('/webhook/wf9-triage', async (req, res) => {
    const { businessId, threadId } = req.body || {};
    if (!businessId || !threadId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf9.triageThread({ businessId, threadId })); }
    catch (e) { apiError(res, 500, 'WF9_TRIAGE_FAILED', e.message); }
  });
  app.post('/webhook/wf9-draft-reply', async (req, res) => {
    const { businessId, threadId, triage } = req.body || {};
    if (!businessId || !threadId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf9.draftReply({ businessId, threadId, triage })); }
    catch (e) { apiError(res, 500, 'WF9_DRAFT_FAILED', e.message); }
  });
  async function wf9list(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf9.listThreads({ businessId, status: req.query?.status, urgency: req.query?.urgency })); }
    catch (e) { apiError(res, 500, 'WF9_LIST_FAILED', e.message); }
  }
  app.get('/webhook/wf9-threads-list', wf9list);
  app.post('/webhook/wf9-threads-list', wf9list);

  // ─── WF10 — Higgsfield Studio ─────────────────────────────────────
  app.post('/webhook/wf10-create-job', async (req, res) => {
    const { businessId, request } = req.body || {};
    if (!businessId || !request) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf10.createStudioJob({ businessId, request })); }
    catch (e) { apiError(res, 500, 'WF10_CREATE_FAILED', e.message); }
  });
  async function wf10get(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    const jobId = req.body?.job_id || req.query?.job_id;
    if (!businessId || !jobId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json((await wf10.getJob({ businessId, jobId })) || null); }
    catch (e) { apiError(res, 500, 'WF10_GET_FAILED', e.message); }
  }
  app.get('/webhook/wf10-job-get', wf10get);
  app.post('/webhook/wf10-job-get', wf10get);
  async function wf10list(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf10.listJobs({ businessId, status: req.query?.status })); }
    catch (e) { apiError(res, 500, 'WF10_LIST_FAILED', e.message); }
  }
  app.get('/webhook/wf10-jobs-list', wf10list);
  app.post('/webhook/wf10-jobs-list', wf10list);

  // ─── WF12 — Launch Orchestrator ───────────────────────────────────
  app.post('/webhook/wf12-plan-launch', async (req, res) => {
    const { businessId, request } = req.body || {};
    if (!businessId || !request) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf12.planLaunch({ businessId, request })); }
    catch (e) { apiError(res, 500, 'WF12_PLAN_FAILED', e.message); }
  });
  app.post('/webhook/wf12-activity-update', async (req, res) => {
    const { businessId, activityId, status } = req.body || {};
    if (!businessId || !activityId || !status) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf12.updateActivityStatus({ businessId, activityId, status })); }
    catch (e) { apiError(res, 500, 'WF12_UPDATE_FAILED', e.message); }
  });
  async function wf12list(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf12.listLaunches(businessId)); }
    catch (e) { apiError(res, 500, 'WF12_LIST_FAILED', e.message); }
  }
  app.get('/webhook/wf12-launches-list', wf12list);
  app.post('/webhook/wf12-launches-list', wf12list);
  async function wf12get(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    const launchId = req.body?.launch_id || req.query?.launch_id;
    if (!businessId || !launchId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf12.getLaunchDetail({ businessId, launchId })); }
    catch (e) { apiError(res, 500, 'WF12_GET_FAILED', e.message); }
  }
  app.get('/webhook/wf12-launch-detail', wf12get);
  app.post('/webhook/wf12-launch-detail', wf12get);

  // ─── WF14 — Budget & ROI Optimizer ────────────────────────────────
  app.post('/webhook/wf14-run', async (req, res) => {
    const { businessId, force } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json(await wf14.runOptimizer({ businessId, force: !!force })); }
    catch (e) { apiError(res, 500, 'WF14_FAILED', e.message); }
  });
  async function wf14latest(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'required');
    try { res.json((await wf14.getLatest(businessId)) || null); }
    catch (e) { apiError(res, 500, 'WF14_LATEST_FAILED', e.message); }
  }
  app.get('/webhook/wf14-latest', wf14latest);
  app.post('/webhook/wf14-latest', wf14latest);
}

module.exports = { registerBatchRoutes };
