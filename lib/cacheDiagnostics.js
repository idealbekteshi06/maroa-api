'use strict';

/**
 * lib/cacheDiagnostics.js
 * Tracks Anthropic message IDs per business+skill for cache_miss_reason diagnostics.
 */

const _lastMessageId = new Map();

function cacheKey(businessId, skill) {
  return `${businessId || 'global'}::${skill || 'default'}`;
}

function getPreviousMessageId(businessId, skill) {
  return _lastMessageId.get(cacheKey(businessId, skill)) || null;
}

function setPreviousMessageId(businessId, skill, messageId) {
  if (!messageId) return;
  _lastMessageId.set(cacheKey(businessId, skill), messageId);
  if (_lastMessageId.size > 5000) {
    const first = _lastMessageId.keys().next().value;
    _lastMessageId.delete(first);
  }
}

/**
 * Build diagnostics object for Messages API when caching is enabled.
 */
function buildDiagnosticsPayload({ businessId, skill, enable = true }) {
  if (!enable || process.env.MAROA_CACHE_DIAGNOSTICS === '0') return null;
  const prev = getPreviousMessageId(businessId, skill);
  if (!prev) return null;
  return { previous_message_id: prev };
}

function ingestResponse({ businessId, skill, responseBody, logger }) {
  const id = responseBody?.id;
  if (id) setPreviousMessageId(businessId, skill, id);

  const diag = responseBody?.cache_diagnostic || responseBody?.diagnostics;
  const reason = diag?.cache_miss_reason || responseBody?.cache_miss_reason;
  if (reason && logger?.info) {
    logger.info('/claude/cache', businessId, 'cache_miss_reason', {
      skill: skill || 'unknown',
      reason,
      previous_message_id: diag?.previous_message_id,
    });
  }
  return { message_id: id, cache_miss_reason: reason || null };
}

module.exports = {
  getPreviousMessageId,
  setPreviousMessageId,
  buildDiagnosticsPayload,
  ingestResponse,
};
