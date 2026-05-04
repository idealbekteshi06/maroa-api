'use strict';

/**
 * services/anthropic-citations.js
 * ---------------------------------------------------------------------------
 * Helper for the Anthropic Citations feature. Spec:
 * https://platform.claude.com/docs/en/build-with-claude/citations
 *
 * Citations are first-class on document blocks ({citations: {enabled: true}}).
 * The model returns text content blocks where each block may carry a citations
 * array of {type, cited_text, document_index, document_title, ...}. We do
 * NOT need a separate API surface — the existing callClaude flow can carry
 * documents + citations natively. This module provides:
 *
 *   - buildDocumentBlock(...) — convenience for inline/text/file/PDF docs
 *   - parseCitedResponse(messageBody) — turns the response.content array into
 *     { renderedText, citations } where renderedText is plain prose with inline
 *     [n] markers and citations is the deduped, indexed array for the UI
 *   - normaliseCitation(c) — cross-format citation shape
 *
 * Compatible with prompt caching (cache_control on the document block).
 * Incompatible with structured outputs (Anthropic enforces — we don't fight it).
 * ---------------------------------------------------------------------------
 */

function buildInlineTextDocument({ data, title, context, citations = true, cacheControl = false }) {
  const block = {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: data || '' },
  };
  if (title) block.title = title;
  if (context) block.context = context;
  if (citations) block.citations = { enabled: true };
  if (cacheControl) block.cache_control = { type: 'ephemeral' };
  return block;
}

function buildPdfBase64Document({ base64Data, title, context, citations = true, cacheControl = false }) {
  const block = {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: base64Data },
  };
  if (title) block.title = title;
  if (context) block.context = context;
  if (citations) block.citations = { enabled: true };
  if (cacheControl) block.cache_control = { type: 'ephemeral' };
  return block;
}

function buildFileDocument({ fileId, title, context, citations = true, cacheControl = false }) {
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

function buildCustomContentDocument({ contentBlocks, title, context, citations = true, cacheControl = false }) {
  const block = {
    type: 'document',
    source: { type: 'content', content: (contentBlocks || []).map((c) => ({ type: 'text', text: String(c) })) },
  };
  if (title) block.title = title;
  if (context) block.context = context;
  if (citations) block.citations = { enabled: true };
  if (cacheControl) block.cache_control = { type: 'ephemeral' };
  return block;
}

/**
 * Cross-format citation normalizer.
 * char_location → { kind:'text', start, end }
 * page_location → { kind:'pdf', startPage, endPage }
 * content_block_location → { kind:'block', startBlock, endBlock }
 */
function normaliseCitation(c) {
  if (!c || typeof c !== 'object') return null;
  const base = {
    cited_text: c.cited_text || '',
    document_index: Number(c.document_index) || 0,
    document_title: c.document_title || null,
  };
  if (c.type === 'char_location') {
    return { ...base, kind: 'text', start: c.start_char_index, end: c.end_char_index };
  }
  if (c.type === 'page_location') {
    return { ...base, kind: 'pdf', startPage: c.start_page_number, endPage: c.end_page_number };
  }
  if (c.type === 'content_block_location') {
    return { ...base, kind: 'block', startBlock: c.start_block_index, endBlock: c.end_block_index };
  }
  return { ...base, kind: c.type || 'unknown' };
}

/**
 * Turn an Anthropic Messages response into:
 *   { renderedText, citations }
 *
 * - renderedText is the assistant prose with inline [1], [2] markers where citations sit
 * - citations is a deduped array that the UI can render as a footnote / sidebar
 *
 * Citations are deduped by (document_index + cited_text) so repeated quotes
 * don't get separate footnote numbers.
 */
function parseCitedResponse(messageBody) {
  const blocks = Array.isArray(messageBody?.content) ? messageBody.content : [];
  const seen = new Map();
  const citations = [];
  const out = [];

  for (const blk of blocks) {
    if (blk?.type !== 'text') continue;
    const text = blk.text || '';
    if (!Array.isArray(blk.citations) || blk.citations.length === 0) {
      out.push(text);
      continue;
    }
    const indexes = [];
    for (const c of blk.citations) {
      const norm = normaliseCitation(c);
      if (!norm) continue;
      const key = `${norm.document_index}|${norm.cited_text}`;
      if (!seen.has(key)) {
        seen.set(key, citations.length + 1);
        citations.push({ index: citations.length + 1, ...norm });
      }
      indexes.push(seen.get(key));
    }
    if (indexes.length === 0) {
      out.push(text);
    } else {
      out.push(`${text} ${indexes.map((i) => `[${i}]`).join('')}`);
    }
  }
  return { renderedText: out.join('').trim(), citations };
}

module.exports = {
  buildInlineTextDocument,
  buildPdfBase64Document,
  buildFileDocument,
  buildCustomContentDocument,
  normaliseCitation,
  parseCitedResponse,
};
