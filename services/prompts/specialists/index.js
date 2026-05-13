'use strict';

/**
 * services/prompts/specialists/index.js
 * ---------------------------------------------------------------------------
 * Specialist mode dispatcher registry. Wave 60 Session 9.
 *
 * 7 specialist modes that combine methodology + channel + ethics ceiling
 * into a coherent role. Each specialist scores its fit for an incoming
 * job and the dispatcher picks the best fit.
 *
 *  direct-response       Halbert/Kennedy/Sugarman: sales-page, BFCM, urgent
 *  brand-builder         Ogilvy/Bernbach/Burnett: brand voice, long-term
 *  performance-marketer  Meta/Google ads, CTR/CPA optimization
 *  content-marketer      SEO + thought-leadership + nurture
 *  social-media-manager  feed-native social content
 *  lifecycle-marketer    email sequences, retention, customer journey
 *  growth-engineer       viral mechanics, referral loops, PLG
 *
 * Each specialist exports:
 *   id · name · description · source_citation
 *   preferred_methodologies · preferred_channels
 *   decision_style · prompt_persona
 *   manipulation_risk_ceiling
 *   chooseForJob(context) → { score, signals, manipulation_risk_ceiling }
 *   generateBriefSegments(context) → string[]
 *
 * Used by the master pipeline (Wave 60 S10) to route generation jobs.
 * ---------------------------------------------------------------------------
 */

const _MODULE_PATHS = {
  'direct-response': './direct-response',
  'brand-builder': './brand-builder',
  'performance-marketer': './performance-marketer',
  'content-marketer': './content-marketer',
  'social-media-manager': './social-media-manager',
  'lifecycle-marketer': './lifecycle-marketer',
  'growth-engineer': './growth-engineer',
};

const NULL_MODULE = Object.freeze({
  id: 'null',
  name: '(unavailable)',
  description: '',
  source_citation: 'n/a',
  preferred_methodologies: [],
  preferred_channels: [],
  decision_style: '',
  prompt_persona: '',
  manipulation_risk_ceiling: 0,
  job_fit_weights: {},
  chooseForJob: () => ({ id: 'null', score: 0, signals: {} }),
  generateBriefSegments: () => [],
});

const _loadedModules = new Map();

function getSpecialist(id) {
  if (_loadedModules.has(id)) return _loadedModules.get(id);
  const path = _MODULE_PATHS[id];
  if (!path) return null;
  try {
    const mod = require(path);
    _loadedModules.set(id, mod);
    return mod;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[specialists] failed to load ${id}: ${e.message}`);
    _loadedModules.set(id, NULL_MODULE);
    return NULL_MODULE;
  }
}

function listSpecialists() {
  return Object.keys(_MODULE_PATHS)
    .map(getSpecialist)
    .filter((m) => m && m !== NULL_MODULE);
}

function listAllIds() {
  return Object.keys(_MODULE_PATHS);
}

/**
 * Pick the specialist with the highest job-fit score for a given context.
 * Returns { specialist, score, runners_up: [{id, score}, ...] } — runners_up
 * useful for transparency / debug + telemetry.
 */
function pickSpecialist(context = {}) {
  const specialists = listSpecialists();
  const scored = specialists.map((s) => s.chooseForJob(context));
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const top = scored[0];
  const winner = getSpecialist(top.id);
  return {
    specialist: winner,
    score: top.score,
    signals: top.signals,
    runners_up: scored.slice(1, 4).map((s) => ({ id: s.id, score: s.score })),
  };
}

module.exports = {
  getSpecialist,
  listSpecialists,
  listAllIds,
  pickSpecialist,
  NULL_MODULE,
};
