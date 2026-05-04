'use strict';

const { DIMENSIONS, weightsFor } = require('./weights');

const VERDICT_BANDS = {
  use_as_is: [85, 100.01],
  enhance_via_higgsfield: [60, 84.999],
  regenerate_fresh: [40, 59.999],
  reject: [0, 39.999]
};

function bandFor(total) {
  for (const [verdict, [lo, hi]] of Object.entries(VERDICT_BANDS)) {
    if (total >= lo && total <= hi) return verdict;
  }
  return 'reject';
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function normalizeScores(scores) {
  const out = {};
  for (const d of DIMENSIONS) {
    const raw = Number(scores?.[d]);
    out[d] = Number.isFinite(raw) ? clamp(raw, 0, 10) : 0;
  }
  return out;
}

function applyHardGates(scores, opts = {}) {
  const gates = [];
  const safety = scores.safety;
  if (safety <= 4) gates.push({ name: 'safety', forces: 'reject', reason: `safety score ${safety} below threshold` });
  if (opts.flagThirdParty) gates.push({ name: 'third_party', forces: 'reject', reason: 'identifiable third party without consent' });
  if (opts.flagMinor) gates.push({ name: 'minor', forces: 'reject', reason: 'minor in shot without explicit family/kids vertical context' });
  if (opts.flagNsfw) gates.push({ name: 'nsfw', forces: 'reject', reason: 'NSFW content for non-adult-vertical brand' });

  const minDim = opts.smallestDimensionPx;
  if (Number.isFinite(minDim) && minDim < 800) gates.push({ name: 'resolution', forces: 'regenerate_fresh', reason: `smallest side ${minDim}px below 800px floor — cannot enhance via I2I` });

  if (scores.brand_alignment <= 2) gates.push({ name: 'brand_alignment', forces: 'regenerate_fresh', reason: 'image actively contradicts brand DNA' });

  return gates;
}

function computeTotal(scores, weights) {
  let weightedSum = 0;
  let weightSum = 0;
  for (const d of DIMENSIONS) {
    const w = Number(weights[d]) || 1;
    weightedSum += scores[d] * w;
    weightSum += w;
  }
  return weightSum === 0 ? 0 : (weightedSum / weightSum) * 10;
}

const UGC_GENRES = new Set(['lifestyle_social', 'testimonial_ugc', 'founder_intro']);

function refineEnhanceVsRegenerate(verdict, scores, opts = {}) {
  if (verdict !== 'enhance_via_higgsfield' && verdict !== 'regenerate_fresh') return verdict;
  if (verdict === 'regenerate_fresh') {
    const subjectCorrect = opts.subjectCorrect === true;
    const resOK = !Number.isFinite(opts.smallestDimensionPx) || opts.smallestDimensionPx >= 800;
    if (
      subjectCorrect &&
      scores.brand_alignment >= 5 &&
      scores.safety >= 7 &&
      resOK
    ) {
      return 'enhance_via_higgsfield';
    }
  }
  if (verdict === 'enhance_via_higgsfield') {
    if (opts.subjectCorrect === false) return 'regenerate_fresh';
    if (scores.brand_alignment < 5) return 'regenerate_fresh';
    // Stock-photo feel cannot be enhanced into UGC realness — Soul I2I preserves
    // the subject's pose/expression/styling, which is the thing that codes "stock".
    if (opts.genre && UGC_GENRES.has(opts.genre) && scores.genuineness <= 3) {
      return 'regenerate_fresh';
    }
  }
  return verdict;
}

function decide(rawScores, genre, opts = {}) {
  const scores = normalizeScores(rawScores);
  const weights = weightsFor(genre);
  const gates = applyHardGates(scores, opts);

  if (gates.length) {
    const forced = gates[0].forces;
    return {
      verdict: forced,
      total_100: computeTotal(scores, weights),
      borderline: false,
      genre,
      scores,
      weights_applied: genre,
      hard_gates_fired: gates,
      rationale_lead: gates.map((g) => `[gate:${g.name}] ${g.reason}`).join(' | ')
    };
  }

  const total = computeTotal(scores, weights);
  let verdict = bandFor(total);
  verdict = refineEnhanceVsRegenerate(verdict, scores, { ...opts, genre });

  const distances = Object.entries(VERDICT_BANDS).map(([v, [lo, hi]]) => ({
    v,
    distance: Math.min(Math.abs(total - lo), Math.abs(total - hi))
  }));
  const minDist = Math.min(...distances.map((d) => d.distance));
  const borderline = minDist <= 3;

  return {
    verdict,
    total_100: Math.round(total * 10) / 10,
    borderline,
    genre,
    scores,
    weights_applied: genre,
    hard_gates_fired: []
  };
}

module.exports = { decide, bandFor, computeTotal, normalizeScores, applyHardGates, refineEnhanceVsRegenerate, VERDICT_BANDS, DIMENSIONS };
