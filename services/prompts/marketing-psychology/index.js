'use strict';

/**
 * services/prompts/marketing-psychology/index.js
 * ----------------------------------------------------------------------------
 * Public entry — audit() + apply()
 *
 * audit({ text, business, funnelStage, callClaude, extractJSON })
 *   → score + applied + missing + misapplied + recommendations
 *
 * apply({ text, business, principleId, callClaude, extractJSON })
 *   → rewritten text with selected principle baked in
 *
 * Used by:
 *   - creative-director (apply on every concept's copy)
 *   - ad-optimizer (audit + suggest principles for ad copy)
 *   - cro (apply on hero/CTA rewrites)
 *   - voice-polish (additional check pass)
 *   - quality-gate (psychology score input to ship/retry decision)
 * ----------------------------------------------------------------------------
 */

const { PRINCIPLES, byId } = require('./principles');
const detector = require('./detector');
const advisor = require('../advisor-tool');
const adI18n = require('../ad-optimizer/i18n-market');

// ─── System prompts ─────────────────────────────────────────────────────────

function buildAuditSystemPrompt() {
  return `# ROLE

You are Maroa's marketing-psychology auditor. Given a piece of marketing copy, deterministic detection results, and the business context, you produce an audit that:
1. Confirms which principles are well-applied
2. Identifies the highest-leverage missing principles
3. Flags any manipulative use (especially in regulated industries)
4. Recommends top 3 actions

# AUDIENCE

Small-business owner. Reads in 30 seconds. Trusts you because you cite verbatim evidence from THEIR copy.

# HARD RULES

## 1. Quote evidence, never invent
Every "applied" claim must include a verbatim quote FROM the input. Every "missing" claim must reference a principle FROM the deterministic input list.

## 2. Industry awareness
- Health/medical/legal: cap recommendations at low manipulation risk (≤4). Never suggest scarcity/urgency.
- B2C consumer: full toolkit available
- B2B SaaS: prefer specificity + authority + concrete > scarcity

## 3. Funnel awareness
- Awareness: curiosity, surprise, pattern interruption
- Consideration: social proof, authority, specificity
- Decision: scarcity, anchoring, risk reversal
- Retention: reciprocity, achievement, peak-end

## 4. Honest scoring
- 90+: 8+ principles applied, low risk, well-matched to industry
- 70-89: 5-7 principles, well-applied, minor gaps
- 50-69: 2-4 principles, decent but missing top-3 fit
- <50: thin or off-brand

## 5. Brief
narrative ≤ 5 sentences. ≤3 top recommendations.

# OUTPUT (JSON ONLY)

\`\`\`json
{
  "overall_score": 0-100,
  "applied_summary": "<1-2 sentences naming top 2-3 principles applied>",
  "principles_applied": [
    {"id": "P003", "name": "Social Proof", "evidence_quote": "..."}
  ],
  "principles_missing_but_fit": [
    {"id": "P008", "name": "Anchoring", "fit_reason": "...", "expected_lift": "high|medium|low"}
  ],
  "principles_misapplied": [
    {"id": "P006", "name": "Scarcity", "reason": "..."}
  ],
  "manipulation_risk": "low | medium | high",
  "industry_fit": "well-fit | over-using | under-using",
  "top_recommendations": [
    {"principle_id": "P008", "why": "<reason>", "preview_after": "<rewritten example>"}
  ]
}
\`\`\`

Return ONLY the JSON.`;
}

function buildApplySystemPrompt() {
  return `# ROLE

You are Maroa's marketing-psychology copywriter. Given marketing copy and a chosen principle, you rewrite the copy so the principle is BAKED IN — without inventing any new facts.

# HARD RULES

## 1. Preserve every concrete fact
Numbers, dates, prices, hours, locations, product names, business name — keep exactly. The principle shapes phrasing, not truth.

## 2. Same language as input
If input is Albanian, output is Albanian. NEVER translate.

## 3. Same length or 5-15% shorter
Don't pad. The principle should make copy MORE concise, not bloated.

## 4. No buzzwords
Same as voice-polish: no "leverage", "world-class", "elevate", "synergy", "in today's...".

## 5. Stay within manipulation cap
If the chosen principle has high manipulation risk AND the industry is health/medical, REFUSE the rewrite and return:
\`\`\`json
{ "refused": true, "reason": "<short>", "alternative_principle_id": "<safer one>" }
\`\`\`

## 6. The principle should be obvious in the rewrite
A reader should be able to identify the psychology used. Don't be subtle — be effective.

# OUTPUT (JSON ONLY)

\`\`\`json
{
  "rewritten": "<text with principle baked in>",
  "applied_principle": {"id": "P003", "name": "Social Proof"},
  "changes_made": ["<short list>"],
  "language_preserved": true,
  "facts_preserved": true
}
\`\`\`

OR if refused:

\`\`\`json
{
  "refused": true,
  "reason": "<short>",
  "alternative_principle_id": "<safer one>"
}
\`\`\`

Return ONLY the JSON.`;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Audit copy for psychology principle application.
 */
async function audit(opts) {
  const {
    text,
    business,
    funnelStage = 'consideration',
    plan = 'free',
    callClaude,
    extractJSON,
    logger,
  } = opts || {};

  if (!text || typeof text !== 'string') {
    return { skipped: true, reason: 'empty_input' };
  }

  const planTier = String(plan || 'free').toLowerCase();
  const industry = String(business?.industry || business?.business_type || '').toLowerCase();
  const market = adI18n.buildMarketProfile(business);

  // ─── Deterministic pre-pass ────────────────────────────────────────────
  const detection = detector.detect(text);
  const missingFit = detector.suggestMissing({ text, industry, funnelStage, limit: 5 });
  const misapplied = detector.detectMisapplied({ text, industry });

  // Compute manipulation-risk band
  const totalRisk = detection.applied.reduce((sum, a) => {
    const p = byId(a.id);
    return sum + (p?.ethical_risk || 0);
  }, 0);
  const avgRisk = detection.applied.length > 0 ? totalRisk / detection.applied.length : 0;
  const manipulationRisk = avgRisk >= 6 ? 'high' : avgRisk >= 4 ? 'medium' : 'low';

  // Free tier: deterministic-only audit (no LLM)
  if (planTier === 'free') {
    const score = detector.computeScore({
      appliedCount: detection.applied.length,
      missingFitCount: missingFit.length,
      misappliedCount: misapplied.length,
      manipulationRisk,
    });
    return {
      overall_score: score,
      applied_summary: detection.applied.slice(0, 3).map(a => a.name).join(', ') || 'none detected',
      principles_applied: detection.applied.map(a => ({
        id: a.id,
        name: a.name,
        evidence_quote: a.evidence_quotes[0] || '',
      })),
      principles_missing_but_fit: missingFit.map(m => ({
        id: m.id,
        name: m.name,
        fit_reason: m.fit_reason,
        expected_lift: 'medium',
      })),
      principles_misapplied: misapplied,
      manipulation_risk: manipulationRisk,
      industry_fit: detection.applied.length >= 3 ? 'well-fit' : 'under-using',
      top_recommendations: missingFit.slice(0, 3).map(m => ({
        principle_id: m.id,
        why: m.fit_reason,
        preview_after: m.example_after,
      })),
      llm_used: false,
      data_quality: 'deterministic_only',
    };
  }

  // ─── LLM synthesis (Growth+) ──
  const userMsg = [
    '# AUDIT REQUEST',
    '',
    '## Input copy',
    '```',
    text,
    '```',
    '',
    '## Business context',
    '```json',
    JSON.stringify({
      industry,
      audience: business?.audience_description,
      primary_language: market.primary_language,
      funnel_stage: funnelStage,
    }, null, 2),
    '```',
    '',
    '## Deterministic detection results (use these, don\'t re-discover)',
    '```json',
    JSON.stringify({
      applied: detection.applied,
      missing_but_fit: missingFit,
      misapplied,
      manipulation_risk: manipulationRisk,
    }, null, 2),
    '```',
    '',
    `Produce the audit JSON in language="${market.primary_language || 'en'}". Return ONLY the JSON.`,
  ].join('\n');

  let raw;
  try {
    raw = await advisor.callWithAdvisor({
      callClaude,
      system: buildAuditSystemPrompt(),
      user: userMsg,
      executor: 'claude-sonnet-4-5',
      advisor: 'claude-opus-4-7',
      task: 'audit',
      planTier,
      max_tokens: 1500,
      extra: { cacheSystem: true, temperature: 0.2 },
    });
  } catch (e) {
    logger?.warn?.('marketing-psychology', null, 'LLM audit failed', e?.message);
    return _deterministicFallback(detection, missingFit, misapplied, manipulationRisk);
  }

  let parsed;
  try { parsed = extractJSON(raw); } catch { parsed = null; }
  if (!parsed) return _deterministicFallback(detection, missingFit, misapplied, manipulationRisk);

  return {
    ...parsed,
    deterministic_detection: {
      applied: detection.applied,
      missing_fit: missingFit,
      misapplied,
    },
    llm_used: true,
    data_quality: 'good',
  };
}

/**
 * Apply a chosen principle to rewrite copy.
 */
async function apply(opts) {
  const {
    text,
    business,
    principleId, // 'auto' or specific 'P003'
    plan = 'free',
    funnelStage = 'consideration',
    callClaude,
    extractJSON,
    logger,
  } = opts || {};

  if (!text || typeof text !== 'string') {
    return { rewritten: text, refused: true, reason: 'empty_input' };
  }
  if (typeof callClaude !== 'function' || typeof extractJSON !== 'function') {
    throw new Error('apply: callClaude + extractJSON required');
  }

  const planTier = String(plan || 'free').toLowerCase();
  if (planTier === 'free') {
    return { rewritten: text, refused: true, reason: 'free_tier_skip' };
  }

  const industry = String(business?.industry || business?.business_type || '').toLowerCase();
  const market = adI18n.buildMarketProfile(business);

  // Resolve principle
  let chosenPrinciple;
  if (principleId === 'auto' || !principleId) {
    const candidates = detector.suggestMissing({ text, industry, funnelStage, limit: 1 });
    chosenPrinciple = candidates[0] ? byId(candidates[0].id) : null;
  } else {
    chosenPrinciple = byId(principleId);
  }
  if (!chosenPrinciple) {
    return { rewritten: text, refused: true, reason: 'principle_not_found' };
  }

  // Refuse if high-risk + restricted industry
  const restrictedIndustry = (chosenPrinciple.industries_low_fit || []).some(f => industry.includes(f));
  if (chosenPrinciple.ethical_risk >= 6 && restrictedIndustry) {
    const safeAlt = detector.suggestMissing({ text, industry, funnelStage, manipulationRiskCap: 4, limit: 1 });
    return {
      rewritten: text,
      refused: true,
      reason: `${chosenPrinciple.name} too high-risk for ${industry}`,
      alternative_principle_id: safeAlt[0]?.id,
    };
  }

  const userMsg = [
    '# REWRITE REQUEST',
    '',
    '## Input copy',
    '```',
    text,
    '```',
    '',
    '## Business context',
    '```json',
    JSON.stringify({
      industry,
      audience: business?.audience_description,
      primary_language: market.primary_language,
      funnel_stage: funnelStage,
    }, null, 2),
    '```',
    '',
    '## Principle to apply',
    '```json',
    JSON.stringify({
      id: chosenPrinciple.id,
      name: chosenPrinciple.name,
      family: chosenPrinciple.family,
      short_description: chosenPrinciple.short_description,
      ethical_risk: chosenPrinciple.ethical_risk,
      example_before: chosenPrinciple.example_before,
      example_after: chosenPrinciple.example_after,
    }, null, 2),
    '```',
    '',
    `Rewrite in language="${market.primary_language || 'en'}". Preserve every concrete fact. Return ONLY JSON.`,
  ].join('\n');

  let raw;
  try {
    raw = await advisor.callWithAdvisor({
      callClaude,
      system: buildApplySystemPrompt(),
      user: userMsg,
      executor: 'claude-sonnet-4-5',
      advisor: 'claude-opus-4-7',
      task: 'rewrite',
      planTier,
      max_tokens: Math.max(400, Math.min(2000, text.length * 2)),
      extra: { cacheSystem: true, temperature: 0.4 },
    });
  } catch (e) {
    logger?.warn?.('marketing-psychology', null, 'LLM apply failed', e?.message);
    return { rewritten: text, refused: true, reason: 'llm_unavailable' };
  }

  let parsed;
  try { parsed = extractJSON(raw); } catch { parsed = null; }
  if (!parsed) return { rewritten: text, refused: true, reason: 'parse_failed' };

  if (parsed.refused) {
    return { rewritten: text, refused: true, ...parsed };
  }

  if (!parsed.rewritten || typeof parsed.rewritten !== 'string') {
    return { rewritten: text, refused: true, reason: 'no_rewrite_returned' };
  }

  return {
    rewritten: parsed.rewritten,
    applied_principle: {
      id: chosenPrinciple.id,
      name: chosenPrinciple.name,
    },
    changes_made: Array.isArray(parsed.changes_made) ? parsed.changes_made : [],
    language_preserved: parsed.language_preserved !== false,
    facts_preserved: parsed.facts_preserved !== false,
    confidence: 'medium',
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────

function _deterministicFallback(detection, missingFit, misapplied, manipulationRisk) {
  const score = detector.computeScore({
    appliedCount: detection.applied.length,
    missingFitCount: missingFit.length,
    misappliedCount: misapplied.length,
    manipulationRisk,
  });
  return {
    overall_score: score,
    applied_summary: detection.applied.slice(0, 3).map(a => a.name).join(', ') || 'none detected',
    principles_applied: detection.applied.map(a => ({
      id: a.id, name: a.name, evidence_quote: a.evidence_quotes[0] || '',
    })),
    principles_missing_but_fit: missingFit.map(m => ({
      id: m.id, name: m.name, fit_reason: m.fit_reason, expected_lift: 'medium',
    })),
    principles_misapplied: misapplied,
    manipulation_risk: manipulationRisk,
    industry_fit: detection.applied.length >= 3 ? 'well-fit' : 'under-using',
    top_recommendations: missingFit.slice(0, 3).map(m => ({
      principle_id: m.id, why: m.fit_reason, preview_after: m.example_after,
    })),
    llm_used: false,
    data_quality: 'deterministic_fallback',
  };
}

module.exports = {
  audit,
  apply,
  detector,
  PRINCIPLES,
  byId,
  buildAuditSystemPrompt,
  buildApplySystemPrompt,
};
