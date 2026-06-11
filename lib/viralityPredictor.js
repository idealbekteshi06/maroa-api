'use strict';

/**
 * lib/viralityPredictor.js
 * ---------------------------------------------------------------------------
 * Internal, Claude-based virality predictor.
 *
 * Scores a generated piece of content (hook + caption + platform) for its
 * predicted organic performance and returns a normalized prediction that
 * callers persist into the `content_performance` table (migration 087).
 *
 * IMPORTANT — this is an INTERNAL scorer built on `callClaude`, consistent
 * with the rest of the content scoring stack (quality scorer, n-best
 * reranker, adversarial critic). It is NOT the Higgsfield first-party
 * virality API. If/when Higgsfield ships a hosted predictor, this can be
 * swapped behind the same `predictVirality()` interface or ensembled with
 * it — callers don't change.
 *
 * Output shape (all fields always present, even on failure):
 *   {
 *     virality_score:       0..100      (integer)
 *     predicted_engagement: 'low'|'medium'|'high'
 *     hook_strength:        'weak'|'moderate'|'strong'
 *     retention_risk:       'low'|'medium'|'high'
 *     rationale:            string (<= 280 chars)
 *     raw:                  the parsed model JSON (or null on failure)
 *   }
 * ---------------------------------------------------------------------------
 */

const ENGAGEMENT_LEVELS = new Set(['low', 'medium', 'high']);
const HOOK_LEVELS = new Set(['weak', 'moderate', 'strong']);
const RISK_LEVELS = new Set(['low', 'medium', 'high']);

// Neutral fallback — used when the model is unavailable or returns garbage.
// A mid-band score so a scoring miss never blocks publish nor over-promotes.
const NEUTRAL = Object.freeze({
  virality_score: 50,
  predicted_engagement: 'medium',
  hook_strength: 'moderate',
  retention_risk: 'medium',
  rationale: 'virality prediction unavailable — defaulted to neutral band',
  raw: null,
});

function clampScore(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return NEUTRAL.virality_score;
  return Math.max(0, Math.min(100, v));
}

function coerceEnum(value, allowed, fallback) {
  const v = String(value || '')
    .toLowerCase()
    .trim();
  return allowed.has(v) ? v : fallback;
}

function buildViralityPrompt(content = {}) {
  const platform = content.platform || 'social';
  const hook = content.hook || '';
  const caption = content.caption || '';
  const format = content.format || content.asset_type || 'post';
  const hasMedia = content.media_url ? 'yes' : 'no';

  return [
    'You are a social-media virality analyst. Predict the ORGANIC performance',
    `of this ${platform} ${format} for a small business. Be calibrated and`,
    'skeptical — most content is average. Reserve high scores for genuinely',
    'scroll-stopping, shareable work.',
    '',
    `HOOK: ${JSON.stringify(hook)}`,
    `CAPTION: ${JSON.stringify(caption.slice(0, 1200))}`,
    `HAS_VISUAL: ${hasMedia}`,
    '',
    'Score these dimensions and output JSON ONLY (no prose):',
    '{',
    '  "virality_score": 0-100,            // overall organic virality potential',
    '  "predicted_engagement": "low"|"medium"|"high",',
    '  "hook_strength": "weak"|"moderate"|"strong",',
    '  "retention_risk": "low"|"medium"|"high",  // risk the audience scrolls past / drops off',
    '  "rationale": "one sentence, <= 280 chars"',
    '}',
  ].join('\n');
}

/**
 * Predict virality for a single piece of content.
 * @param {object} args
 * @param {object} args.content  { platform, hook, caption, media_url?, format? }
 * @param {object} args.deps     { callClaude, extractJSON, logger? }
 * @param {string} [args.businessId]
 * @param {string} [args.model]  defaults to haiku (cheap classify)
 * @returns {Promise<object>} normalized prediction (never throws)
 */
async function predictVirality({ content, deps, businessId, model = 'claude-haiku-4-5' }) {
  const { callClaude, extractJSON, logger } = deps || {};
  if (typeof callClaude !== 'function' || typeof extractJSON !== 'function') {
    return { ...NEUTRAL };
  }

  try {
    const prompt = buildViralityPrompt(content);
    const raw = await callClaude(prompt, model, 400, { businessId, returnRaw: true, skipBudget: false });
    const parsed = extractJSON(raw);
    if (!parsed || typeof parsed !== 'object') return { ...NEUTRAL };

    return {
      virality_score: clampScore(parsed.virality_score),
      predicted_engagement: coerceEnum(parsed.predicted_engagement, ENGAGEMENT_LEVELS, 'medium'),
      hook_strength: coerceEnum(parsed.hook_strength, HOOK_LEVELS, 'moderate'),
      retention_risk: coerceEnum(parsed.retention_risk, RISK_LEVELS, 'medium'),
      rationale: String(parsed.rationale || '').slice(0, 280),
      raw: parsed,
    };
  } catch (e) {
    logger?.warn?.('viralityPredictor', businessId, 'prediction failed — defaulting to neutral', {
      error: e.message,
    });
    return { ...NEUTRAL };
  }
}

module.exports = { predictVirality, buildViralityPrompt, NEUTRAL };
