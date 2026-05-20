'use strict';

/**
 * lib/complianceGate.js
 * ----------------------------------------------------------------------------
 * Thin wrapper around lib/complianceEngine.js for use at publish boundaries.
 *
 * Why a separate module: the engine returns a verdict object — callers
 * have to decide what to do with each severity tier. Most publish handlers
 * want the same semantics:
 *
 *   - severity = 'clean' or 'info'    → publish as-is
 *   - severity = 'soft' (free/growth) → publish, but log the warning
 *   - severity = 'soft' (agency+)     → offer rewrite, block until accepted
 *   - severity = 'hard'               → block, return 422 with the verdict
 *
 * This module exposes one function that encodes that logic so each route
 * is a one-liner.
 *
 * Usage:
 *
 *   const { ensureCompliant, ComplianceBlocked } = require('../lib/complianceGate');
 *
 *   try {
 *     await ensureCompliant({
 *       content: postText,
 *       industry: biz.industry,
 *       businessId: biz.id,
 *       plan: biz.plan,
 *       surface: 'social_post',
 *     });
 *   } catch (e) {
 *     if (e instanceof ComplianceBlocked) {
 *       return res.status(422).json({
 *         error: 'COMPLIANCE_HARD_BLOCK',
 *         violations: e.violations,
 *         rewrite: e.rewrite,
 *         appealable: e.appealable,
 *       });
 *     }
 *     throw e;
 *   }
 *
 * If you want the verdict WITHOUT throwing (e.g. to surface a soft warning
 * to the customer in the response without blocking), use `evaluateOnly`.
 *
 * Module gracefully degrades: if the compliance engine fails to load
 * (e.g. missing ruleset file) or callClaude is unavailable, ensureCompliant
 * resolves cleanly. The compliance gate is a fail-OPEN safety net — its job
 * is to catch obvious hard violations before they ship, not to be the
 * single point of failure that blocks customer publish flows.
 * ----------------------------------------------------------------------------
 */

const { createComplianceEngine } = require('./complianceEngine');

let _engine = null;
function _getEngine(deps) {
  if (_engine) return _engine;
  try {
    _engine = createComplianceEngine(deps);
  } catch {
    _engine = null;
  }
  return _engine;
}

class ComplianceBlocked extends Error {
  constructor(verdict) {
    super('Content blocked by compliance ruleset');
    this.name = 'ComplianceBlocked';
    this.verdict = verdict;
    this.violations = verdict?.violations || [];
    this.rewrite = verdict?.rewrite || null;
    this.severity = verdict?.severity || 'hard';
    this.appealable = !!verdict?.appealable;
  }
}

/**
 * Run compliance against the content. Throws ComplianceBlocked on hard
 * violations. Returns the verdict otherwise (caller may surface soft
 * warnings in response metadata).
 *
 * `deps` must include callClaude (for rewrites) and sbPost (for appeal
 * persistence). If they're omitted, the engine still runs the deterministic
 * classifier — just no auto-rewrite.
 */
async function ensureCompliant({ content, industry, businessId, plan = 'growth', surface = 'social_post', deps = {} }) {
  const engine = _getEngine(deps);
  if (!engine) return { ok: true, violations: [], severity: 'clean' };
  try {
    const verdict = await engine.evaluate({ businessId, industry, draft: content, surface, plan });
    if (verdict.severity === 'hard') {
      throw new ComplianceBlocked(verdict);
    }
    return verdict;
  } catch (e) {
    if (e instanceof ComplianceBlocked) throw e;
    // Engine internal failure — fail open with a logged warning. We don't
    // want the compliance gate to be a single point of failure for publish.
    return { ok: true, violations: [], severity: 'clean', engine_error: e.message };
  }
}

/** Non-throwing variant — returns the verdict regardless of severity. */
async function evaluateOnly({ content, industry, businessId, plan = 'growth', surface = 'social_post', deps = {} }) {
  const engine = _getEngine(deps);
  if (!engine) return { ok: true, violations: [], severity: 'clean' };
  try {
    return await engine.evaluate({ businessId, industry, draft: content, surface, plan });
  } catch (e) {
    return { ok: true, violations: [], severity: 'clean', engine_error: e.message };
  }
}

// Test hook — reset the lazy singleton between tests.
function _resetForTest() {
  _engine = null;
}

module.exports = { ensureCompliant, evaluateOnly, ComplianceBlocked, _resetForTest };
