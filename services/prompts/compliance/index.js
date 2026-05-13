'use strict';

/**
 * services/prompts/compliance/index.js
 * ---------------------------------------------------------------------------
 * Industry compliance ruleset registry. Wave 60 Session 5.
 *
 * 20 high-regulation industries codified as HARD-REFUSAL gates. Different
 * semantic from methodologies (soft suggestions) and channels (format hints):
 * a compliance violation BLOCKS publication and cites the regulator + statute.
 *
 * Categories:
 *   HEALTH (5)               — healthcare, mental health, supplements, weight
 *                              loss, cosmetics
 *   FINANCIAL (4)            — financial advisor, mortgage, insurance,
 *                              accounting
 *   REGULATED_SUBSTANCES (4) — alcohol, cannabis, tobacco/vape, prescription
 *                              pharma
 *   LEGAL_HOUSING (3)        — legal practice, real estate, firearms
 *   HIGH_RISK (4)            — gambling, cryptocurrency, payday lending,
 *                              dating
 *
 * Each ruleset exports:
 *   id                   kebab-case unique key
 *   name                 human-readable
 *   category             one of COMPLIANCE_CATEGORIES
 *   industries           list of industry IDs from lib/taxonomy/industries.js
 *   regions              ISO codes or aggregates ('*' = global)
 *   regulators           FDA, FTC, FINRA, SEC, etc.
 *   source_citation
 *   banned_claims        [{ patterns, issue, regulator, statute, suggestion }]
 *   required_disclosures [{ when, disclosure, regulator, statute }]
 *   platform_restrictions { meta, google, tiktok: 'allowed'|'restricted'|'banned' }
 *   examples_blocked     realistic example phrases that hit refusal
 *   applyToDraft(draft, ctx) → { ok, violations[], required_disclosures[] }
 *   generateGuidance(ctx)    → { prompt_segments: [] }
 *
 * Used by:
 *   - Adversarial Critic (hard gate before publish)
 *   - Master pipeline (Wave 60 S10) — pre-flight compliance check
 *   - Plan-gate UI (warn merchant when their industry has restrictions)
 * ---------------------------------------------------------------------------
 */

const { COMPLIANCE_CATEGORIES } = require('./_helpers');

const _MODULE_PATHS = {
  // ── HEALTH ──────────────────────────────────────────────────────────
  'healthcare-general': './health/healthcare-general',
  'mental-health': './health/mental-health',
  'supplements-claims': './health/supplements-claims',
  'weight-loss': './health/weight-loss',
  'cosmetics-claims': './health/cosmetics-claims',

  // ── FINANCIAL ───────────────────────────────────────────────────────
  'financial-advisor': './financial/financial-advisor',
  'mortgage-broker': './financial/mortgage-broker',
  'insurance-agency': './financial/insurance-agency',
  accountant: './financial/accountant',

  // ── REGULATED SUBSTANCES ────────────────────────────────────────────
  alcohol: './regulated-substances/alcohol',
  cannabis: './regulated-substances/cannabis',
  'tobacco-vape': './regulated-substances/tobacco-vape',
  'prescription-pharma': './regulated-substances/prescription-pharma',

  // ── LEGAL + HOUSING ─────────────────────────────────────────────────
  'legal-practice': './legal-housing/legal-practice',
  'real-estate-fair-housing': './legal-housing/real-estate-fair-housing',
  firearms: './legal-housing/firearms',

  // ── HIGH-RISK ───────────────────────────────────────────────────────
  gambling: './high-risk/gambling',
  cryptocurrency: './high-risk/cryptocurrency',
  'payday-lending': './high-risk/payday-lending',
  dating: './high-risk/dating',
};

const NULL_MODULE = Object.freeze({
  id: 'null',
  name: '(unavailable)',
  category: 'unavailable',
  industries: [],
  regions: [],
  regulators: [],
  source_citation: 'n/a',
  banned_claims: [],
  required_disclosures: [],
  platform_restrictions: {},
  examples_blocked: [],
  applyToDraft: () => ({ ok: true, violations: [], required_disclosures: [], reasoning: 'module unavailable' }),
  generateGuidance: () => ({ prompt_segments: [] }),
});

const _loadedModules = new Map();

function getRuleset(id) {
  if (_loadedModules.has(id)) return _loadedModules.get(id);
  const path = _MODULE_PATHS[id];
  if (!path) return null;
  try {
    const mod = require(path);
    _loadedModules.set(id, mod);
    return mod;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[compliance] failed to load ${id}: ${e.message}`);
    _loadedModules.set(id, NULL_MODULE);
    return NULL_MODULE;
  }
}

function listRulesets({ category, region } = {}) {
  return Object.keys(_MODULE_PATHS)
    .map(getRuleset)
    .filter((m) => m && m !== NULL_MODULE)
    .filter((m) => {
      if (category && m.category !== category) return false;
      if (region) {
        const regions = m.regions || [];
        if (!regions.includes('*') && !regions.includes(region)) return false;
      }
      return true;
    });
}

function listAllIds() {
  return Object.keys(_MODULE_PATHS);
}

/**
 * Resolve compliance rulesets that apply for a given industry. Used by
 * the master pipeline to gate generated copy before publish.
 *
 * Many industries map to a single ruleset (e.g. mortgage_broker →
 * mortgage-broker compliance). Some industries trigger multiple
 * (e.g. supplements_ecommerce → supplements-claims + healthcare-general).
 */
function rulesetsForIndustry(industry) {
  if (!industry) return [];
  return Object.keys(_MODULE_PATHS)
    .map(getRuleset)
    .filter((m) => m && m !== NULL_MODULE)
    .filter((m) => Array.isArray(m.industries) && m.industries.includes(industry));
}

/**
 * Apply every applicable compliance ruleset against a draft for the given
 * industry. Returns combined violations. If ANY violation has severity
 * 'block', the publish must be refused.
 */
function applyCompliance({ draft, industry, context = {} } = {}) {
  const rulesets = rulesetsForIndustry(industry);
  const allViolations = [];
  const allDisclosures = [];
  const reasoning = [];
  for (const ruleset of rulesets) {
    try {
      const r = ruleset.applyToDraft(draft, { ...context, industry });
      for (const v of r.violations || []) allViolations.push({ ruleset_id: ruleset.id, ...v });
      for (const d of r.required_disclosures || []) allDisclosures.push({ ruleset_id: ruleset.id, ...d });
      reasoning.push(`${ruleset.id}: ${r.reasoning || ''}`);
    } catch (e) {
      reasoning.push(`${ruleset.id}: ERROR ${e.message}`);
    }
  }
  const ok = !allViolations.some((v) => v.severity === 'block');
  return {
    ok,
    violations: allViolations,
    required_disclosures: allDisclosures,
    rulesets_applied: rulesets.map((r) => r.id),
    reasoning: reasoning.join('; '),
  };
}

function getComplianceGuidance({ industry, context = {} } = {}) {
  const rulesets = rulesetsForIndustry(industry);
  const segments = [];
  for (const ruleset of rulesets) {
    try {
      const g = ruleset.generateGuidance({ ...context, industry });
      for (const seg of g.prompt_segments || []) segments.push(seg);
    } catch (e) {
      // soft-fail
    }
  }
  return { rulesets_applied: rulesets.map((r) => r.id), prompt_segments: segments };
}

module.exports = {
  COMPLIANCE_CATEGORIES,
  getRuleset,
  listRulesets,
  listAllIds,
  rulesetsForIndustry,
  applyCompliance,
  getComplianceGuidance,
  NULL_MODULE,
};
