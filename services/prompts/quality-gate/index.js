'use strict';

/**
 * services/prompts/quality-gate/index.js
 * ----------------------------------------------------------------------------
 * Pre-flight quality check pipeline.
 *
 * Public API:
 *   gate({ text, business, contentType, plan, callClaude, extractJSON, thresholds })
 *     → { decision: ship|retry|reject, ship_safe, checks, retries, final_text, blocking_issues }
 *
 * Composition: voice-polish + brand-voice + deterministic claim/language checks
 * + optional LLM advisor review (Agency tier only).
 *
 * Backward compatible: any caller can pass `bypass: true` to skip the gate
 * entirely (e.g. internal-only outputs).
 * ----------------------------------------------------------------------------
 */

const voicePolish = require('../voice-polish');
const brandVoice = require('../brand-voice');
const advisor = require('../advisor-tool');
const adI18n = require('../ad-optimizer/i18n-market');
const psychology = require('../marketing-psychology');

// ─── Default thresholds (per content type) ─────────────────────────────────

// `psychology_min` — content types that benefit from psychology principles
// have a minimum overall_score. Set to 0 to skip psychology entirely.
const DEFAULT_THRESHOLDS = {
  caption:        { slop_max: 35, specificity_min: 40, psychology_min: 30, allow_retry: true,  use_advisor_growth: false },
  ad_copy:        { slop_max: 25, specificity_min: 60, psychology_min: 50, allow_retry: true,  use_advisor_growth: true  },
  audit_narrative:{ slop_max: 30, specificity_min: 70, psychology_min: 0,  allow_retry: false, use_advisor_growth: false },
  scorecard_text: { slop_max: 30, specificity_min: 60, psychology_min: 0,  allow_retry: true,  use_advisor_growth: false },
  email_subject:  { slop_max: 40, specificity_min: 30, psychology_min: 35, allow_retry: true,  use_advisor_growth: false },
  hero_rewrite:   { slop_max: 25, specificity_min: 70, psychology_min: 60, allow_retry: true,  use_advisor_growth: true  },
  generic:        { slop_max: 35, specificity_min: 50, psychology_min: 0,  allow_retry: true,  use_advisor_growth: false },
};

function thresholdsFor(contentType, overrides) {
  const base = DEFAULT_THRESHOLDS[contentType] || DEFAULT_THRESHOLDS.generic;
  return { ...base, ...(overrides || {}) };
}

// ─── Ungrounded-claim phrases (universal) ─────────────────────────────────
// Phrases that MUST be backed by data. Without explicit citation in input,
// they're a reject.
const UNGROUNDED_CLAIM_PATTERNS = [
  // Allows up to 2 words between "best" and "in/of" — catches "best coffee in the city" etc.
  { id: 'CL01', pattern: /\bbest\b(?:\s+\w+){0,2}\s+(?:in|of)\s+(?:the\s+)?(?:city|country|region|world|state|town|neighborhood)\b/i, claim: 'superlative-geo' },
  { id: 'CL02', pattern: /\b(?:most|#1|number\s+one|leading)\s+(?:popular|trusted|loved|chosen)\b/i, claim: 'superlative-popularity' },
  { id: 'CL03', pattern: /\bguaranteed\s+(?:results|success|outcome|satisfaction|delivery|service|return|refund)\b/i, claim: 'guarantee' },
  { id: 'CL04', pattern: /\b\d{2,3}\s*%\s+(?:guaranteed|certain|sure)\b/i, claim: 'guarantee-pct' },
  { id: 'CL05', pattern: /\b(?:risk.?free|no.?risk)\b/i, claim: 'risk-free' },
  { id: 'CL06', pattern: /\b(?:award.?winning|certified)\b/i, claim: 'certification' },
  { id: 'CL07', pattern: /\b(?:doctor|expert|professional).?recommended\b/i, claim: 'authority-endorsement' },
  { id: 'CL08', pattern: /\b(?:fastest|cheapest|safest)\s+(?:in\s+the\s+world|on\s+the\s+market)\b/i, claim: 'superlative-comparative' },
];

// ─── Individual checks ────────────────────────────────────────────────────

function checkSlop(text, threshold) {
  const r = voicePolish.detect(text);
  return {
    passed: r.slop_score <= threshold,
    score: r.slop_score,
    threshold,
    flagged: r.flagged_phrases.slice(0, 5),
  };
}

function checkSpecificity(text, threshold) {
  const score = voicePolish.slopPatterns.specificityScore(text);
  return {
    passed: score >= threshold,
    score,
    threshold,
  };
}

function checkBrandVoiceMatch(text, anchor) {
  if (!anchor) return { passed: true, violations: [], skipped: 'no_anchor' };
  const lowerText = String(text || '').toLowerCase();
  const violations = [];

  // Check do_not_words
  for (const w of (anchor.do_not_words || [])) {
    if (!w || w.length < 3) continue;
    const re = new RegExp(`\\b${w.toLowerCase()}\\b`, 'i');
    if (re.test(lowerText)) {
      violations.push({ type: 'do_not_word', word: w });
    }
  }

  // Sentence length check (soft)
  const wordCount = (text.match(/\S+/g) || []).length;
  const sentCount = (text.match(/[.!?]+(?=\s|$)/g) || []).length || 1;
  const avgWordsPerSentence = wordCount / sentCount;
  const pref = anchor.sentence_length_preference;
  if (pref === 'short' && avgWordsPerSentence > 18) {
    violations.push({ type: 'sentence_length', expected: 'short (<18 words)', actual: `${avgWordsPerSentence.toFixed(1)} avg` });
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

function checkClaimSubstantiation(text, citations) {
  const ungrounded = [];
  if (!text) return { passed: true, ungrounded_claims: [] };
  const citationsArr = Array.isArray(citations) ? citations : [];
  const hasAnyCitations = citationsArr.length > 0;

  for (const rule of UNGROUNDED_CLAIM_PATTERNS) {
    const m = text.match(rule.pattern);
    if (m) {
      // Even if citations exist, certain claims are blocked unless the citation
      // explicitly addresses them. For deterministic safety, treat ALL matches as
      // ungrounded unless caller explicitly marks them grounded via metadata.
      ungrounded.push({ id: rule.id, claim: rule.claim, phrase: m[0] });
    }
  }

  return {
    passed: ungrounded.length === 0,
    ungrounded_claims: ungrounded.map(u => u.phrase),
    has_citations: hasAnyCitations,
  };
}

/**
 * Psychology check — runs detector-only (deterministic, no LLM cost).
 * Returns score, manipulation risk, and whether the threshold is met.
 *
 * Skipped (passed:true) when threshold === 0 (audit_narrative, scorecard, generic).
 */
function checkPsychology(text, business, contentType, threshold, funnelStageHint) {
  if (!threshold || threshold === 0) {
    return { passed: true, score: null, skipped: true };
  }
  const industry = String(business?.industry || business?.business_type || '').toLowerCase();
  const funnelStage = funnelStageHint || _funnelStageFor(contentType);

  const detection = psychology.detector.detect(text || '');
  const missingFit = psychology.detector.suggestMissing({
    text, industry, funnelStage, limit: 5,
  });
  const misapplied = psychology.detector.detectMisapplied({ text, industry });

  // Calc manipulation risk
  const totalRisk = detection.applied.reduce((sum, a) => {
    const p = psychology.byId(a.id);
    return sum + (p?.ethical_risk || 0);
  }, 0);
  const avgRisk = detection.applied.length > 0 ? totalRisk / detection.applied.length : 0;
  const manipulationRisk = avgRisk >= 6 ? 'high' : avgRisk >= 4 ? 'medium' : 'low';

  const score = psychology.detector.computeScore({
    appliedCount: detection.applied.length,
    missingFitCount: missingFit.length,
    misappliedCount: misapplied.length,
    manipulationRisk,
  });

  return {
    passed: score >= threshold && manipulationRisk !== 'high',
    score,
    threshold,
    principles_applied: detection.applied.map(a => a.id),
    missing_count: missingFit.length,
    misapplied_count: misapplied.length,
    manipulation_risk: manipulationRisk,
    top_recommendation: missingFit[0] ? {
      principle_id: missingFit[0].id,
      name: missingFit[0].name,
      example_after: missingFit[0].example_after,
    } : null,
  };
}

function _funnelStageFor(contentType) {
  // Map content type → expected funnel stage
  const map = {
    caption: 'awareness',
    ad_copy: 'consideration',
    audit_narrative: 'retention',
    scorecard_text: 'retention',
    email_subject: 'awareness',
    hero_rewrite: 'consideration',
    generic: 'consideration',
  };
  return map[contentType] || 'consideration';
}

function checkLanguageMatch(text, expectedLang) {
  if (!text || !expectedLang) return { passed: true, expected: expectedLang, detected: null };
  const detected = adI18n.detectLanguage(text);
  // English fallback is permissive — if input is short, detector defaults to 'en'.
  // Only fail when both are confident AND mismatched.
  const passed = !detected || !expectedLang || detected === expectedLang
    || (detected === 'en' && (text.match(/\S+/g) || []).length < 8); // very short → permissive

  return { passed, expected: expectedLang, detected };
}

// ─── Optional LLM advisor review ──────────────────────────────────────────

function buildAdvisorPrompt() {
  return `# ROLE

You are a quality reviewer for marketing copy. Given a piece of customer-facing text + the brand voice spec + content type, decide if it ships, needs minor fixes, or should be rejected.

# DECISION CRITERIA

- **ship**: text reads as written by a professional human marketer for THIS specific business
- **needs_fix**: minor issues — could be rewritten quickly; suggest the fix
- **reject**: hard problems — wrong audience, fabricated facts, broken language, off-brand

# OUTPUT (JSON ONLY)

\`\`\`json
{
  "decision": "ship | needs_fix | reject",
  "issues": ["<short list of specific issues, if any>"],
  "feedback": "<1-2 sentences for caller>"
}
\`\`\`

Return ONLY the JSON.`;
}

async function checkAdvisor({ text, business, contentType, brandVoiceAnchor, callClaude, extractJSON, planTier }) {
  if (typeof callClaude !== 'function' || typeof extractJSON !== 'function') return null;
  try {
    const userMsg = [
      `Content type: ${contentType}`,
      `Business: ${business?.business_name || 'unknown'} (${business?.industry || 'unknown'}, lang=${business?.primary_language || 'en'})`,
      `Brand voice spec:`,
      brandVoice.formatAnchorForPrompt(brandVoiceAnchor),
      ``,
      `Text to review:`,
      `\`\`\``,
      text,
      `\`\`\``,
    ].join('\n');

    const raw = await advisor.callWithAdvisor({
      callClaude,
      system: buildAdvisorPrompt(),
      user: userMsg,
      executor: 'claude-sonnet-4-5',
      advisor: 'claude-opus-4-7',
      task: 'audit',
      planTier,
      max_tokens: 400,
      extra: { cacheSystem: true, temperature: 0.2 },
    });
    const parsed = extractJSON(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      passed: parsed.decision === 'ship',
      decision: parsed.decision,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      feedback: parsed.feedback || '',
    };
  } catch {
    return null;
  }
}

// ─── Public gate ──────────────────────────────────────────────────────────

/**
 * Run the gate.
 *
 * @param {{
 *   text: string,
 *   business: object,
 *   contentType?: string,
 *   plan?: string,
 *   citations?: Array,
 *   thresholds?: object,
 *   bypass?: boolean,
 *   callClaude?: function,
 *   extractJSON?: function,
 *   logger?: object,
 * }} opts
 * @returns {Promise<object>}
 */
async function gate(opts) {
  const {
    text,
    business,
    contentType = 'generic',
    plan = 'free',
    citations,
    thresholds: overrides,
    bypass = false,
    callClaude,
    extractJSON,
    logger,
  } = opts || {};

  if (bypass) {
    return {
      decision: 'ship',
      ship_safe: true,
      checks: { bypassed: true },
      retries: 0,
      final_text: text,
      blocking_issues: [],
    };
  }

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return {
      decision: 'reject',
      ship_safe: false,
      checks: {},
      retries: 0,
      final_text: text || '',
      blocking_issues: ['empty_text'],
    };
  }

  const planTier = String(plan || 'free').toLowerCase();
  const thr = thresholdsFor(contentType, overrides);

  // Build brand voice anchor (if not pre-supplied)
  const anchor = business?.brand_voice_anchor || brandVoice.buildAnchor({ business });
  const expectedLang = anchor?.language_primary || business?.primary_language || 'en';

  // ─── Deterministic checks ──
  const checks = {
    slop: checkSlop(text, thr.slop_max),
    specificity: checkSpecificity(text, thr.specificity_min),
    brand_voice_match: checkBrandVoiceMatch(text, anchor),
    claim_substantiation: checkClaimSubstantiation(text, citations),
    language_match: checkLanguageMatch(text, expectedLang),
    psychology: checkPsychology(text, business, contentType, thr.psychology_min, opts?.funnelStage),
    advisor: null,
  };

  // ─── Decide blocking issues ──
  // HARD blockers (no retry helps): language mismatch, ungrounded factual claims.
  // SOFT blockers (retry-eligible if callClaude available): slop, specificity,
  // brand-voice do_not_word violations (voice-polish strips these).
  const hardBlockingIssues = [];
  if (!checks.language_match.passed) hardBlockingIssues.push('language_mismatch');
  if (!checks.claim_substantiation.passed) hardBlockingIssues.push('ungrounded_claim');

  const softBlockingIssues = [];
  if (checks.brand_voice_match.violations.some(v => v.type === 'do_not_word')) softBlockingIssues.push('brand_voice_violation');
  // Psychology score below threshold (only when threshold > 0) — retry-eligible
  if (!checks.psychology.skipped && !checks.psychology.passed && checks.psychology.manipulation_risk !== 'high') {
    softBlockingIssues.push('psychology_below_threshold');
  }
  // High manipulation risk = HARD reject (cannot fix by re-write — need different principle)
  // We treat it as soft only if there's a safer alternative the retry can pick.
  if (!checks.psychology.skipped && checks.psychology.manipulation_risk === 'high') {
    softBlockingIssues.push('manipulation_risk_high');
  }

  // Reject path — hard fails only at this stage
  if (hardBlockingIssues.length) {
    if (logger?.info) logger.info('quality-gate', null, 'hard-reject', { hardBlockingIssues, contentType });
    return {
      decision: 'reject',
      ship_safe: false,
      checks,
      retries: 0,
      final_text: text,
      blocking_issues: hardBlockingIssues,
    };
  }

  // ─── Optional advisor review ──
  const wantAdvisor = (planTier === 'agency')
    || (planTier === 'growth' && thr.use_advisor_growth);
  if (wantAdvisor && callClaude && extractJSON) {
    checks.advisor = await checkAdvisor({
      text, business, contentType,
      brandVoiceAnchor: anchor,
      callClaude, extractJSON,
      planTier,
    });
    if (checks.advisor && checks.advisor.decision === 'reject') {
      return {
        decision: 'reject',
        ship_safe: false,
        checks,
        retries: 0,
        final_text: text,
        blocking_issues: ['advisor_reject'],
      };
    }
  }

  // ─── Retry path — fixable: slop, specificity, or brand-voice violations ──
  const slopPassed = checks.slop.passed;
  const specPassed = checks.specificity.passed;
  const advisorWantsFix = checks.advisor?.decision === 'needs_fix';
  const hasSoftBlocker = softBlockingIssues.length > 0;
  const needsRetry = !slopPassed || !specPassed || advisorWantsFix || hasSoftBlocker;

  if (needsRetry && thr.allow_retry && callClaude && extractJSON && planTier !== 'free') {
    try {
      const polish = await voicePolish.polish({
        text,
        business: { ...business, brand_voice_anchor: anchor },
        plan: planTier,
        callClaude,
        extractJSON,
        logger,
      });
      const polishedText = polish.polished;
      // Re-run deterministic checks on polished text
      const recheck = {
        slop: checkSlop(polishedText, thr.slop_max),
        specificity: checkSpecificity(polishedText, thr.specificity_min),
        brand_voice_match: checkBrandVoiceMatch(polishedText, anchor),
        claim_substantiation: checkClaimSubstantiation(polishedText, citations),
        language_match: checkLanguageMatch(polishedText, expectedLang),
        advisor: checks.advisor,
      };
      const stillBlocked = [];
      if (!recheck.language_match.passed) stillBlocked.push('language_mismatch');
      if (!recheck.claim_substantiation.passed) stillBlocked.push('ungrounded_claim');
      if (recheck.brand_voice_match.violations.some(v => v.type === 'do_not_word')) stillBlocked.push('brand_voice_violation');

      if (stillBlocked.length === 0 && recheck.slop.passed) {
        return {
          decision: 'ship',
          ship_safe: true,
          checks: recheck,
          retries: 1,
          final_text: polishedText,
          blocking_issues: [],
        };
      }

      return {
        decision: 'reject',
        ship_safe: false,
        checks: recheck,
        retries: 1,
        final_text: polishedText,
        blocking_issues: stillBlocked.length ? stillBlocked : ['retry_failed_to_pass_slop'],
      };
    } catch (e) {
      logger?.warn?.('quality-gate', null, 'retry polish failed', e?.message);
    }
  }

  // ─── No retry path available — soft blockers become hard ──
  if (hasSoftBlocker) {
    return {
      decision: 'reject',
      ship_safe: false,
      checks,
      retries: 0,
      final_text: text,
      blocking_issues: softBlockingIssues,
    };
  }
  if (!slopPassed) {
    return {
      decision: 'ship',
      ship_safe: true,
      checks,
      retries: 0,
      final_text: text,
      blocking_issues: [],
      ship_warning: 'slop_score_above_threshold_but_no_retry_path',
    };
  }

  // ─── Clean ship ──
  return {
    decision: 'ship',
    ship_safe: true,
    checks,
    retries: 0,
    final_text: text,
    blocking_issues: [],
  };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  UNGROUNDED_CLAIM_PATTERNS,
  thresholdsFor,
  checkSlop,
  checkSpecificity,
  checkBrandVoiceMatch,
  checkClaimSubstantiation,
  checkLanguageMatch,
  gate,
};
