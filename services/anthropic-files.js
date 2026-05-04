'use strict';

/**
 * services/anthropic-files.js
 * ---------------------------------------------------------------------------
 * Anthropic Files API integration. Lets a business upload brand guidelines /
 * past performance reports / content libraries once and reference them by
 * file_id in every subsequent Claude call. Pairs with prompt caching.
 *
 * Spec:  https://platform.claude.com/docs/en/build-with-claude/files
 * Beta:  anthropic-beta: files-api-2025-04-14
 *
 * Files API endpoints used:
 *   POST   /v1/files                     (multipart upload)
 *   GET    /v1/files                     (list)
 *   GET    /v1/files/:id                 (metadata)
 *   DELETE /v1/files/:id                 (delete)
 *
 * Free for upload/list/delete; only inference-time use is billed.
 *
 * Public API:
 *   uploadBuffer({ buffer, filename, mimeType }) -> { id, ... }
 *   listFiles() -> [...]
 *   getFile(id) -> {...}
 *   deleteFile(id) -> { ok }
 *   buildDocumentBlock({ fileId, citations?, cacheControl? })
 *   buildImageBlock({ fileId })
 * ---------------------------------------------------------------------------
 */

const https = require('https');

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const FILES_BETA = 'files-api-2025-04-14';

const MAX_FILE_BYTES = 500 * 1024 * 1024;  // 500 MB
const MAX_ORG_BYTES = 500 * 1024 * 1024 * 1024; // 500 GB (informational)

function ensureBuffer(b) {
  if (Buffer.isBuffer(b)) return b;
  if (typeof b === 'string') return Buffer.from(b, 'utf8');
  throw new Error('uploadBuffer: buffer must be a Buffer or string');
}

function makeMultipart(filename, mimeType, buffer) {
  const boundary = '----maroaUpload' + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename.replace(/"/g, '')}"\r\n` +
    `Content-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buffer, tail]);
  return { body, boundary };
}

function rawHttp(method, urlStr, headers, body, timeoutMs = 60000) {
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
        let parsed = null;
        try { parsed = JSON.parse(txt); } catch { parsed = txt; }
        resolve({ status: res.statusCode, body: parsed, raw: txt });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Anthropic Files request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function createFilesService({ apiKey, logger }) {
  if (!apiKey) {
    throw new Error('createFilesService: ANTHROPIC_KEY required');
  }

  const baseHeaders = {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': FILES_BETA,
  };

  async function uploadBuffer({ buffer, filename, mimeType }) {
    const buf = ensureBuffer(buffer);
    if (buf.length === 0) throw new Error('upload: empty buffer');
    if (buf.length > MAX_FILE_BYTES) throw new Error(`upload: file ${buf.length} exceeds 500MB max`);

    const { body, boundary } = makeMultipart(filename || 'upload.bin', mimeType, buf);
    const headers = {
      ...baseHeaders,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': body.length,
    };
    const r = await rawHttp('POST', `${ANTHROPIC_API_BASE}/v1/files`, headers, body, 120000);
    if (r.status < 200 || r.status >= 300) {
      logger?.warn('anthropic-files', null, 'upload failed', { status: r.status, body: typeof r.body === 'string' ? r.body.slice(0, 400) : r.body });
      const e = new Error(`Files upload HTTP ${r.status}`);
      e.status = r.status;
      e.body = r.body;
      throw e;
    }
    return r.body;
  }

  async function listFiles({ limit = 100 } = {}) {
    const r = await rawHttp(
      'GET',
      `${ANTHROPIC_API_BASE}/v1/files?limit=${Math.min(1000, limit)}`,
      baseHeaders,
      null,
      30000
    );
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`Files list HTTP ${r.status}`);
    }
    return r.body?.data || r.body?.files || [];
  }

  async function getFile(fileId) {
    if (!fileId) throw new Error('getFile: fileId required');
    const r = await rawHttp(
      'GET',
      `${ANTHROPIC_API_BASE}/v1/files/${encodeURIComponent(fileId)}`,
      baseHeaders,
      null,
      30000
    );
    if (r.status === 404) return null;
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`Files get HTTP ${r.status}`);
    }
    return r.body;
  }

  async function deleteFile(fileId) {
    if (!fileId) throw new Error('deleteFile: fileId required');
    const r = await rawHttp(
      'DELETE',
      `${ANTHROPIC_API_BASE}/v1/files/${encodeURIComponent(fileId)}`,
      baseHeaders,
      null,
      30000
    );
    if (r.status < 200 || r.status >= 300 && r.status !== 404) {
      throw new Error(`Files delete HTTP ${r.status}`);
    }
    return { ok: true };
  }

  /**
   * Build the document block to attach to a Messages request.
   * Pair with cache_control:'ephemeral' for prompt caching on large files.
   */
  function buildDocumentBlock({ fileId, title, context, citations = false, cacheControl = false }) {
    const block = {
      type: 'document',
      source: { type: 'file', file_id: fileId },
    };
    if (title) block.title = title;
    if (context) block.context = context;
    if (citations) block.citations = { enabled: true };
    if (cacheControl) block.cache_control = { type: 'ephemeral' };
    return block;
  }

  function buildImageBlock({ fileId }) {
    return {
      type: 'image',
      source: { type: 'file', file_id: fileId },
    };
  }

  return {
    uploadBuffer,
    listFiles,
    getFile,
    deleteFile,
    buildDocumentBlock,
    buildImageBlock,
    constants: { FILES_BETA, MAX_FILE_BYTES, MAX_ORG_BYTES },
  };
}

module.exports = { createFilesService, FILES_BETA, MAX_FILE_BYTES };
