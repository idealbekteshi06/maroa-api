'use strict';

/**
 * services/prompts/methodologies/index.js
 * ---------------------------------------------------------------------------
 * Codified copywriting methodology registry. Wave 60 Session 1.
 *
 * Every framework a marketing specialist knows, codified as a data + logic
 * module that other parts of the system can apply against a draft. Each
 * module exports the same shape — see CONTRACT below.
 *
 * Categories:
 *   STRUCTURAL  — how to assemble copy (AIDA, PAS, BAB, FAB, etc.)
 *   PSYCHOLOGY  — buyer-mind frameworks (Schwartz, Sugarman, Cialdini, etc.)
 *   PROOF       — trust + credibility (Hopkins, Reeves, etc.)
 *   RESPONSE    — urgency + DR mechanics (Halbert PS, Caples headlines, etc.)
 *   BRAND       — long-term brand-building (Ogilvy, Bernbach, Burnett, etc.)
 *   MODERN      — digital/social-native (Mr Beast, UGC, feed-native, etc.)
 *
 * CONTRACT — every module must export:
 *   id                  — kebab-case unique key
 *   name                — human-readable
 *   category            — one of CATEGORIES
 *   source_citation     — "Author, Title (Year)"
 *   applicability       — { awareness_stages, funnel_stages, channels,
 *                            industries, regions } — '*' = any
 *   invariants          — array of {id, rule, kind: 'must_have'|'must_avoid'}
 *   applyToDraft(draft, context)
 *                       → { score: 0..1, fixes: [...], reasoning: string }
 *   generateFromSpec(context)
 *                       → { structure: string, prompt_segments: [...] }
 *   manipulation_risk   — 0..10 (Cialdini ethics floor — see Rule 6)
 *
 * Ethics ceiling (Wave 60 ground rule 6): the pipeline refuses outputs
 * whose summed manipulation_risk across applied frameworks > 6.
 * ---------------------------------------------------------------------------
 */

const CATEGORIES = Object.freeze({
  STRUCTURAL: 'structural',
  PSYCHOLOGY: 'psychology',
  PROOF: 'proof',
  RESPONSE: 'response',
  BRAND: 'brand',
  MODERN: 'modern',
});

// Module load happens lazily so a syntax error in one module doesn't kill
// the registry boot. Each entry is a factory that resolves to the module
// on first access; failures fall back to a NULL_MODULE that lets the
// pipeline degrade gracefully.
const _MODULE_PATHS = {
  // STRUCTURAL
  aida: './structural/aida',
  pas: './structural/pas',
  bab: './structural/bab',
  fab: './structural/fab',
  storybrand: './structural/storybrand',
  'star-story-solution': './structural/star-story-solution',
  sciaba: './structural/sciaba',
  '4ps': './structural/4ps',
  // PSYCHOLOGY
  'schwartz-5-stages': './psychology/schwartz-5-stages',
  'sugarman-30-triggers': './psychology/sugarman-30-triggers',
  'cialdini-7': './psychology/cialdini-7',
  'hormozi-value-equation': './psychology/hormozi-value-equation',
  'ariely-irrationality': './psychology/ariely-irrationality',
  'kahneman-system-1-2': './psychology/kahneman-system-1-2',
  // PROOF
  'hopkins-testimonials': './proof/hopkins-testimonials',
  'reeves-usp': './proof/reeves-usp',
  'lattman-credibility-hierarchy': './proof/lattman-credibility-hierarchy',
  // RESPONSE
  'halbert-ps-line': './response/halbert-ps-line',
  'caples-headline-types': './response/caples-headline-types',
  'kennedy-direct-response': './response/kennedy-direct-response',
  'schaefer-conversational-copy': './response/schaefer-conversational-copy',
  // BRAND
  'ogilvy-rules': './brand/ogilvy-rules',
  'bernbach-creative-revolution': './brand/bernbach-creative-revolution',
  'burnett-inherent-drama': './brand/burnett-inherent-drama',
  'bell-archetype-12': './brand/bell-archetype-12',
  // MODERN
  'edelman-trust-decline': './modern/edelman-trust-decline',
  'influencer-ugc-frame': './modern/influencer-ugc-frame',
  'mr-beast-retention': './modern/mr-beast-retention',
  'feed-native-laws': './modern/feed-native-laws',
};

const NULL_MODULE = Object.freeze({
  id: 'null',
  name: '(unavailable)',
  category: 'unavailable',
  source_citation: 'n/a',
  applicability: { awareness_stages: [], funnel_stages: [], channels: [], industries: [], regions: [] },
  invariants: [],
  manipulation_risk: 0,
  applyToDraft: () => ({ score: 0, fixes: [], reasoning: 'module unavailable' }),
  generateFromSpec: () => ({ structure: '', prompt_segments: [] }),
});

const _loadedModules = new Map();

function getFramework(id) {
  if (_loadedModules.has(id)) return _loadedModules.get(id);
  const path = _MODULE_PATHS[id];
  if (!path) return null;
  try {
    const mod = require(path);
    _loadedModules.set(id, mod);
    return mod;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[methodologies] failed to load ${id}: ${e.message}`);
    _loadedModules.set(id, NULL_MODULE);
    return NULL_MODULE;
  }
}

function listFrameworks({ category, applicability } = {}) {
  const all = Object.keys(_MODULE_PATHS)
    .map(getFramework)
    .filter((m) => m && m !== NULL_MODULE);
  return all.filter((m) => {
    if (category && m.category !== category) return false;
    if (applicability) {
      const { awareness_stage, funnel_stage, channel, industry, region } = applicability;
      const a = m.applicability;
      if (awareness_stage && !_matchesList(a.awareness_stages, awareness_stage)) return false;
      if (funnel_stage && !_matchesList(a.funnel_stages, funnel_stage)) return false;
      if (channel && !_matchesList(a.channels, channel)) return false;
      if (industry && !_matchesList(a.industries, industry)) return false;
      if (region && !_matchesList(a.regions, region)) return false;
    }
    return true;
  });
}

function _matchesList(list, value) {
  if (!Array.isArray(list)) return false;
  if (list.length === 0) return false;
  if (list.includes('*')) return true;
  return list.includes(value);
}

/**
 * Apply an array of frameworks against a draft, returning a per-framework
 * score + collected fixes. Soft-fails: if one module throws, others
 * still produce results.
 *
 * @param {object} args
 * @param {string} args.draft       The text to evaluate.
 * @param {string[]} args.frameworks  Framework IDs to apply.
 * @param {object} args.context     Optional: awareness_stage, funnel_stage,
 *                                  channel, industry, etc.
 */
function applyFrameworks({ draft, frameworks, context = {} } = {}) {
  if (!draft || !Array.isArray(frameworks) || !frameworks.length) {
    return { per_framework: [], aggregate_score: 0, all_fixes: [], manipulation_risk_total: 0 };
  }
  const results = [];
  let scoreSum = 0;
  let scoreCount = 0;
  let manipulationRiskTotal = 0;
  const allFixes = [];
  for (const id of frameworks) {
    const mod = getFramework(id);
    if (!mod || mod === NULL_MODULE) {
      results.push({ id, error: 'not found' });
      continue;
    }
    try {
      const r = mod.applyToDraft(draft, context) || { score: 0, fixes: [], reasoning: '' };
      results.push({
        id,
        name: mod.name,
        category: mod.category,
        score: typeof r.score === 'number' ? r.score : 0,
        fixes: Array.isArray(r.fixes) ? r.fixes : [],
        reasoning: r.reasoning || '',
        manipulation_risk: mod.manipulation_risk || 0,
      });
      scoreSum += typeof r.score === 'number' ? r.score : 0;
      scoreCount++;
      manipulationRiskTotal += mod.manipulation_risk || 0;
      for (const fix of r.fixes || []) allFixes.push({ framework: id, fix });
    } catch (e) {
      results.push({ id, error: e.message });
    }
  }
  return {
    per_framework: results,
    aggregate_score: scoreCount > 0 ? scoreSum / scoreCount : 0,
    all_fixes: allFixes,
    manipulation_risk_total: manipulationRiskTotal,
  };
}

/**
 * Recommend the 3 most-applicable frameworks for a given (awareness_stage,
 * funnel_stage, channel, industry, region) context. Picks one from
 * STRUCTURAL, one from PSYCHOLOGY/PROOF, one from RESPONSE/MODERN where
 * possible — so the recommendations span multiple dimensions.
 */
function recommendFrameworks({ awareness_stage, funnel_stage, channel, industry, region } = {}) {
  const ctx = { awareness_stage, funnel_stage, channel, industry, region };
  const eligible = listFrameworks({ applicability: ctx });
  if (eligible.length === 0) return [];

  const byCategory = {};
  for (const m of eligible) {
    if (!byCategory[m.category]) byCategory[m.category] = [];
    byCategory[m.category].push(m);
  }

  // Pick from buckets in priority order. The intent: get structural shape,
  // psychology layer, response trigger — so the model has explicit guidance
  // on form + emotional hook + action mechanic.
  const PRIORITY = [
    [CATEGORIES.STRUCTURAL],
    [CATEGORIES.PSYCHOLOGY, CATEGORIES.PROOF],
    [CATEGORIES.RESPONSE, CATEGORIES.MODERN, CATEGORIES.BRAND],
  ];
  const picked = [];
  const seen = new Set();
  for (const bucket of PRIORITY) {
    for (const cat of bucket) {
      if (byCategory[cat] && byCategory[cat].length) {
        const candidate = byCategory[cat].find((m) => !seen.has(m.id));
        if (candidate) {
          picked.push(candidate);
          seen.add(candidate.id);
          break;
        }
      }
    }
  }
  return picked.map((m) => ({
    id: m.id,
    name: m.name,
    category: m.category,
    manipulation_risk: m.manipulation_risk,
  }));
}

function listAllIds() {
  return Object.keys(_MODULE_PATHS);
}

module.exports = {
  CATEGORIES,
  getFramework,
  listFrameworks,
  listAllIds,
  applyFrameworks,
  recommendFrameworks,
  NULL_MODULE,
};
