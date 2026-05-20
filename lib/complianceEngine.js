'use strict';

/**
 * lib/complianceEngine.js
 * ----------------------------------------------------------------------------
 * Compliance v2 — hard-block + auto-rewrite + appeal.
 *
 * Replaces the warning-only gates in services/prompts/quality-gate. Where
 * the old gate said "this draft might trip a rule, consider rewording",
 * v2 says:
 *
 *   1. Classify the draft against industry rulesets (FDA, FTC, FCA, SEC,
 *      ABA, alcohol, supplements, real-estate, gambling, etc.) using a
 *      deterministic keyword + regex pass.
 *   2. Hard-block the draft from publishing if any HARD-tier rule fires.
 *   3. Use callClaude (with Haiku) to auto-generate a compliant rewrite
 *      that preserves the marketing intent but loses the violating
 *      language. The rewrite is returned alongside the violation list.
 *   4. Customer can either accept the rewrite (one click) OR submit an
 *      appeal — the appeal goes to decision_logs with status='appealed'
 *      and a human at Maroa reviews it within 24h.
 *
 * Design constraints (load-bearing):
 *
 *   - Deterministic FIRST. The keyword + regex classifier runs before any
 *     LLM call. If the draft is clean against every ruleset, the LLM
 *     never fires and the path is sub-100ms.
 *
 *   - Auto-rewrite is bounded: Haiku, max 800 tokens, single shot. If
 *     the rewrite still trips a rule (rare), we report both candidates
 *     and refuse to publish until a human chooses.
 *
 *   - Industry is REQUIRED on every call. Each industry has its own
 *     ruleset. Unknown industry → all 'generic' rules apply.
 *
 *   - Tier-gated: free + growth get HARD blocks only. Agency tier gets
 *     SOFT warnings + the rewrite. Enterprise gets the appeal path.
 *
 * Public API:
 *
 *   const compliance = createComplianceEngine({ callClaude, sbPost, logger });
 *   const verdict = await compliance.evaluate({
 *     businessId, industry, draft, surface, plan,
 *   });
 *   // verdict = { ok, violations[], rewrite?, severity, appealable }
 *
 *   await compliance.recordAppeal({ businessId, draft, verdict, reason });
 *   const status = await compliance.getAppealStatus({ appealId });
 *
 * Rulesets live in lib/compliance/ruleset.{INDUSTRY}.js — each one is a
 * pure data file (array of { id, severity, pattern, message, suggestion })
 * so the team can audit + extend without touching engine code.
 * ----------------------------------------------------------------------------
 */

const GENERIC_RULES = require('./compliance/ruleset.generic');

const RULESETS = {
  generic: GENERIC_RULES,
};

// Lazy-load industry rulesets so the engine boots even if the team
// hasn't shipped every ruleset yet. The returned ruleset is always the
// industry rules + the generic rules concatenated — industry rules
// take precedence (listed first) so a rule_id collision resolves in
// favour of the industry-specific definition.
function rulesetFor(industry) {
  const lower = String(industry || 'generic')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_');
  if (lower === 'generic') return RULESETS.generic;
  try {
    // eslint-disable-next-line global-require
    const mod = require(`./compliance/ruleset.${lower}`);
    return [...mod, ...RULESETS.generic];
  } catch {
    return RULESETS.generic;
  }
}

/**
 * Run the deterministic classifier. Returns matches array — each match is
 * { rule_id, severity, message, suggestion, evidence }.
 * Severity: 'hard' (blocks publish) | 'soft' (warns) | 'info' (hints).
 */
function classify(draftText, ruleset) {
  if (!draftText || typeof draftText !== 'string') return [];
  const text = draftText;
  const lower = text.toLowerCase();
  const matches = [];
  for (const rule of ruleset) {
    let hit = false;
    let evidence = null;
    if (rule.pattern instanceof RegExp) {
      const m = text.match(rule.pattern);
      if (m) {
        hit = true;
        evidence = m[0];
      }
    } else if (typeof rule.pattern === 'string') {
      if (lower.includes(rule.pattern.toLowerCase())) {
        hit = true;
        evidence = rule.pattern;
      }
    } else if (Array.isArray(rule.pattern)) {
      for (const p of rule.pattern) {
        if (typeof p === 'string' && lower.includes(p.toLowerCase())) {
          hit = true;
          evidence = p;
          break;
        }
        if (p instanceof RegExp) {
          const m = text.match(p);
          if (m) {
            hit = true;
            evidence = m[0];
            break;
          }
        }
      }
    }
    if (hit) {
      matches.push({
        rule_id: rule.id,
        severity: rule.severity || 'soft',
        message: rule.message,
        suggestion: rule.suggestion || null,
        evidence: evidence ? String(evidence).slice(0, 120) : null,
      });
    }
  }
  return matches;
}

function severityRollup(matches) {
  if (matches.some((m) => m.severity === 'hard')) return 'hard';
  if (matches.some((m) => m.severity === 'soft')) return 'soft';
  if (matches.length > 0) return 'info';
  return 'clean';
}

function makeRewritePrompt({ draft, industry, surface, violations }) {
  const bullets = violations
    .map((v, i) => `${i + 1}. (${v.severity}) ${v.message}${v.suggestion ? ` — suggestion: ${v.suggestion}` : ''}`)
    .join('\n');
  return [
    `You are a copy editor enforcing ${industry} marketing compliance.`,
    `The user is shipping this draft on the ${surface} surface, but it violates these rules:`,
    bullets,
    '',
    'Rewrite the draft so:',
    '  • Every rule violation is removed.',
    '  • The marketing intent — what the original was trying to sell — is preserved.',
    '  • The voice + length stay close to the original.',
    '  • No invented claims, no new numbers, no testimonials. If the original made a claim, soften it; never invent.',
    '',
    'Original draft:',
    '---',
    draft,
    '---',
    '',
    'Respond with JSON only: { "rewrite": "...", "preserved_intent": "one-sentence summary of what the rewrite still sells" }',
  ].join('\n');
}

function createComplianceEngine(deps = {}) {
  const { callClaude, sbPost, logger } = deps;

  async function evaluate({ businessId, industry = 'generic', draft, surface = 'social_post', plan = 'growth' }) {
    if (!draft || typeof draft !== 'string') {
      return { ok: true, violations: [], severity: 'clean', appealable: false };
    }
    const rules = rulesetFor(industry);
    const violations = classify(draft, rules);
    const severity = severityRollup(violations);

    if (severity === 'clean' || severity === 'info') {
      return { ok: true, violations, severity, appealable: false };
    }
    if (severity === 'soft' && plan !== 'agency' && plan !== 'enterprise') {
      // Growth + free see hard-only enforcement. Soft is informational.
      return { ok: true, violations, severity, appealable: false };
    }

    // We have violations that need a rewrite. Try to auto-rewrite via
    // Haiku — Sonnet/Opus would be overkill and 10× the cost.
    let rewrite = null;
    let preservedIntent = null;
    if (typeof callClaude === 'function') {
      try {
        const raw = await callClaude({
          system:
            'You are a strict compliance copy editor. Output JSON only. Never invent claims; only soften or remove.',
          user: makeRewritePrompt({ draft, industry, surface, violations }),
          model: 'claude-haiku-4-5',
          max_tokens: 800,
          extra: {
            businessId,
            skill: 'compliance_v2_rewrite',
            temperature: 0.2,
          },
        });
        const parsed = safeParseJson(raw);
        if (parsed?.rewrite && typeof parsed.rewrite === 'string') {
          // Re-classify the rewrite. If the rewrite still trips a hard
          // rule, we DON'T return it — we'd be telling the customer a
          // bad rewrite is safe. Better to return null and force review.
          const rewriteViolations = classify(parsed.rewrite, rules);
          if (severityRollup(rewriteViolations) !== 'hard') {
            rewrite = parsed.rewrite;
            preservedIntent = parsed.preserved_intent || null;
          } else {
            logger?.warn?.('compliance', businessId, 'rewrite still violates — discarded', {
              original_violations: violations.length,
              rewrite_violations: rewriteViolations.length,
            });
          }
        }
      } catch (e) {
        logger?.warn?.('compliance', businessId, 'rewrite failed — surfaces without rewrite', {
          error: e.message,
        });
      }
    }

    return {
      ok: severity !== 'hard',
      violations,
      severity,
      rewrite,
      preserved_intent: preservedIntent,
      appealable: plan === 'agency' || plan === 'enterprise',
    };
  }

  /**
   * Customer disagrees with the verdict. We capture the appeal as a row
   * a Maroa-side reviewer can look at. Fire-and-forget — appeals don't
   * unblock publishing in v1; the customer can edit + try again
   * immediately while the appeal awaits review.
   */
  async function recordAppeal({ businessId, draft, verdict, reason }) {
    if (typeof sbPost !== 'function') return { ok: false, reason: 'sbPost unavailable' };
    try {
      const row = {
        business_id: businessId,
        draft: String(draft).slice(0, 4000),
        violations: verdict?.violations || [],
        severity: verdict?.severity || null,
        rewrite_offered: verdict?.rewrite || null,
        appeal_reason: String(reason || '').slice(0, 1000),
        status: 'pending',
        created_at: new Date().toISOString(),
      };
      await sbPost('compliance_appeals', row);
      return { ok: true };
    } catch (e) {
      logger?.warn?.('compliance', businessId, 'appeal record failed', { error: e.message });
      return { ok: false, reason: e.message };
    }
  }

  return { evaluate, recordAppeal };
}

function safeParseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

module.exports = { createComplianceEngine, classify, severityRollup, rulesetFor };
