/*
 * services/wf15/registerRoutes.js
 * ----------------------------------------------------------------------------
 * Mounts WF15 endpoints matching frontend api.ts lines 489–630.
 * ----------------------------------------------------------------------------
 */

'use strict';

const { limits } = require('../../lib/rateLimiters');

// Tenant-isolation: every entity id interpolated into a PostgREST filter must
// be UUID-validated + encoded, and every row touched by entity id must be
// scoped to the caller's already-verified business_id (the /webhook owner gate
// only verifies business_id IF one is present — it is a no-op on routes that
// don't carry one, e.g. the :messageId stream route below).
// See lib/assertBusinessOwner.js + CLAUDE.md Rule 4.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const enc = encodeURIComponent;

function registerWf15Routes({ app, wf15, sbGet, sbPost, sbPatch, apiError, logger }) {
  // ─── GET/POST /webhook/wf15-conversations ──────────────────
  async function listHandler(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try {
      const items = await wf15.listConversations(businessId);
      res.json({ items });
    } catch (e) {
      apiError(res, 500, 'WF15_LIST_FAILED', e.message);
    }
  }
  app.get('/webhook/wf15-conversations', listHandler);
  app.post('/webhook/wf15-conversations', listHandler);

  // ─── GET/POST /webhook/wf15-conversation-get ───────────────
  async function getConvHandler(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    const conversationId = req.body?.conversation_id || req.query?.conversation_id;
    if (!businessId || !conversationId)
      return apiError(res, 400, 'INVALID_REQUEST', 'business_id + conversation_id required');
    if (!isUuid(conversationId)) return apiError(res, 400, 'INVALID_REQUEST', 'conversation_id must be a valid UUID');
    try {
      const r = await wf15.getConversation({ businessId, conversationId });
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'WF15_CONV_FAILED', e.message);
    }
  }
  app.get('/webhook/wf15-conversation-get', getConvHandler);
  app.post('/webhook/wf15-conversation-get', getConvHandler);

  // ─── POST /webhook/wf15-conversation-create ────────────────
  app.post('/webhook/wf15-conversation-create', limits.standardMutate, async (req, res) => {
    const { businessId, initialMessage } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const r = await wf15.createConversation({ businessId, initialMessage });
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'WF15_CREATE_FAILED', e.message);
    }
  });

  // ─── POST /webhook/wf15-send-message (SSE streaming) ───────
  app.post('/webhook/wf15-send-message', limits.expensive, async (req, res) => {
    const { businessId, conversationId, content, attachmentIds } = req.body || {};
    if (!businessId || !conversationId || !content)
      return apiError(res, 400, 'INVALID_REQUEST', 'businessId + conversationId + content required');
    if (!isUuid(conversationId)) return apiError(res, 400, 'INVALID_REQUEST', 'conversationId must be a valid UUID');

    // Set SSE headers — response is a stream, not JSON
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    try {
      await wf15.sendMessage({ businessId, conversationId, content, attachmentIds, res });
      // sendMessage handles res.write + res.end internally
    } catch (e) {
      logger?.error('/webhook/wf15-send-message', businessId, 'send failed', e);
      if (!res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: e.message || 'Send failed' })}\n\n`);
        res.end();
      }
    }
  });

  // ─── GET /webhook/wf15-stream/:messageId ───────────────────
  // Non-streaming placeholder — returns the completed assistant message as
  // SSE `done` event so the frontend EventSource picks up the final payload.
  app.get('/webhook/wf15-stream/:messageId', async (req, res) => {
    const { messageId } = req.params;
    // Tenant-isolation: this route carries no business_id in its path, so the
    // global owner gate is a no-op here — without scoping, any caller could
    // read any business's brain_messages by id. Require + verify business_id
    // and scope the read to it. (Owner gate also reads ?business_id, so when
    // present it is already ownership-checked.)
    const businessId = req.query?.business_id || req.body?.business_id;
    if (!businessId || !isUuid(businessId)) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'business_id required' })}\n\n`);
      return res.end();
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    try {
      if (!isUuid(messageId)) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'not found' })}\n\n`);
        return res.end();
      }
      const rows = await sbGet('brain_messages', `id=eq.${enc(messageId)}&business_id=eq.${enc(businessId)}&select=*`);
      const msg = rows[0];
      if (!msg) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'not found' })}\n\n`);
        return res.end();
      }
      // Emit the content as a single token chunk, then done.
      res.write(`event: token\ndata: ${JSON.stringify({ delta: msg.content })}\n\n`);
      res.write(
        `event: done\ndata: ${JSON.stringify({ messageId: msg.id, modelUsed: msg.model_used, costUsd: Number(msg.cost_usd || 0) })}\n\n`
      );
      res.end();
    } catch (e) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
      res.end();
    }
  });

  // ─── POST /webhook/wf15-tool-decision ──────────────────────
  app.post('/webhook/wf15-tool-decision', limits.expensive, async (req, res) => {
    const { businessId, toolCallId, decision, edits } = req.body || {};
    if (!businessId || !toolCallId || !decision)
      return apiError(res, 400, 'INVALID_REQUEST', 'required fields missing');
    if (!isUuid(toolCallId)) return apiError(res, 400, 'INVALID_REQUEST', 'toolCallId must be a valid UUID');
    try {
      const r = await wf15.toolDecision({ businessId, toolCallId, decision, edits });
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'WF15_TOOL_DECISION_FAILED', e.message);
    }
  });

  // ─── POST /webhook/wf15-explain ─────────────────────────────
  app.post('/webhook/wf15-explain', limits.expensive, async (req, res) => {
    const { businessId, messageId } = req.body || {};
    if (!businessId || !messageId) return apiError(res, 400, 'INVALID_REQUEST', 'required fields missing');
    if (!isUuid(messageId)) return apiError(res, 400, 'INVALID_REQUEST', 'messageId must be a valid UUID');
    try {
      const r = await wf15.explainDecision({ businessId, messageId });
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'WF15_EXPLAIN_FAILED', e.message);
    }
  });

  // ─── GET/POST /webhook/wf15-decision-log ───────────────────
  async function decisionLogHandler(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    const limit = Number(req.body?.limit || req.query?.limit || 50);
    const kind = req.body?.kind || req.query?.kind;
    const before = req.body?.before || req.query?.before;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try {
      const r = await wf15.getDecisionLog({ businessId, limit, kind, before });
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'WF15_DECISION_LOG_FAILED', e.message);
    }
  }
  app.get('/webhook/wf15-decision-log', decisionLogHandler);
  app.post('/webhook/wf15-decision-log', decisionLogHandler);

  // ─── POST /webhook/wf15-upload-attachment ──────────────────
  // Note: full multipart-form handling would require multer; this stub
  // accepts JSON metadata for now and returns an attachment id.
  app.post('/webhook/wf15-upload-attachment', limits.standardMutate, async (req, res) => {
    const { businessId, modality, url, mimeType, name, transcription, ocrText, scrapedSummary } = req.body || {};
    if (!businessId || !modality || !url)
      return apiError(res, 400, 'INVALID_REQUEST', 'businessId, modality, url required');
    try {
      const row = await sbPost('brain_attachments', {
        business_id: businessId,
        modality,
        url,
        mime_type: mimeType,
        name,
        transcription,
        ocr_text: ocrText,
        scraped_summary: scrapedSummary,
      });
      res.json({ id: row.id, modality, url });
    } catch (e) {
      apiError(res, 500, 'WF15_UPLOAD_FAILED', e.message);
    }
  });
}

module.exports = { registerWf15Routes };
