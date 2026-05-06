'use strict';

/**
 * services/prompts/marketing-psychology/detector.js
 * ----------------------------------------------------------------------------
 * Deterministic detector — runs every principle's regex patterns over input
 * text and returns:
 *   - principles_applied (with verbatim evidence)
 *   - confidence_per_principle (0-10 based on pattern match strength)
 *
 * The LLM uses this as input — we tell it exactly which principles are
 * already present, so it doesn't have to discover them.
 * ----------------------------------------------------------------------------
 */

const { PRINCIPLES } = require('./principles');

/**
 * Detect which principles are already applied in given text.
 *
 * @param {string} text Marketing copy to analyze
 * @returns {{
 *   applied: Array<{id, name, evidence_quotes: string[], match_count: number}>,
 *   total_principles_present: number,
 *   coverage_pct: number
 * }}
 */
function detect(text) {
  if (!text || typeof text !== 'string') {
    return { applied: [], total_principles_present: 0, coverage_pct: 0 };
  }
  const applied = [];
  for (const p of PRINCIPLES) {
    if (!Array.isArray(p.detection_patterns) || !p.detection_patterns.length) continue;
    const evidence_quotes = [];
    let matchCount = 0;
    for (const pattern of p.detection_patterns) {
      const matches = text.match(pattern);
      if (matches) {
        evidence_quotes.push(matches[0]);
        matchCount++;
      }
    }
    if (matchCount > 0) {
      applied.push({
        id: p.id,
        name: p.name,
        family: p.family,
        evidence_quotes,
        match_count: matchCount,
      });
    }
  }
  // Coverage = principles applied / principles available (75)
  const total = PRINCIPLES.length;
  const coveragePct = Math.round((applied.length / total) * 100);
  return {
    applied,
    total_principles_present: applied.length,
    coverage_pct: coveragePct,
  };
}

/**
 * Detect "missing-but-fits" principles based on industry + funnel stage.
 * Returns top N principles that:
 *   1. Are NOT already applied
 *   2. Have high industry fit
 *   3. Match the funnel stage
 *   4. Have low manipulation risk for the context
 */
function suggestMissing({ text, industry, funnelStage, manipulationRiskCap = 7, limit = 5 }) {
  const detection = detect(text);
  const appliedIds = new Set(detection.applied.map(a => a.id));
  const indLower = String(industry || '').toLowerCase();
  const stage = String(funnelStage || 'consideration').toLowerCase();

  const candidates = [];
  for (const p of PRINCIPLES) {
    if (appliedIds.has(p.id)) continue;
    if (p.ethical_risk > manipulationRiskCap) continue;

    // Industry fit
    const highFit = (p.industries_high_fit || []).some(f =>
      indLower.includes(f) || f === 'all'
    );
    const lowFit = (p.industries_low_fit || []).some(f => indLower.includes(f));
    if (lowFit) continue;

    // Funnel stage match
    const stageMatches = !p.funnel_stages || p.funnel_stages.includes(stage);
    if (!stageMatches) continue;

    // Score: industry-fit boost + low risk boost
    let score = 50;
    if (highFit) score += 30;
    score -= p.ethical_risk * 2;
    if (p.family === 'attention') score += 5; // small attention bias for cold copy

    candidates.push({
      id: p.id,
      name: p.name,
      family: p.family,
      fit_reason: highFit ? `high fit for ${indLower}` : 'general fit',
      ethical_risk: p.ethical_risk,
      example_after: p.example_after,
      score,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}

/**
 * Detect MISAPPLIED principles — pattern fires BUT the context flags it
 * as inappropriate (e.g., dental clinic using scarcity).
 */
function detectMisapplied({ text, industry }) {
  const detection = detect(text);
  const indLower = String(industry || '').toLowerCase();
  const misapplied = [];
  for (const a of detection.applied) {
    const p = PRINCIPLES.find(x => x.id === a.id);
    if (!p) continue;
    // Industry low-fit = warn
    const lowFit = (p.industries_low_fit || []).some(f => indLower.includes(f));
    if (lowFit) {
      misapplied.push({
        id: p.id,
        name: p.name,
        evidence_quotes: a.evidence_quotes,
        reason: `${p.name} is high-risk for ${indLower} — patients/clients may feel manipulated`,
      });
    }
    // High-risk + first interaction
    if (p.ethical_risk >= 6) {
      misapplied.push({
        id: p.id,
        name: p.name,
        evidence_quotes: a.evidence_quotes,
        reason: `${p.name} has manipulation risk ${p.ethical_risk}/10; consider softer alternatives`,
        severity: 'soft',
      });
    }
  }
  return misapplied;
}

/**
 * Compute overall psychology score 0-100.
 */
function computeScore({ appliedCount, missingFitCount, misappliedCount, manipulationRisk }) {
  // Base: applied principles count, capped
  let score = Math.min(50, appliedCount * 5);
  // Bonus: low manipulation risk
  if (manipulationRisk === 'low') score += 25;
  else if (manipulationRisk === 'medium') score += 15;
  // Bonus: not too thin (5+ principles applied)
  if (appliedCount >= 5) score += 10;
  // Penalty: high misuse
  score -= misappliedCount * 8;
  // Bonus: covers high-fit gaps
  if (missingFitCount > 0 && missingFitCount <= 3) score += 15;
  return Math.max(0, Math.min(100, score));
}

module.exports = {
  detect,
  suggestMissing,
  detectMisapplied,
  computeScore,
};
