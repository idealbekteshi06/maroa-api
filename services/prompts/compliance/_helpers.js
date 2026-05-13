'use strict';

/**
 * services/prompts/compliance/_helpers.js
 * ---------------------------------------------------------------------------
 * Shared utilities for the 20 industry compliance rulesets.
 *
 * Compliance is a HARD GATE — different semantic from methodologies (soft
 * suggestions) and channels (format hints). When a draft hits a compliance
 * violation, the pipeline must refuse to ship and surface a human-readable
 * reason citing the regulator + statute.
 *
 * The contract is enforced by tests/compliance-registry.test.js.
 */

function _normalize(text) {
  if (!text) return '';
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function _containsAny(text, patterns) {
  const lower = _normalize(text);
  for (const p of patterns) {
    if (typeof p === 'string' && lower.includes(p.toLowerCase())) return true;
    if (p instanceof RegExp && p.test(text)) return true;
  }
  return false;
}

function _matchedPatterns(text, patterns) {
  const lower = _normalize(text);
  const matched = [];
  for (const p of patterns) {
    if (typeof p === 'string' && lower.includes(p.toLowerCase())) {
      matched.push(p);
    } else if (p instanceof RegExp && p.test(text)) {
      matched.push(p.toString());
    }
  }
  return matched;
}

function makeViolation({ severity = 'block', issue, regulator, statute, suggestion, span = null }) {
  return {
    severity,
    issue: String(issue || ''),
    regulator: String(regulator || ''),
    statute: String(statute || ''),
    suggestion: String(suggestion || ''),
    span,
  };
}

function makeDisclosure({ when = 'always', disclosure, regulator, statute }) {
  return {
    when,
    disclosure: String(disclosure || ''),
    regulator: String(regulator || ''),
    statute: String(statute || ''),
  };
}

/**
 * Build a standard compliance ruleset module from a declarative spec.
 *
 * Each spec describes:
 *   - banned_claims: phrases or regex patterns that are HARD-REFUSE
 *     (each with regulator + statute citation)
 *   - required_disclosures: text that MUST appear in any compliant copy
 *   - platform_restrictions: 'allowed' | 'restricted' | 'banned' per platform
 *   - applyExtras: optional extra applyToDraft logic
 */
function buildComplianceModule(spec) {
  const {
    id,
    name,
    category,
    industries = [],
    regions = ['*'],
    regulators = [],
    source_citation,
    banned_claims = [],
    required_disclosures = [],
    platform_restrictions = {},
    examples_blocked = [],
    applyExtras,
    generateExtras,
  } = spec;

  function applyToDraft(draft, context = {}) {
    if (!draft) {
      return { ok: true, violations: [], required_disclosures: [], reasoning: 'empty draft' };
    }

    // Only applies when industry matches (unless module is industry-agnostic with *)
    if (industries.length && !industries.includes('*')) {
      const draftIndustry = context.industry;
      if (draftIndustry && !industries.includes(draftIndustry)) {
        return {
          ok: true,
          violations: [],
          required_disclosures: [],
          reasoning: `not ${id} industry (got ${draftIndustry})`,
        };
      }
    }

    const violations = [];

    // Banned-claim scan
    for (const claim of banned_claims) {
      const patterns = Array.isArray(claim.patterns) ? claim.patterns : [claim.pattern].filter(Boolean);
      const matched = _matchedPatterns(draft, patterns);
      if (matched.length) {
        violations.push(
          makeViolation({
            severity: claim.severity || 'block',
            issue: `${name}: banned claim — ${claim.issue || matched.join(', ')}`,
            regulator: claim.regulator || regulators.join('/'),
            statute: claim.statute || '',
            suggestion: claim.suggestion || 'Remove the banned claim or rephrase to avoid the specific language.',
          })
        );
      }
    }

    // Required-disclosure scan — flag any disclosure that should be present
    // but isn't. The "when" field gates: 'always' or 'if_claim_present:<pattern>'.
    const missingDisclosures = [];
    for (const d of required_disclosures) {
      const when = d.when || 'always';
      let shouldBePresent = false;
      if (when === 'always') {
        shouldBePresent = true;
      } else if (typeof when === 'string' && when.startsWith('if_claim_present:')) {
        const trigger = when.split(':').slice(1).join(':');
        shouldBePresent = _containsAny(draft, [trigger]);
      } else if (when instanceof RegExp) {
        shouldBePresent = when.test(draft);
      }
      if (shouldBePresent) {
        // Heuristic: check if any disclosure keyword phrase is present in draft
        const keyword = (d.disclosure || '').split(/[.,;]/)[0].toLowerCase().slice(0, 40);
        if (keyword && !_normalize(draft).includes(keyword.toLowerCase())) {
          missingDisclosures.push(d);
        }
      }
    }

    if (typeof applyExtras === 'function') {
      try {
        const extra = applyExtras(draft, context) || [];
        for (const v of extra) violations.push(v);
      } catch (e) {
        // soft-fail
      }
    }

    const hasBlock = violations.some((v) => v.severity === 'block');
    return {
      ok: !hasBlock,
      violations,
      required_disclosures: missingDisclosures,
      reasoning: `${violations.length} violations, ${missingDisclosures.length} missing disclosures`,
    };
  }

  function generateGuidance(context = {}) {
    const segments = [];
    segments.push(`COMPLIANCE: ${name} (${regulators.join(', ')}).`);
    if (banned_claims.length) {
      const summary = banned_claims
        .slice(0, 6)
        .map((c) => c.issue || (Array.isArray(c.patterns) ? c.patterns[0] : c.pattern))
        .filter(Boolean)
        .join(' / ');
      segments.push(`BANNED CLAIMS (hard refuse): ${summary}.`);
    }
    if (required_disclosures.length) {
      segments.push(
        `REQUIRED DISCLOSURES: ${required_disclosures
          .map((d) => d.disclosure)
          .slice(0, 3)
          .join(' | ')}`
      );
    }
    if (Object.keys(platform_restrictions).length) {
      const restricted = Object.entries(platform_restrictions)
        .filter(([_, v]) => v !== 'allowed')
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      if (restricted) segments.push(`PLATFORM RESTRICTIONS: ${restricted}.`);
    }
    if (typeof generateExtras === 'function') {
      try {
        const extra = generateExtras(context) || [];
        for (const seg of extra) if (seg) segments.push(seg);
      } catch (e) {
        // soft-fail
      }
    }
    return {
      prompt_segments: segments,
    };
  }

  return {
    id,
    name,
    category,
    industries,
    regions,
    regulators,
    source_citation,
    banned_claims,
    required_disclosures,
    platform_restrictions,
    examples_blocked,
    applyToDraft,
    generateGuidance,
  };
}

const COMPLIANCE_CATEGORIES = Object.freeze({
  HEALTH: 'health',
  FINANCIAL: 'financial',
  REGULATED_SUBSTANCES: 'regulated-substances',
  LEGAL_HOUSING: 'legal-housing',
  HIGH_RISK: 'high-risk',
});

module.exports = {
  _normalize,
  _containsAny,
  _matchedPatterns,
  makeViolation,
  makeDisclosure,
  buildComplianceModule,
  COMPLIANCE_CATEGORIES,
};
