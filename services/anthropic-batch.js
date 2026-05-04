'use strict';

/**
 * services/anthropic-batch.js
 * ---------------------------------------------------------------------------
 * Anthropic Message Batches API integration. 50% cost savings on async work.
 * Most batches finish in <1 hour; max 24h SLA.
 *
 * Spec: https://platform.claude.com/docs/en/build-with-claude/batch-processing
 *
 * Endpoints used:
 *   POST   /v1/messages/batches                 (submit batch)
 *   GET    /v1/messages/batches/:id             (poll status)
 *   GET    /v1/messages/batches/:id/results     (results, JSONL)
 *   POST   /v1/messages/batches/:id/cancel      (cancel)
 *   DELETE /v1/messages/batches/:id             (delete)
 *
 * Batch lifecycle: in_progress -> ended (with per-request results inside)
 * Per-request statuses: succeeded | errored | canceled | expired
 *
 * Public API:
 *   submitBatch({ requests, purpose, onSubmitted? }) -> { anthropicId, internalId, requestCount }
 *   pollBatch(anthropicBatchId) -> { status, processing_status, request_counts }
 *   fetchResults(anthropicBatchId) -> [ { custom_id, result, message } ]
 *   cancelBatch(anthropicBatchId) -> {...}
 *   buildRequest({ customId, model, system, prompt, ... }) -> request entry
 * ---------------------------------------------------------------------------
 */

const https = require('https');

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const BATCH_MAX_REQUESTS = 100000;           // Anthropic max
const EXTENDED_OUTPUT_BETA = 'output-300k-2026-03-24'; // Opus 4.6+/Sonnet 4.6+ extended max_tokens

function rawHttp(method, urlStr, headers, body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      headers,
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        let parsed = txt;
        if (res.headers['content-type']?.includes('application/json')) {
          try { parsed = JSON.parse(txt); } catch { /* keep raw */ }
        }
        resolve({ status: res.statusCode, body: parsed, raw: txt });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Anthropic Batch request timeout')));
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function createBatchService({ apiKey, logger, sbPost, sbPatch, sbGet }) {
  if (!apiKey) {
    throw new Error('createBatchService: ANTHROPIC_KEY required');
  }

  function headers(extraBetas = []) {
    const betas = ['message-batches-2024-09-24', ...extraBetas];
    return {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': betas.join(','),
      'Content-Type': 'application/json',
    };
  }

  /**
   * Build one request entry to include in a batch.
   *   customId: unique within the batch (≤64 chars), used to match results back
   *   params:   the same shape as a Messages create request
   */
  function buildRequest({ customId, model, system, prompt, maxTokens, fileIds, cacheSystem, citations, extraDocumentBlocks }) {
    if (!customId) throw new Error('buildRequest: customId required');
    if (!model) throw new Error('buildRequest: model required');

    const userContent = [];
    // Documents (with optional citations + caching)
    for (const fileId of fileIds || []) {
      const block = { type: 'document', source: { type: 'file', file_id: fileId } };
      if (citations) block.citations = { enabled: true };
      userContent.push(block);
    }
    for (const blk of extraDocumentBlocks || []) userContent.push(blk);
    userContent.push({ type: 'text', text: prompt });

    const params = {
      model,
      max_tokens: maxTokens || 4096,
      messages: [{ role: 'user', content: userContent }],
    };
    if (system) {
      if (cacheSystem) {
        params.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
      } else {
        params.system = system;
      }
    }
    return { custom_id: customId.slice(0, 64), params };
  }

  /**
   * Submit a batch of up to 100k requests.
   * @param {Array<object>} requests - array of { custom_id, params } from buildRequest
   * @param {object} opts - { purpose, requestIndex (audit metadata), extraBetas, persist:true }
   */
  async function submitBatch(requests, opts = {}) {
    if (!Array.isArray(requests) || requests.length === 0) {
      throw new Error('submitBatch: requests must be non-empty array');
    }
    if (requests.length > BATCH_MAX_REQUESTS) {
      throw new Error(`submitBatch: ${requests.length} exceeds ${BATCH_MAX_REQUESTS} max`);
    }
    const purpose = opts.purpose || 'custom';
    const wantsExtended = requests.some((r) => Number(r.params?.max_tokens) > 64000);
    const extraBetas = wantsExtended ? [EXTENDED_OUTPUT_BETA, ...(opts.extraBetas || [])] : (opts.extraBetas || []);

    // Validate prompt caching beta header is set when any request uses cache_control on system
    const hasCache = requests.some((r) => Array.isArray(r.params?.system) && r.params.system.some((s) => s?.cache_control));
    if (hasCache) extraBetas.push('prompt-caching-2024-07-31');

    const r = await rawHttp(
      'POST',
      `${ANTHROPIC_API_BASE}/v1/messages/batches`,
      headers(extraBetas),
      { requests }
    );
    if (r.status < 200 || r.status >= 300) {
      logger?.warn('anthropic-batch', null, 'submit failed', { status: r.status, body: typeof r.body === 'string' ? r.body.slice(0, 400) : r.body });
      throw new Error(`Batch submit HTTP ${r.status}: ${typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body).slice(0, 200)}`);
    }
    const batch = r.body;
    const internal = opts.persist === false ? null : await sbPost?.('anthropic_batches', {
      anthropic_batch_id: batch.id,
      purpose,
      request_count: requests.length,
      status: batch.processing_status === 'in_progress' ? 'in_progress' : (batch.processing_status || 'in_progress'),
      submitted_at: batch.created_at || new Date().toISOString(),
      expires_at: batch.expires_at || null,
      request_index: opts.requestIndex || requests.map((req) => ({ custom_id: req.custom_id })),
      metadata: opts.metadata || {},
    }).catch((e) => {
      logger?.warn('anthropic-batch', null, 'persist failed', { error: e.message });
      return null;
    });

    return {
      anthropicId: batch.id,
      internalId: internal?.[0]?.id || internal?.id || null,
      requestCount: requests.length,
      submittedAt: batch.created_at,
      expiresAt: batch.expires_at,
    };
  }

  async function pollBatch(anthropicBatchId) {
    const r = await rawHttp(
      'GET',
      `${ANTHROPIC_API_BASE}/v1/messages/batches/${encodeURIComponent(anthropicBatchId)}`,
      headers(),
      null
    );
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`Batch poll HTTP ${r.status}`);
    }
    return r.body;
  }

  /**
   * Fetch results as JSONL → array of { custom_id, result }
   * result can be:
   *   { type: 'succeeded', message: { content: [...], ... } }
   *   { type: 'errored', error: {...} }
   *   { type: 'canceled' }
   *   { type: 'expired' }
   */
  async function fetchResults(anthropicBatchId) {
    const r = await rawHttp(
      'GET',
      `${ANTHROPIC_API_BASE}/v1/messages/batches/${encodeURIComponent(anthropicBatchId)}/results`,
      headers(),
      null,
      300000
    );
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`Batch results HTTP ${r.status}`);
    }
    const out = [];
    const lines = String(r.raw || '').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (e) {
        logger?.warn('anthropic-batch', null, 'jsonl parse failed', { error: e.message, snippet: line.slice(0, 100) });
      }
    }
    return out;
  }

  async function cancelBatch(anthropicBatchId) {
    const r = await rawHttp(
      'POST',
      `${ANTHROPIC_API_BASE}/v1/messages/batches/${encodeURIComponent(anthropicBatchId)}/cancel`,
      headers(),
      ''
    );
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`Batch cancel HTTP ${r.status}`);
    }
    return r.body;
  }

  /**
   * Update the internal anthropic_batches row with the latest poll result and
   * persist per-request results to anthropic_batch_results.
   * Idempotent — safe to call repeatedly.
   */
  async function reconcileResults(anthropicBatchId) {
    const polled = await pollBatch(anthropicBatchId);
    const isEnded = polled.processing_status === 'ended' || polled.processing_status === 'completed';
    if (sbPatch) {
      await sbPatch('anthropic_batches', `anthropic_batch_id=eq.${anthropicBatchId}`, {
        status: polled.processing_status || polled.status,
        processing_status: polled.processing_status,
        succeeded_count: polled.request_counts?.succeeded || 0,
        errored_count: polled.request_counts?.errored || 0,
        canceled_count: polled.request_counts?.canceled || 0,
        expired_count: polled.request_counts?.expired || 0,
        ended_at: polled.ended_at || null,
        results_url: polled.results_url || null,
      }).catch(() => {});
    }
    if (!isEnded) return { polled, applied: 0 };

    const results = await fetchResults(anthropicBatchId);
    const internalRows = sbGet ? await sbGet('anthropic_batches', `anthropic_batch_id=eq.${anthropicBatchId}&select=id,request_index`).catch(() => []) : [];
    const internalId = internalRows[0]?.id || null;
    const requestIndex = Array.isArray(internalRows[0]?.request_index) ? internalRows[0].request_index : [];
    const indexMap = new Map(requestIndex.map((e) => [e.custom_id, e]));

    let applied = 0;
    if (internalId && sbPost) {
      for (const r of results) {
        const idx = indexMap.get(r.custom_id) || {};
        const status = r.result?.type || 'unknown';
        await sbPost('anthropic_batch_results', {
          batch_id: internalId,
          custom_id: r.custom_id,
          business_id: idx.business_id || null,
          result_status: status,
          response_body: r.result?.type === 'succeeded' ? r.result.message : null,
          error: r.result?.type === 'errored' ? r.result.error : null,
        }).catch(() => {});
        applied++;
      }
    }
    return { polled, applied, results };
  }

  return {
    buildRequest,
    submitBatch,
    pollBatch,
    fetchResults,
    cancelBatch,
    reconcileResults,
    constants: { BATCH_MAX_REQUESTS, EXTENDED_OUTPUT_BETA },
  };
}

module.exports = { createBatchService, BATCH_MAX_REQUESTS, EXTENDED_OUTPUT_BETA };
