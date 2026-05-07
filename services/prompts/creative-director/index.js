'use strict';

const methodologies = require('./methodologies');
const scoring = require('./scoring');
const patterns = require('./patterns');
const systemPrompt = require('./system-prompt');
const hf = require('../higgsfield');

/**
 * Public API:
 *   buildCreativeBrief({ brandDNA, businessGoal, contentGoal, ideaLevel?, rotation? })
 *     → { system, userTask } — pass to claudeText/Vision (model: opus-4-5)
 *
 *   convertConceptToMcslaInputs(concept, brandDNA)
 *     → { contentTheme, isI2V, wantsAudio, durationSec } — feed into hf.buildImageBrief / buildVideoBrief
 */

function buildCreativeBrief(input) {
  const { brandDNA, businessGoal, contentGoal, ideaLevel, rotation } = input || {};
  const system = systemPrompt.buildCreativeDirectorSystemPrompt(
    brandDNA,
    businessGoal,
    contentGoal,
    { ideaLevel, rotation }
  );
  const userTask = `Brief: ${contentGoal || 'general content'}\n\nProduce one Cannes-grade concept following the framework. JSON only.`;
  return { system, userTask };
}

/**
 * Translate a creative-director concept into MCSLA inputs that downstream
 * Higgsfield prompt-building can consume.
 */
function convertConceptToMcslaInputs(concept, brandDNA) {
  const c = concept || {};
  const top = c.top_concept || {};
  const brief = top.downstream_brief_for_higgsfield || {};
  const isVideo = /reel|story|video|tiktok|ad|spot|film/i.test(brief.platform_native_aspect || '') || /reel|story|video|tiktok|ad|spot|film/i.test(brief.action || '');
  return {
    contentTheme: top.name ? `${top.name} — ${top.one_sentence}` : (c.brief_summary || ''),
    isI2V: false,
    wantsAudio: !!brief.audio_cue,
    durationSec: 8,
    aspectRatio: brief.platform_native_aspect || '9:16',
    creativeContext: {
      insight: c.insight,
      pattern: top.pattern,
      visualization: brief.subject,
      action: brief.action,
      camera: brief.camera,
      look: brief.look,
      audio: brief.audio_cue
    }
  };
}

/**
 * One-call helper: take a concept already produced by the creative-director
 * model, plus the customer's brand, and produce a Higgsfield image brief.
 */
function buildImageBriefFromConcept(concept, brandDNA) {
  const inputs = convertConceptToMcslaInputs(concept, brandDNA);
  const brief = hf.buildImageBrief({
    brandDNA,
    contentTheme: inputs.contentTheme,
    hasReferenceImage: false,
    isI2V: false
  });
  brief.creativeContext = inputs.creativeContext;
  brief.system = `${brief.system}\n\nADDITIONAL CREATIVE DIRECTION (from creative-director upstream):\nInsight: ${inputs.creativeContext.insight}\nPattern: ${inputs.creativeContext.pattern}\nVisualization: ${inputs.creativeContext.visualization}\nAction: ${inputs.creativeContext.action}\nCamera: ${inputs.creativeContext.camera}\nLook: ${inputs.creativeContext.look}\n\nLock the MCSLA output to this creative direction. Do not invent a different concept.`;
  return brief;
}

function buildVideoBriefFromConcept(concept, brandDNA, opts = {}) {
  const inputs = convertConceptToMcslaInputs(concept, brandDNA);
  const brief = hf.buildVideoBrief({
    brandDNA,
    contentTheme: inputs.contentTheme,
    isI2V: opts.isI2V || false,
    wantsAudio: inputs.wantsAudio,
    durationSec: opts.durationSec || inputs.durationSec
  });
  brief.creativeContext = inputs.creativeContext;
  brief.system = `${brief.system}\n\nADDITIONAL CREATIVE DIRECTION (from creative-director upstream):\nInsight: ${inputs.creativeContext.insight}\nPattern: ${inputs.creativeContext.pattern}\nVisualization: ${inputs.creativeContext.visualization}\nAction: ${inputs.creativeContext.action}\nCamera: ${inputs.creativeContext.camera}\nLook: ${inputs.creativeContext.look}${inputs.creativeContext.audio ? `\nAudio: ${inputs.creativeContext.audio}` : ''}\n\nLock the MCSLA output to this creative direction. Do not invent a different concept.`;
  return brief;
}

/**
 * Enrich a creative concept with marketing-psychology principle.
 *
 * After the creative-director produces a top_concept, this helper applies
 * the best-fit psychology principle to its hook + CTA copy. Returns the
 * concept WITH a `psychology_enriched` field — never mutates the input.
 *
 * Designed for use right after concept generation in the WF1 daily content
 * flow, or any caller that wants psychology-baked copy.
 */
async function enrichConceptWithPsychology({ concept, business, plan, callClaude, extractJSON, logger }) {
  if (!concept || !concept.top_concept) return concept;
  // Lazy load — avoids circular deps with marketing-psychology if any
  const psy = require('../marketing-psychology');
  const planTier = String(plan || 'free').toLowerCase();

  // Free tier: deterministic-only audit (no LLM, no rewrites)
  if (planTier === 'free') {
    const auditResult = await psy.audit({
      text: concept.top_concept.hook || concept.top_concept.one_sentence || '',
      business,
      funnelStage: 'awareness',
      plan: 'free',
      callClaude, extractJSON, logger,
    });
    return {
      ...concept,
      psychology_enriched: {
        applied: false,
        reason: 'free_tier',
        audit_summary: auditResult,
      },
    };
  }

  // Growth+: actually apply best-fit principle to the hook
  try {
    const hook = concept.top_concept.hook;
    const cta = concept.top_concept.downstream_brief_for_higgsfield?.action;
    const [hookRes, ctaRes] = await Promise.all([
      hook ? psy.apply({
        text: hook, business, principleId: 'auto', plan: planTier,
        funnelStage: 'awareness', callClaude, extractJSON, logger,
      }) : Promise.resolve(null),
      cta ? psy.apply({
        text: cta, business, principleId: 'auto', plan: planTier,
        funnelStage: 'decision', callClaude, extractJSON, logger,
      }) : Promise.resolve(null),
    ]);

    return {
      ...concept,
      psychology_enriched: {
        applied: true,
        hook_rewrite: hookRes && !hookRes.refused ? {
          original: hook,
          rewritten: hookRes.rewritten,
          principle: hookRes.applied_principle,
        } : null,
        cta_rewrite: ctaRes && !ctaRes.refused ? {
          original: cta,
          rewritten: ctaRes.rewritten,
          principle: ctaRes.applied_principle,
        } : null,
      },
    };
  } catch (e) {
    logger?.warn?.('creative-director.enrichConceptWithPsychology', null, 'failed', e?.message);
    return { ...concept, psychology_enriched: { applied: false, reason: 'error' } };
  }
}

module.exports = {
  buildCreativeBrief,
  convertConceptToMcslaInputs,
  buildImageBriefFromConcept,
  buildVideoBriefFromConcept,
  enrichConceptWithPsychology,
  ...systemPrompt,
  ...methodologies,
  ...scoring,
  ...patterns
};
