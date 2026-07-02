'use strict';

/**
 * services/publish-scheduler/registerRoutes.js
 * ---------------------------------------------------------------------------
 * Mounts the publish scheduler (feature #3 rebuild):
 *
 *   POST /webhook/publish-scheduler-run   cron target — publish all due content
 *
 * Driven by the Inngest cron `publish-scheduler-15m`. Registered on the
 * internal dispatcher so the cron runs it in-process. The generated_content
 * (scheduled_for) path reuses the existing /webhook/publish-approved-content
 * route over the internal loopback (same pattern as services/inngest callInternal).
 * ---------------------------------------------------------------------------
 */

const scheduler = require('./index');

function registerPublishSchedulerRoutes({ app, apiError, sbGet, sbPost, sbPatch, apiRequest, logger }) {
  const internalDispatcher = require('../../lib/internalDispatcher');
  const INTERNAL_BASE =
    process.env.INTERNAL_API_BASE ||
    process.env.MAROA_API_INTERNAL_URL ||
    `http://127.0.0.1:${process.env.PORT || 3000}`;
  const SECRET = process.env.N8N_WEBHOOK_SECRET || '';

  // Reuse the live publisher for legacy generated_content rows.
  async function publishApprovedForBusiness(businessId) {
    return apiRequest(
      'POST',
      `${INTERNAL_BASE}/webhook/publish-approved-content`,
      { 'Content-Type': 'application/json', ...(SECRET ? { 'x-webhook-secret': SECRET } : {}) },
      { business_id: businessId }
    );
  }

  const deps = { sbGet, sbPost, sbPatch, apiRequest, logger, publishApprovedForBusiness };

  function run() {
    return scheduler.runDuePublish({ deps });
  }
  internalDispatcher.register('/webhook/publish-scheduler-run', () => run());

  app.post('/webhook/publish-scheduler-run', async (req, res) => {
    try {
      res.json(await run());
    } catch (e) {
      apiError(res, 500, 'PUBLISH_SCHEDULER_FAILED', e.message);
    }
  });
}

module.exports = { registerPublishSchedulerRoutes };
