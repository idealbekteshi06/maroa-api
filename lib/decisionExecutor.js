'use strict';

/**
 * lib/decisionExecutor.js
 * ----------------------------------------------------------------------------
 * Executes a `decision_logs` row after a human approves it.
 *
 * Pre-2026-05-20 audit gap: routes/war-room.js called decisionLog.approve()
 * which just stamped `approved_at` on the row. No executor ran. So when
 * a customer approved "scale Meta campaign +20%" in the War Room, the
 * campaign was not scaled — only the row had `approved_at` filled in.
 *
 * This module closes that loop. After approve, the dispatch path is:
 *
 *   decisionLog.approve(...)
 *     → decisionExecutor.execute(decision, deps)
 *         → switch on decision.decision_type
 *         → loopback HTTP POST to /webhook/{action} with the right body
 *         → mark decision.executed_at + execution_details on success
 *
 * Loopback (vs direct function calls) is intentional:
 *   - The webhook handlers already exist and are tested
 *   - Loopback inherits per-route middleware (idempotency, plan gates)
 *   - Easy to extend — add a new decision_type and point it at a webhook
 *
 * Fire-and-forget by design: the War Room response returns to the customer
 * the moment approve persists, then the executor runs async. If the
 * executor fails, the row is marked executed:false with the error in
 * execution_details so the customer can retry from the dashboard.
 * ----------------------------------------------------------------------------
 */

const DEFAULT_TIMEOUT_MS = 30_000;

function _selfBase() {
  const port = process.env.PORT || 3000;
  return process.env.MAROA_INTERNAL_BASE || `http://127.0.0.1:${port}`;
}

async function _post(path, body, { timeoutMs = DEFAULT_TIMEOUT_MS, secret } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${_selfBase()}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { 'X-Internal-Secret': secret } : {}),
      },
      body: JSON.stringify(body || {}),
      signal: ctl.signal,
    });
    const text = await r.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { ok: r.ok, status: r.status, body: parsed };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Map a decision_type → a loopback action. Returns null if unsupported.
 * Each handler returns the body to POST to the chosen path.
 */
function _routeFor(decision) {
  const dt = (decision.decision_type || '').toLowerCase();
  const inputs = decision.inputs || {};
  const businessId = decision.business_id;

  // Ad-optimizer decisions — these run the portfolio optimizer for the
  // relevant business. The optimizer reads recent perf + the decision row
  // it just approved and acts on it. This is intentionally a coarse hook;
  // future versions can implement per-campaign atomic execution.
  if (dt === 'scale_budget' || dt === 'increase_budget' || dt === 'decrease_budget') {
    if (!businessId) return null;
    return { path: '/webhook/meta-campaign-optimize', body: { business_id: businessId } };
  }
  if (dt === 'pause_campaign') {
    if (!businessId) return null;
    return { path: '/webhook/meta-campaign-optimize', body: { business_id: businessId } };
  }
  if (dt === 'refresh_creative') {
    if (!businessId) return null;
    return { path: '/webhook/creative-refresh', body: { business_id: businessId, decision_id: decision.id } };
  }
  // Content decisions — generate the approved piece (or theme).
  if (dt === 'generate_content' || dt === 'instant_content') {
    if (!businessId) return null;
    return {
      path: '/webhook/instant-content',
      body: {
        business_id: businessId,
        theme: inputs.theme || decision.recommendation_text || null,
      },
    };
  }
  // Apply CRO suggestion to the landing page (services/cro/).
  if (dt === 'apply_cro_fix') {
    if (!businessId) return null;
    return {
      path: '/webhook/cro-apply',
      body: { business_id: businessId, fix: inputs.fix || null, decision_id: decision.id },
    };
  }

  return null; // unsupported type — caller logs + marks executed=false
}

/**
 * Execute one approved decision. Returns a result object even on failure
 * so the caller can persist execution_details + logs without throwing.
 */
async function execute(decision, { sbPatch, logger, internalSecret } = {}) {
  if (!decision || !decision.id) {
    return { ok: false, reason: 'no-decision' };
  }
  const route = _routeFor(decision);
  if (!route) {
    if (typeof sbPatch === 'function') {
      await sbPatch(
        'decision_logs',
        `id=eq.${encodeURIComponent(decision.id)}`,
        {
          executed: false,
          execution_details: { ok: false, reason: 'unsupported_decision_type', decision_type: decision.decision_type },
        },
      ).catch(() => {});
    }
    logger?.warn?.('decisionExecutor', decision.business_id, 'unsupported decision_type', {
      decision_id: decision.id,
      decision_type: decision.decision_type,
    });
    return { ok: false, reason: 'unsupported_decision_type' };
  }

  const start = Date.now();
  let result;
  try {
    result = await _post(route.path, route.body, { secret: internalSecret });
  } catch (e) {
    result = { ok: false, status: 0, body: { error: e.message } };
  }

  const elapsed = Date.now() - start;
  const details = {
    ok: !!result.ok,
    status: result.status,
    path: route.path,
    elapsed_ms: elapsed,
    response: result.body && typeof result.body === 'object' ? result.body : { raw: String(result.body).slice(0, 500) },
  };

  if (typeof sbPatch === 'function') {
    await sbPatch(
      'decision_logs',
      `id=eq.${encodeURIComponent(decision.id)}`,
      {
        executed: !!result.ok,
        executed_at: result.ok ? new Date().toISOString() : null,
        execution_details: details,
      },
    ).catch(() => {});
  }
  logger?.info?.('decisionExecutor', decision.business_id, result.ok ? 'executed' : 'failed', {
    decision_id: decision.id,
    decision_type: decision.decision_type,
    elapsed_ms: elapsed,
    status: result.status,
  });
  return { ok: !!result.ok, details };
}

module.exports = { execute, _routeFor };
