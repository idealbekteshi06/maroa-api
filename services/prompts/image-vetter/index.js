'use strict';

const decisionLogic = require('./decision');
const systemPrompt = require('./system-prompt');
const enhanceBrief = require('./enhance-brief');
const weights = require('./weights');
const { classifyGenre } = require('../higgsfield/genre-router');

/**
 * Combine raw scores from a Claude vision call with the genre-aware decision logic.
 * Returns the full verdict object including the I2I enhance brief when applicable.
 */
function synthesizeVerdict(input) {
  const { rawVetterOutput, brandDNA, contentTheme } = input || {};
  const genre = classifyGenre(brandDNA, contentTheme);
  const v = rawVetterOutput || {};
  const opts = {
    subjectCorrect: v.subject_correct !== false,
    smallestDimensionPx: v.smallest_dimension_px,
    flagThirdParty: !!v.third_party_flag,
    flagMinor: !!v.minor_flag,
    flagNsfw: !!v.nsfw_flag
  };
  const decision = decisionLogic.decide(v.scores || {}, genre, opts);

  const result = {
    ...decision,
    notes: v.notes || {},
    subject_phrase: v.subject_phrase || null,
    manual_review_recommended: shouldFlagManualReview(decision, v)
  };

  if (decision.verdict === 'enhance_via_higgsfield') {
    result.next_action = {
      type: 'enhance_via_higgsfield',
      ...enhanceBrief.buildEnhanceBrief({ brandDNA, contentTheme, vetterOutput: v })
    };
  } else if (decision.verdict === 'regenerate_fresh') {
    const hf = require('../higgsfield');
    const brief = hf.buildImageBrief({ brandDNA, contentTheme, hasReferenceImage: false, isI2V: false });
    result.next_action = {
      type: 'regenerate_fresh',
      genre: brief.genreName,
      model: brief.model.id,
      use_as_visual_reference_only: true,
      regenerate_hint: 'pass system prompt + the customer image as reference; do not lock to it as I2I'
    };
  } else if (decision.verdict === 'use_as_is') {
    result.next_action = { type: 'publish', skip_higgsfield: true, reason: 'image meets all dimensions; saves credits' };
  } else {
    result.next_action = { type: 'reject', reason: decision.rationale_lead || 'failed verdict' };
  }

  return result;
}

function shouldFlagManualReview(decision, vetterOutput) {
  if (decision.borderline) return true;
  if ((vetterOutput?.scores?.brand_alignment || 0) <= 4) return true;
  if (decision.hard_gates_fired?.some((g) => g.name === 'third_party' || g.name === 'minor' || g.name === 'nsfw')) return true;
  return false;
}

/**
 * Build the system prompt that should be passed to a Claude vision call.
 * The vision call is the responsibility of the caller (services/higgsfield.js
 * already has claudeVision via its deps).
 */
function buildVetterRequest(input) {
  const { brandDNA, contentTheme } = input || {};
  return {
    system: systemPrompt.buildVetterSystemPrompt(brandDNA, contentTheme),
    userTask: `Vet this customer-uploaded image for marketing use. Apply the framework. Output JSON only — no prose.`
  };
}

module.exports = {
  buildVetterRequest,
  synthesizeVerdict,
  ...decisionLogic,
  ...systemPrompt,
  ...enhanceBrief,
  ...weights
};
