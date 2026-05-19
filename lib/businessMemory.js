'use strict';

/**
 * lib/businessMemory.js
 * ---------------------------------------------------------------------------
 * Per-business long-term memory using Anthropic's Managed-Agents Memory API.
 *
 * Why this exists: Maroa already has pgvector (services/anthropic-memory's
 * companion) for embedding search and a custom memorySystem.js for facts.
 * Neither is great at "what has this specific business asked us to do
 * differently in the past 6 weeks?" — a use case that's better served by
 * an Anthropic-managed memory session, which the model can read in-context
 * with no embedding round-trip.
 *
 * This module is a thin singleton + business-namespaced wrapper around
 * services/anthropic-memory's createMemoryService. It exposes:
 *
 *   - rememberApproval(businessId, decision) — fires after a user clicks
 *     Approve. Stores a short "user approved <kind> with reason: X" note.
 *
 *   - rememberRejection(businessId, decision, reason) — same for reject.
 *
 *   - rememberPreference(businessId, kind, value) — explicit setting
 *     ("don't post on weekends", "use first-person").
 *
 *   - sessionIdFor(businessId) — returns the persistent session id so
 *     callers can pass `memory_session_id` to callClaude (when wired).
 *
 * All writes are fire-and-forget. Memory failures never block the user's
 * action — they only degrade future personalization.
 *
 * Toggle: opt-in via `ANTHROPIC_MEMORY_ENABLED=1`. With the flag off,
 * every method is a no-op so we don't accumulate noise (or cost) in dev.
 * ---------------------------------------------------------------------------
 */

const ENABLED = String(process.env.ANTHROPIC_MEMORY_ENABLED || '').match(/^(1|true|yes|on)$/i);

let _service = null;

function _serviceOrNull(apiKey, logger) {
  if (!ENABLED) return null;
  if (_service) return _service;
  try {
    const { createMemoryService } = require('../services/anthropic-memory');
    _service = createMemoryService({ apiKey, logger });
    return _service;
  } catch (e) {
    logger?.warn?.('business-memory', null, 'memory service init failed', { error: e.message });
    return null;
  }
}

const _sessionByBusiness = new Map();

async function _sessionFor(svc, businessId) {
  if (!svc) return null;
  const cached = _sessionByBusiness.get(businessId);
  if (cached) return cached;
  try {
    const s = await svc.ensureSession({ businessId, namespace: 'maroa-business' });
    if (s?.id) _sessionByBusiness.set(businessId, s.id);
    return s?.id || null;
  } catch {
    return null;
  }
}

function makeBusinessMemory({ apiKey, logger } = {}) {
  const svc = _serviceOrNull(apiKey, logger);

  async function rememberApproval(businessId, decision) {
    if (!svc || !businessId || !decision) return;
    try {
      const sid = await _sessionFor(svc, businessId);
      if (!sid) return;
      const fact =
        `User approved decision ${decision.id} from ${decision.agent_name || 'unknown agent'}` +
        ` (${decision.decision_type || 'unknown type'})` +
        (decision.recommendation_text ? `. Was: "${String(decision.recommendation_text).slice(0, 240)}"` : '');
      await svc.appendFact({ sessionId: sid, fact, kind: 'approval', importance: 0.6 });
    } catch (e) {
      logger?.warn?.('business-memory', businessId, 'rememberApproval failed', { error: e.message });
    }
  }

  async function rememberRejection(businessId, decision, reason) {
    if (!svc || !businessId || !decision) return;
    try {
      const sid = await _sessionFor(svc, businessId);
      if (!sid) return;
      const trimmedReason = String(reason || '').trim();
      const fact =
        `User rejected decision ${decision.id} from ${decision.agent_name || 'unknown agent'}` +
        (trimmedReason ? `. Reason: ${trimmedReason.slice(0, 240)}` : '. No reason given.') +
        (decision.recommendation_text ? ` Was: "${String(decision.recommendation_text).slice(0, 240)}"` : '');
      // Rejections are higher-signal than approvals — bump importance so
      // future generations are more likely to surface the avoidance.
      await svc.appendFact({ sessionId: sid, fact, kind: 'rejection', importance: 0.85 });
    } catch (e) {
      logger?.warn?.('business-memory', businessId, 'rememberRejection failed', { error: e.message });
    }
  }

  async function rememberPreference(businessId, kind, value) {
    if (!svc || !businessId) return;
    try {
      const sid = await _sessionFor(svc, businessId);
      if (!sid) return;
      const fact = `Preference: ${kind} = ${String(value).slice(0, 240)}`;
      await svc.appendFact({ sessionId: sid, fact, kind: 'preference', importance: 0.9 });
    } catch (e) {
      logger?.warn?.('business-memory', businessId, 'rememberPreference failed', { error: e.message });
    }
  }

  async function sessionIdFor(businessId) {
    if (!svc || !businessId) return null;
    return _sessionFor(svc, businessId);
  }

  return { rememberApproval, rememberRejection, rememberPreference, sessionIdFor, enabled: !!svc };
}

module.exports = { makeBusinessMemory };
