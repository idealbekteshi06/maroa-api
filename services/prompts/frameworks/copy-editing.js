'use strict';

/**
 * Seven Sweeps copy-editing framework (adapted from coreyhaines31/marketingskills).
 * Used by quality-gate/ as deterministic pre-ship polish + LLM repair hints.
 */

const SEVEN_SWEEPS = [
  { id: 'clarity', name: 'Clarity', focus: 'Reader understands without re-reading' },
  { id: 'voice', name: 'Voice and tone', focus: 'Consistent brand personality throughout' },
  { id: 'so_what', name: 'So what', focus: 'Every claim answers why the reader should care' },
  { id: 'prove_it', name: 'Prove it', focus: 'Claims backed by evidence, numbers, or specifics' },
  { id: 'specificity', name: 'Specificity', focus: 'Concrete nouns/verbs; no vague corporate filler' },
  { id: 'heightened', name: 'Heightened emotion', focus: 'Emotional pull without manipulation' },
  { id: 'zero_risk', name: 'Zero risk', focus: 'Friction and anxiety removed near CTA' },
];

const HEDGE_WORDS = /\b(might|could|perhaps|maybe|somewhat|fairly|relatively|basically|literally|just|very|really)\b/gi;
const VAGUE_PHRASES =
  /\b(leverage|utilize|synergy|best-in-class|world-class|cutting-edge|innovative solution|take your .+ to the next level|game.?changer)\b/gi;
const FEATURE_WITHOUT_BENEFIT = /\b(our (platform|tool|app|software|service) (uses|offers|provides|features))\b/i;
const UNPROVEN_SUPERLATIVE = /\b(best|#1|leading|top-rated|unmatched|unbeatable)\b(?![\s\S]{0,40}\d)/gi;

function runSevenSweepsHeuristics(text) {
  const issues = [];
  const t = String(text || '');

  if (
    (t.match(/\b\w+\b/g) || []).some((w, i, arr) => {
      const start = arr.slice(0, i).join(' ').length;
      const sentence = t.slice(start, start + 200);
      return sentence.split(/\s+/).length > 35;
    })
  ) {
    issues.push({ sweep: 'clarity', issue: 'sentence_too_long' });
  }

  if (HEDGE_WORDS.test(t)) issues.push({ sweep: 'voice', issue: 'hedging_language' });
  if (VAGUE_PHRASES.test(t)) issues.push({ sweep: 'specificity', issue: 'vague_corporate_phrase' });
  if (FEATURE_WITHOUT_BENEFIT.test(t)) issues.push({ sweep: 'so_what', issue: 'feature_without_benefit_bridge' });
  if (UNPROVEN_SUPERLATIVE.test(t)) issues.push({ sweep: 'prove_it', issue: 'superlative_without_proof' });

  const passed = issues.length === 0;
  return { passed, issues, sweeps_checked: SEVEN_SWEEPS.length };
}

function buildCopyEditingPromptSection() {
  return SEVEN_SWEEPS.map((s, i) => `Sweep ${i + 1} — ${s.name}: ${s.focus}`).join('\n');
}

function buildCopyEditingRepairInstruction(issues) {
  const list = (issues || []).map((x) => `${x.sweep}: ${x.issue}`).join('; ');
  return [
    'Apply the Seven Sweeps copy-editing framework sequentially.',
    'Preserve core message and brand voice; tighten and add benefit bridges.',
    list ? `Fix these heuristic flags: ${list}` : '',
    buildCopyEditingPromptSection(),
  ]
    .filter(Boolean)
    .join('\n');
}

module.exports = {
  SEVEN_SWEEPS,
  runSevenSweepsHeuristics,
  buildCopyEditingPromptSection,
  buildCopyEditingRepairInstruction,
};
