/*
 * services/wf15/registerRoutes.js
 * ----------------------------------------------------------------------------
 * Mounts WF15 endpoints matching frontend api.ts lines 489–630.
 * ----------------------------------------------------------------------------
 */

'use strict';

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
    if (!businessId || !conversationId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id + conversation_id required');
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
  app.post('/webhook/wf15-conversation-create', async (req, res) => {
    const { businessId, initialMessage } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const r = await wf15.createConversation({ businessId, initialMessage });
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'WF15_CREATE_FAILED', e.message);
    }
  });

  // ─── POST /webhook/wf15-send-message ───────────────────────
  app.post('/webhook/wf15-send-message', async (req, res) => {
    const { businessId, conversationId, content, attachmentIds } = req.body || {};
    if (!businessId || !conversationId || !content) return apiError(res, 400, 'INVALID_REQUEST', 'businessId + conversationId + content required');
    try {
      const r = await wf15.sendMessage({ businessId, conversationId, content, attachmentIds });
      res.json(r);
    } catch (e) {
      logger?.error('/webhook/wf15-send-message', businessId, 'send failed', e);
      apiError(res, 500, 'WF15_SEND_FAILED', e.message);
    }
  });

  // ─── GET /webhook/wf15-stream/:messageId ───────────────────
  // Non-streaming placeholder — returns the completed assistant message as
  // SSE `done` event so the frontend EventSource picks up the final payload.
  app.get('/webhook/wf15-stream/:messageId', async (req, res) => {
    const { messageId } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    try {
      const rows = await sbGet('brain_messages', `id=eq.${messageId}&select=*`);
      const msg = rows[0];
      if (!msg) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'not found' })}\n\n`);
        return res.end();
      }
      // Emit the content as a single token chunk, then done.
      res.write(`event: token\ndata: ${JSON.stringify({ delta: msg.content })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ messageId: msg.id, modelUsed: msg.model_used, costUsd: Number(msg.cost_usd || 0) })}\n\n`);
      res.end();
    } catch (e) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
      res.end();
    }
  });

  // ─── POST /webhook/wf15-tool-decision ──────────────────────
  app.post('/webhook/wf15-tool-decision', async (req, res) => {
    const { businessId, toolCallId, decision, edits } = req.body || {};
    if (!businessId || !toolCallId || !decision) return apiError(res, 400, 'INVALID_REQUEST', 'required fields missing');
    try {
      const r = await wf15.toolDecision({ businessId, toolCallId, decision, edits });
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'WF15_TOOL_DECISION_FAILED', e.message);
    }
  });

  // ─── POST /webhook/wf15-explain ─────────────────────────────
  app.post('/webhook/wf15-explain', async (req, res) => {
    const { businessId, messageId } = req.body || {};
    if (!businessId || !messageId) return apiError(res, 400, 'INVALID_REQUEST', 'required fields missing');
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
  app.post('/webhook/wf15-upload-attachment', async (req, res) => {
    const { businessId, modality, url, mimeType, name, transcription, ocrText, scrapedSummary } = req.body || {};
    if (!businessId || !modality || !url) return apiError(res, 400, 'INVALID_REQUEST', 'businessId, modality, url required');
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
