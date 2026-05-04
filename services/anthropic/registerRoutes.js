/*
 * services/anthropic/registerRoutes.js
 * ----------------------------------------------------------------------------
 * Mounts endpoints for the Anthropic API 2026 features:
 *
 *   Files API
 *     POST   /webhook/anthropic-file-upload      (multipart, persists row)
 *     GET    /webhook/anthropic-files-list
 *     POST   /webhook/anthropic-file-delete
 *     POST   /webhook/anthropic-file-set-default
 *
 *   Batch API
 *     POST   /webhook/anthropic-batch-submit
 *     GET    /webhook/anthropic-batch-status
 *     POST   /webhook/anthropic-batch-reconcile  (cron target)
 *     POST   /webhook/anthropic-batch-cancel
 *
 *   Citations
 *     POST   /webhook/insights-with-citations    (uses business files)
 *
 *   Memory (public beta)
 *     POST   /webhook/memory-ensure-session
 *     POST   /webhook/memory-append-fact
 *     GET    /webhook/memory-get-session
 *     POST   /webhook/memory-delete-session
 *
 *   Managed Agents (public beta) — pilot for WF-15
 *     POST   /webhook/managed-agent-run          (parallel to existing brain)
 *     GET    /webhook/managed-agent-poll
 *     POST   /webhook/managed-agent-cancel
 *
 * All routes:
 *   - x-webhook-secret auth (inherited from app.use)
 *   - Per-route express-rate-limit (IPv6-safe via ipKeyGenerator)
 *   - Sentry breadcrumbs + exception capture
 *   - Idempotency on expensive paths
 *   - Plan gate on cost-incurring paths
 * ----------------------------------------------------------------------------
 */

'use strict';

const expressRateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const Sentry = (() => { try { return require('@sentry/node'); } catch { return null; } })();

const PLAN_FILES_LIMIT = { starter: 5, growth: 50, agency: 500 };       // total brand files
const PLAN_BATCH_LIMIT = { starter: 1, growth: 10, agency: 100 };       // monthly batches
const PLAN_INSIGHTS_LIMIT = { starter: 5, growth: 50, agency: 500 };    // monthly cited-insight calls

function makeLimiter(windowMs, max, keyName) {
  return expressRateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const bizKey = req.body?.businessId || req.body?.business_id || req.query?.businessId || req.query?.business_id;
      return `${keyName}:${bizKey || ipKeyGenerator(req.ip)}`;
    },
    message: { error: 'rate_limited', message: `Too many ${keyName} requests` },
  });
}

const limiters = {
  fileUpload: makeLimiter(60 * 1000, 20, 'file_upload'),
  filesList: makeLimiter(60 * 1000, 60, 'files_list'),
  fileMutate: makeLimiter(60 * 1000, 30, 'file_mutate'),
  batchSubmit: makeLimiter(60 * 1000, 5, 'batch_submit'),
  batchPoll: makeLimiter(60 * 1000, 60, 'batch_poll'),
  insights: makeLimiter(60 * 1000, 30, 'insights'),
  memoryWrite: makeLimiter(60 * 1000, 30, 'memory_write'),
  memoryRead: makeLimiter(60 * 1000, 60, 'memory_read'),
  agentRun: makeLimiter(60 * 1000, 10, 'agent_run'),
  agentPoll: makeLimiter(60 * 1000, 60, 'agent_poll'),
};

function trace(name, fn) {
  return async function tracedHandler(req, res) {
    const businessId = req.body?.businessId || req.body?.business_id || req.query?.businessId || req.query?.business_id;
    if (Sentry) {
      Sentry.addBreadcrumb({ category: 'anthropic.route', message: name, data: { business_id: businessId, ip: req.ip }, level: 'info' });
    }
    const transaction = Sentry?.startTransaction ? Sentry.startTransaction({ op: 'http.server', name: `POST ${name}` }) : null;
    try {
      await fn(req, res);
    } catch (e) {
      Sentry?.captureException?.(e, { tags: { route: name, business_id: businessId } });
      throw e;
    } finally {
      transaction?.finish();
    }
  };
}

async function getBusinessUserId(sbGet, businessId) {
  const rows = await sbGet('businesses', `id=eq.${businessId}&select=user_id,plan`).catch(() => []);
  return rows[0] || null;
}

async function checkMonthlyLimit(sbGet, userId, action, plan, planTable) {
  const limit = planTable[(plan || 'starter').toLowerCase()] ?? planTable.starter;
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const rows = await sbGet('usage_logs', `user_id=eq.${userId}&action=eq.${action}&created_at=gte.${monthStart}&select=id`).catch(() => []);
  const count = Array.isArray(rows) ? rows.length : 0;
  return { allowed: count < limit, count, limit };
}

function logUsage(sbPost, userId, action, businessId) {
  setImmediate(() => {
    sbPost('usage_logs', { user_id: userId, action, business_id: businessId, created_at: new Date().toISOString() }).catch(() => {});
  });
}

function registerAnthropicRoutes(deps) {
  const {
    app, sbGet, sbPost, sbPatch, sbDelete,
    apiError, logger, checkOrchestrationIdempotency,
    filesService, batchService, memoryService, managedAgentService, citations,
    callClaude,
  } = deps;

  // ─── Files: POST /webhook/anthropic-file-upload ─────────────────────
  // Body: { businessId, filename, mimeType, base64Content, kind?, description?, makeDefault? }
  // (We don't accept multipart from this route — frontend sends base64. Backend
  //  decodes and forwards multipart to Anthropic. Keeps Express simple.)
  app.post('/webhook/anthropic-file-upload', limiters.fileUpload, trace('/webhook/anthropic-file-upload', async (req, res) => {
    const { businessId, filename, mimeType, base64Content, kind, description, makeDefault } = req.body || {};
    if (!businessId || !filename || !base64Content) return apiError(res, 400, 'INVALID_REQUEST', 'businessId + filename + base64Content required');

    try {
      const ctx = await getBusinessUserId(sbGet, businessId);
      if (!ctx) return apiError(res, 404, 'BUSINESS_NOT_FOUND', `Business not found: ${businessId}`);
      const userId = ctx.user_id || businessId;

      // Plan gate: total files
      const totalRows = await sbGet('anthropic_files', `business_id=eq.${businessId}&select=id`).catch(() => []);
      const totalFiles = Array.isArray(totalRows) ? totalRows.length : 0;
      const limit = PLAN_FILES_LIMIT[(ctx.plan || 'starter').toLowerCase()] ?? PLAN_FILES_LIMIT.starter;
      if (totalFiles >= limit) {
        return apiError(res, 429, 'PLAN_LIMIT_REACHED', `Plan ${ctx.plan || 'starter'} allows ${limit} files. Current: ${totalFiles}.`);
      }

      const buffer = Buffer.from(base64Content, 'base64');
      const uploaded = await filesService.uploadBuffer({ buffer, filename, mimeType });
      const persisted = await sbPost('anthropic_files', {
        business_id: businessId,
        anthropic_file_id: uploaded.id,
        filename: uploaded.filename || filename,
        mime_type: uploaded.mime_type || mimeType,
        size_bytes: uploaded.size_bytes || buffer.length,
        kind: kind || 'brand_guidelines',
        description: description || null,
        is_default: !!makeDefault,
        uploaded_by_user_id: userId,
      }).catch((e) => {
        logger?.warn('/webhook/anthropic-file-upload', businessId, 'persist failed', { error: e.message });
        return null;
      });
      if (makeDefault && persisted) {
        const newId = persisted?.[0]?.id || persisted?.id;
        if (newId) await sbPatch('anthropic_files', `business_id=eq.${businessId}&id=neq.${newId}&kind=eq.${kind || 'brand_guidelines'}`, { is_default: false }).catch(() => {});
      }
      logUsage(sbPost, userId, 'anthropic_file_upload', businessId);
      res.json({ ok: true, file: uploaded, persisted });
    } catch (e) {
      logger?.error('/webhook/anthropic-file-upload', businessId, 'failed', e);
      apiError(res, 500, 'FILE_UPLOAD_FAILED', e.message);
    }
  }));

  app.get('/webhook/anthropic-files-list', limiters.filesList, trace('/webhook/anthropic-files-list', async (req, res) => {
    const businessId = req.query?.business_id || req.query?.businessId;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try {
      const rows = await sbGet('anthropic_files', `business_id=eq.${businessId}&order=created_at.desc&select=*`);
      res.json({ files: rows });
    } catch (e) {
      apiError(res, 500, 'FILES_LIST_FAILED', e.message);
    }
  }));

  app.post('/webhook/anthropic-file-delete', limiters.fileMutate, trace('/webhook/anthropic-file-delete', async (req, res) => {
    const { businessId, fileId } = req.body || {};
    if (!businessId || !fileId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId + fileId required');
    try {
      const rows = await sbGet('anthropic_files', `id=eq.${fileId}&business_id=eq.${businessId}&select=anthropic_file_id`);
      const row = rows[0];
      if (!row) return apiError(res, 404, 'FILE_NOT_FOUND', 'file not found for this business');

      // Delete from Anthropic first (best effort — even if it fails, we still
      // want to drop the local row so the dashboard reflects user intent).
      await filesService.deleteFile(row.anthropic_file_id).catch((e) => {
        logger?.warn('/webhook/anthropic-file-delete', businessId, 'anthropic delete failed', { error: e.message });
      });
      // Hard delete the row in Supabase via the proper helper.
      if (typeof sbDelete === 'function') {
        await sbDelete('anthropic_files', `id=eq.${fileId}&business_id=eq.${businessId}`);
      } else {
        // Defensive fallback — should never hit if server.js wires sbDelete
        await sbPatch('anthropic_files', `id=eq.${fileId}&business_id=eq.${businessId}`, { is_default: false });
      }
      res.json({ ok: true });
    } catch (e) {
      logger?.error('/webhook/anthropic-file-delete', businessId, 'failed', e);
      apiError(res, 500, 'FILE_DELETE_FAILED', e.message);
    }
  }));

  app.post('/webhook/anthropic-file-set-default', limiters.fileMutate, trace('/webhook/anthropic-file-set-default', async (req, res) => {
    const { businessId, fileId, kind } = req.body || {};
    if (!businessId || !fileId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId + fileId required');
    try {
      const k = kind || 'brand_guidelines';
      await sbPatch('anthropic_files', `business_id=eq.${businessId}&kind=eq.${k}`, { is_default: false });
      await sbPatch('anthropic_files', `id=eq.${fileId}&business_id=eq.${businessId}`, { is_default: true, updated_at: new Date().toISOString() });
      res.json({ ok: true });
    } catch (e) {
      apiError(res, 500, 'FILE_SET_DEFAULT_FAILED', e.message);
    }
  }));

  // ─── Batch: POST /webhook/anthropic-batch-submit ────────────────────
  // Body: { purpose, requests: [{ businessId, customId, model, system, prompt, maxTokens, fileIds?, cacheSystem? }] }
  app.post('/webhook/anthropic-batch-submit', limiters.batchSubmit, trace('/webhook/anthropic-batch-submit', async (req, res) => {
    const { purpose, requests } = req.body || {};
    if (!Array.isArray(requests) || requests.length === 0) {
      return apiError(res, 400, 'INVALID_REQUEST', 'requests must be a non-empty array');
    }
    if (requests.length > 1000) return apiError(res, 400, 'BATCH_TOO_LARGE', 'max 1000 requests per submission via this route');

    try {
      // Validate per-business plan limits
      const businessIds = [...new Set(requests.map((r) => r.businessId).filter(Boolean))];
      for (const bid of businessIds) {
        const ctx = await getBusinessUserId(sbGet, bid);
        if (!ctx) return apiError(res, 404, 'BUSINESS_NOT_FOUND', `Business not found: ${bid}`);
        const planCheck = await checkMonthlyLimit(sbGet, ctx.user_id || bid, 'anthropic_batch', ctx.plan, PLAN_BATCH_LIMIT);
        if (!planCheck.allowed) {
          return apiError(res, 429, 'PLAN_LIMIT_REACHED', `Business ${bid} reached monthly batch limit (${planCheck.limit}).`);
        }
      }

      const built = requests.map((r) => batchService.buildRequest({
        customId: r.customId || `${r.businessId || 'biz'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        model: r.model || 'claude-sonnet-4-5',
        system: r.system,
        prompt: r.prompt,
        maxTokens: r.maxTokens,
        fileIds: r.fileIds,
        cacheSystem: r.cacheSystem !== false,
        citations: r.citations === true,
      }));
      const requestIndex = requests.map((r, i) => ({
        custom_id: built[i].custom_id,
        business_id: r.businessId || null,
        target_table: r.targetTable || null,
        target_id: r.targetId || null,
      }));
      const submitted = await batchService.submitBatch(built, { purpose: purpose || 'custom', requestIndex });

      for (const bid of businessIds) {
        const ctx = await getBusinessUserId(sbGet, bid);
        if (ctx?.user_id) logUsage(sbPost, ctx.user_id, 'anthropic_batch', bid);
      }
      res.json(submitted);
    } catch (e) {
      logger?.error('/webhook/anthropic-batch-submit', null, 'failed', e);
      apiError(res, 500, 'BATCH_SUBMIT_FAILED', e.message);
    }
  }));

  app.get('/webhook/anthropic-batch-status', limiters.batchPoll, trace('/webhook/anthropic-batch-status', async (req, res) => {
    const id = req.query?.anthropicBatchId || req.query?.batchId;
    if (!id) return apiError(res, 400, 'INVALID_REQUEST', 'anthropicBatchId required');
    try {
      const status = await batchService.pollBatch(id);
      res.json(status);
    } catch (e) {
      apiError(res, 500, 'BATCH_STATUS_FAILED', e.message);
    }
  }));

  app.post('/webhook/anthropic-batch-reconcile', limiters.batchPoll, trace('/webhook/anthropic-batch-reconcile', async (req, res) => {
    const id = req.body?.anthropicBatchId || req.body?.batchId;
    if (!id) return apiError(res, 400, 'INVALID_REQUEST', 'anthropicBatchId required');
    try {
      const out = await batchService.reconcileResults(id);
      res.json(out);
    } catch (e) {
      apiError(res, 500, 'BATCH_RECONCILE_FAILED', e.message);
    }
  }));

  app.post('/webhook/anthropic-batch-cancel', limiters.batchPoll, trace('/webhook/anthropic-batch-cancel', async (req, res) => {
    const id = req.body?.anthropicBatchId || req.body?.batchId;
    if (!id) return apiError(res, 400, 'INVALID_REQUEST', 'anthropicBatchId required');
    try {
      const out = await batchService.cancelBatch(id);
      res.json(out);
    } catch (e) {
      apiError(res, 500, 'BATCH_CANCEL_FAILED', e.message);
    }
  }));

  // ─── Citations: POST /webhook/insights-with-citations ───────────────
  // Body: { businessId, question, fileIds? (else uses business defaults), maxTokens? }
  // Returns: { renderedText, citations, raw }
  app.post('/webhook/insights-with-citations', limiters.insights, trace('/webhook/insights-with-citations', async (req, res) => {
    const { businessId, question, fileIds, maxTokens } = req.body || {};
    if (!businessId || !question) return apiError(res, 400, 'INVALID_REQUEST', 'businessId + question required');

    try {
      const ctx = await getBusinessUserId(sbGet, businessId);
      if (!ctx) return apiError(res, 404, 'BUSINESS_NOT_FOUND', `Business not found: ${businessId}`);
      const userId = ctx.user_id || businessId;

      const planCheck = await checkMonthlyLimit(sbGet, userId, 'insights_with_citations', ctx.plan, PLAN_INSIGHTS_LIMIT);
      if (!planCheck.allowed) {
        return apiError(res, 429, 'PLAN_LIMIT_REACHED', `Monthly insights limit reached (${planCheck.limit}).`);
      }

      // Resolve file_ids to use
      let useFileIds = Array.isArray(fileIds) ? fileIds.slice() : [];
      if (useFileIds.length === 0) {
        const defaults = await sbGet('anthropic_files', `business_id=eq.${businessId}&is_default=eq.true&select=anthropic_file_id`).catch(() => []);
        useFileIds = defaults.map((r) => r.anthropic_file_id).filter(Boolean);
      }

      const system = `You are Maroa.ai's senior marketing analyst. Produce grounded, cited recommendations only. Never invent data — every quantitative claim must reference a citation. Be terse.`;

      // ONE Claude call returning the full response body (content blocks
      // preserved so citations parser can read them). Cuts insights API
      // cost in half vs the naive two-call shape.
      const messageBody = await callClaude(question, 'claude-sonnet-4-5', maxTokens || 1500, {
        system,
        businessId,
        cacheSystem: true,
        cacheDocuments: true,
        citations: true,
        fileIds: useFileIds,
        returnFullResponse: true,
      });

      const parsed = citations.parseCitedResponse(messageBody);
      logUsage(sbPost, userId, 'insights_with_citations', businessId);

      res.json({
        renderedText: parsed.renderedText,
        citations: parsed.citations,
        usage: messageBody?.usage || null,
        planUsage: { count: planCheck.count + 1, limit: planCheck.limit },
      });
    } catch (e) {
      logger?.error('/webhook/insights-with-citations', businessId, 'failed', e);
      apiError(res, 500, 'INSIGHTS_FAILED', e.message);
    }
  }));

  // ─── Memory (public beta) ───────────────────────────────────────────
  app.post('/webhook/memory-ensure-session', limiters.memoryWrite, trace('/webhook/memory-ensure-session', async (req, res) => {
    const { businessId, userId, namespace } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const session = await memoryService.ensureSession({ businessId, userId, namespace });
      res.json({ session });
    } catch (e) {
      apiError(res, 500, 'MEMORY_ENSURE_FAILED', e.message);
    }
  }));

  app.post('/webhook/memory-append-fact', limiters.memoryWrite, trace('/webhook/memory-append-fact', async (req, res) => {
    const { sessionId, fact, kind, importance } = req.body || {};
    if (!sessionId || !fact) return apiError(res, 400, 'INVALID_REQUEST', 'sessionId + fact required');
    try {
      const out = await memoryService.appendFact({ sessionId, fact, kind, importance });
      res.json(out);
    } catch (e) {
      apiError(res, 500, 'MEMORY_APPEND_FAILED', e.message);
    }
  }));

  app.get('/webhook/memory-get-session', limiters.memoryRead, trace('/webhook/memory-get-session', async (req, res) => {
    const sessionId = req.query?.sessionId;
    if (!sessionId) return apiError(res, 400, 'INVALID_REQUEST', 'sessionId required');
    try {
      const out = await memoryService.getSession(sessionId);
      res.json(out || { session: null });
    } catch (e) {
      apiError(res, 500, 'MEMORY_GET_FAILED', e.message);
    }
  }));

  app.post('/webhook/memory-delete-session', limiters.memoryWrite, trace('/webhook/memory-delete-session', async (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId) return apiError(res, 400, 'INVALID_REQUEST', 'sessionId required');
    try {
      const out = await memoryService.deleteSession(sessionId);
      res.json(out);
    } catch (e) {
      apiError(res, 500, 'MEMORY_DELETE_FAILED', e.message);
    }
  }));

  // ─── Managed Agents (public beta) — pilot for WF-15 brain ───────────
  app.post('/webhook/managed-agent-run', limiters.agentRun, trace('/webhook/managed-agent-run', async (req, res) => {
    const { businessId, message, instructions, agentName, tools, files, memorySessionId, stream } = req.body || {};
    if (!businessId || !message) return apiError(res, 400, 'INVALID_REQUEST', 'businessId + message required');

    try {
      if (checkOrchestrationIdempotency) {
        const isDup = await checkOrchestrationIdempotency(businessId, `agent_run:${(message || '').slice(0, 80)}`, 30000);
        if (isDup) return apiError(res, 429, 'IDEMPOTENT_DUPLICATE', 'duplicate run within 30s window');
      }

      const externalId = `wf15:${businessId}`;
      const agent = await managedAgentService.ensureAgent({
        externalId,
        name: agentName || `Maroa WF15 brain — ${businessId}`,
        instructions: instructions || `You are Maroa's AI Brain for business ${businessId}. Delegate to internal MCP tools when you need data.`,
        tools: tools || [],
      });
      const result = await managedAgentService.runSession({
        agentId: agent.id || agent.agent_id,
        message,
        businessId,
        memorySessionId,
        files,
        stream: false,
      });
      res.json({ agent: { id: agent.id || agent.agent_id }, session: result });
    } catch (e) {
      logger?.error('/webhook/managed-agent-run', businessId, 'failed', e);
      apiError(res, 500, 'AGENT_RUN_FAILED', e.message);
    }
  }));

  app.get('/webhook/managed-agent-poll', limiters.agentPoll, trace('/webhook/managed-agent-poll', async (req, res) => {
    const sessionId = req.query?.sessionId;
    if (!sessionId) return apiError(res, 400, 'INVALID_REQUEST', 'sessionId required');
    try {
      const out = await managedAgentService.pollSession(sessionId);
      res.json(out);
    } catch (e) {
      apiError(res, 500, 'AGENT_POLL_FAILED', e.message);
    }
  }));

  app.post('/webhook/managed-agent-cancel', limiters.agentRun, trace('/webhook/managed-agent-cancel', async (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId) return apiError(res, 400, 'INVALID_REQUEST', 'sessionId required');
    try {
      const out = await managedAgentService.cancelSession(sessionId);
      res.json(out);
    } catch (e) {
      apiError(res, 500, 'AGENT_CANCEL_FAILED', e.message);
    }
  }));
}

module.exports = { registerAnthropicRoutes, PLAN_FILES_LIMIT, PLAN_BATCH_LIMIT, PLAN_INSIGHTS_LIMIT };
