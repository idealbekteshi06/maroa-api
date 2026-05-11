'use strict';

/**
 * routes/meta-compliance.js — Meta-required compliance callbacks.
 *
 * These three routes are mandatory for any Meta App in production
 * (per Meta Platform Terms):
 *
 *   POST /webhook/meta-deauthorize   — fires when a user revokes the App
 *   POST /webhook/meta-data-deletion — GDPR data-deletion request from Meta
 *   GET  /api/data-deletion-status   — public status page (uses confirm code)
 *
 * Both POST routes verify Meta's signed_request (HMAC-SHA256 over the
 * base64url payload). On valid signature we:
 *   - Generate a confirmation code
 *   - Log to events table + sbPost data_deletion_requests
 *   - Email admin (deauthorize is info-only; deletion has a 30-day SLA)
 *   - Return the confirmation URL Meta requires
 *
 * Carved from server.js for two reasons:
 *   1. They're isolated — no closure coupling to wider server.js state
 *   2. Compliance code benefits from being in its own reviewable file
 */

const crypto = require('crypto');

function parseSignedRequest(signedRequest, secret) {
  if (typeof signedRequest !== 'string' || !signedRequest.includes('.')) return null;
  const [encodedSig, payload] = signedRequest.split('.');
  if (!encodedSig || !payload) return null;
  try {
    const sig = Buffer.from(encodedSig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const expected = crypto.createHmac('sha256', secret).update(payload).digest();
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
    const data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (data.algorithm !== 'HMAC-SHA256') return null;
    return data;
  } catch {
    return null;
  }
}

function register({ app, express, sbGet, sbPost, sendEmail, apiError, logger }) {
  const urlencoded = express.urlencoded({ extended: false });
  const cleanEnv = (v) => (v || '').replace(/[^\x20-\x7E]/g, '').trim();

  app.post('/webhook/meta-deauthorize', urlencoded, async (req, res) => {
    const metaSecret = cleanEnv(process.env.META_APP_SECRET);
    if (!metaSecret) {
      logger.error('/webhook/meta-deauthorize', null, 'META_APP_SECRET not configured');
      return apiError(res, 503, 'SERVICE_UNAVAILABLE', 'Meta App Secret not configured');
    }
    const signedRequest = req.body?.signed_request;
    if (!signedRequest) return apiError(res, 400, 'INVALID_REQUEST', 'signed_request is required');

    const data = parseSignedRequest(signedRequest, metaSecret);
    if (!data) return apiError(res, 400, 'INVALID_SIGNATURE', 'Invalid signed_request');

    const metaUserId = data.user_id;
    const confirmCode = crypto.randomUUID();

    try {
      const bizRows = await sbGet(
        'businesses',
        'meta_access_token=not.is.null&select=id,facebook_page_id,instagram_account_id'
      );
      logger.info('/webhook/meta-deauthorize', null, 'Meta deauthorize callback received', {
        meta_user_id: metaUserId,
        confirmation_code: confirmCode,
        businesses_with_meta: bizRows.length,
      });
    } catch (e) {
      logger.warn('/webhook/meta-deauthorize', null, 'DB lookup failed', { error: e.message });
    }

    await sbPost('events', {
      business_id: null,
      kind: 'meta.deauthorize',
      workflow: 'meta_compliance',
      payload: { meta_user_id: metaUserId, confirmation_code: confirmCode },
      severity: 'warn',
    }).catch(() => {
      /* soft-fail — Meta retries */
    });

    return res.json({
      url: `https://maroa.ai/data-deletion-status?code=${confirmCode}`,
      confirmation_code: confirmCode,
    });
  });

  app.post('/webhook/meta-data-deletion', urlencoded, async (req, res) => {
    const metaSecret = cleanEnv(process.env.META_APP_SECRET);
    if (!metaSecret) {
      logger.error('/webhook/meta-data-deletion', null, 'META_APP_SECRET not configured');
      return apiError(res, 503, 'SERVICE_UNAVAILABLE', 'Meta App Secret not configured');
    }
    const signedRequest = req.body?.signed_request;
    if (!signedRequest) return apiError(res, 400, 'INVALID_REQUEST', 'signed_request is required');

    const data = parseSignedRequest(signedRequest, metaSecret);
    if (!data) return apiError(res, 400, 'INVALID_SIGNATURE', 'Invalid signed_request');

    const metaUserId = data.user_id;
    const confirmCode = crypto.randomUUID();

    try {
      await sbPost('data_deletion_requests', {
        name: `Meta User ${metaUserId}`,
        email: `meta-user-${metaUserId}@meta.deletion`,
        meta_account: metaUserId,
        reason: 'Meta platform data deletion callback',
        requested_at: new Date().toISOString(),
        status: 'pending',
        ip_address: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown',
        user_agent: (req.headers['user-agent'] || '').toString().slice(0, 500),
      });
    } catch (e) {
      logger.warn('/webhook/meta-data-deletion', null, 'DB insert failed', { error: e.message });
    }

    await sbPost('events', {
      business_id: null,
      kind: 'meta.data_deletion_request',
      workflow: 'meta_compliance',
      payload: { meta_user_id: metaUserId, confirmation_code: confirmCode },
      severity: 'warn',
    }).catch(() => {
      /* soft-fail */
    });

    if (typeof sendEmail === 'function') {
      await sendEmail(
        'info@maroa.ai',
        `[Meta] Data Deletion Request — User ${metaUserId}`,
        `
    <h2>Meta Data Deletion Callback</h2>
    <p><strong>Meta User ID:</strong> ${metaUserId}</p>
    <p><strong>Confirmation Code:</strong> <code>${confirmCode}</code></p>
    <p><strong>Status URL:</strong> <a href="https://maroa.ai/data-deletion-status?code=${confirmCode}">Check status</a></p>
    <p><em>Process within 30 days. Required by Meta Platform Terms.</em></p>
        `
      ).catch((e) => logger.warn('/webhook/meta-data-deletion', null, 'admin email failed', { error: e.message }));
    }

    logger.info('/webhook/meta-data-deletion', null, 'Meta data deletion callback received', {
      meta_user_id: metaUserId,
      confirmation_code: confirmCode,
    });

    return res.json({
      url: `https://maroa.ai/data-deletion-status?code=${confirmCode}`,
      confirmation_code: confirmCode,
    });
  });

  app.get('/api/data-deletion-status', async (req, res) => {
    const code = req.query?.code;
    if (!code || typeof code !== 'string' || code.length < 10) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'confirmation code required');
    }

    try {
      const events = await sbGet(
        'events',
        `kind=in.(meta.deauthorize,meta.data_deletion_request)&payload->>confirmation_code=eq.${encodeURIComponent(code)}&select=kind,created_at,payload&limit=1`
      );
      if (events[0]) {
        return res.json({
          status: 'pending',
          message: 'Your data deletion request is being processed. We will complete it within 30 days.',
          requested_at: events[0].created_at,
          completed_at: null,
        });
      }
    } catch (e) {
      logger.warn('/api/data-deletion-status', null, 'lookup failed (soft)', { error: e?.message });
    }

    return res.json({ status: 'not_found', message: 'No deletion request found for this code.' });
  });
}

module.exports = { register, parseSignedRequest };
