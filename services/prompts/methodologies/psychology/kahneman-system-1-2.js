'use strict';

/**
 * Kahneman System 1 / System 2 — fast vs slow thinking applied to ad design.
 *
 * Source: Daniel Kahneman, "Thinking, Fast and Slow" (2011).
 *
 * SYSTEM 1: fast, intuitive, emotional, pattern-matching. Most ad scrolling
 *           is System 1. Hooks must trigger System 1 — visual, simple,
 *           emotionally legible.
 * SYSTEM 2: slow, analytical, effortful. Long-form, B2B procurement, and
 *           pricing pages live in System 2. Detailed proof, comparison
 *           tables, FAQs work here.
 *
 * Design rule: match the cognitive mode of the channel + funnel stage.
 * TOFU on TikTok = System 1. BOFU on a sales page = System 2. Mixing
 * them confuses both.
 *
 * Manipulation_risk = 2. Descriptive, not manipulative.
 */

const { _wordCount, makeFix, applicability } = require('../_helpers');

function applyToDraft(draft, context = {}) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const wc = _wordCount(draft);
  const channel = context.channel || '';
  const funnel = context.funnel_stage || '';

  // Determine target system
  const SYSTEM_1_CHANNELS = ['instagram-reels', 'tiktok', 'meta-ads-video', 'youtube-shorts', 'x-post'];
  const SYSTEM_2_CHANNELS = [
    'landing-page-long',
    'sales-page',
    'webinar',
    'blog-thought-leadership',
    'linkedin-article',
  ];
  const targetSystem = SYSTEM_1_CHANNELS.includes(channel)
    ? 1
    : SYSTEM_2_CHANNELS.includes(channel)
      ? 2
      : funnel === 'tofu'
        ? 1
        : 2;

  const fixes = [];
  if (targetSystem === 1 && wc > 60) {
    fixes.push(
      makeFix({
        severity: 'block',
        issue: `Kahneman: System-1 channel (${channel || funnel}) but draft is ${wc} words (analytical)`,
        suggestion: 'Cut to ≤60 words. System 1 needs emotional + visual, not analytical.',
      })
    );
  }
  if (targetSystem === 2 && wc < 40) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: `Kahneman: System-2 channel (${channel || funnel}) but draft is only ${wc} words`,
        suggestion: 'Expand with detail, proof, and comparison. System 2 readers expect depth.',
      })
    );
  }
  return { score: fixes.length === 0 ? 1.0 : 0.4, fixes, reasoning: `target=System${targetSystem} wc=${wc}` };
}

function generateFromSpec({ channel, funnel_stage }) {
  const SYSTEM_1_CHANNELS = new Set(['instagram-reels', 'tiktok', 'meta-ads-video', 'youtube-shorts', 'x-post']);
  const isSystem1 = SYSTEM_1_CHANNELS.has(channel) || funnel_stage === 'tofu';
  return {
    structure: isSystem1 ? 'System 1 (fast, intuitive)' : 'System 2 (slow, analytical)',
    prompt_segments: isSystem1
      ? [
          'Target SYSTEM 1: fast, emotional, visual.',
          'Open with image/scene/feeling, not a thesis. ≤60 words.',
          'No tables, no comparison logic, no fine print.',
        ]
      : [
          'Target SYSTEM 2: slow, analytical.',
          'Use tables, comparisons, proof, FAQs. Readers expect depth.',
          'Address objections explicitly. Show your work.',
        ],
  };
}

module.exports = {
  id: 'kahneman-system-1-2',
  name: 'Kahneman System 1 / System 2',
  category: 'psychology',
  source_citation: 'Daniel Kahneman, "Thinking, Fast and Slow" (2011)',
  applicability: applicability({}),
  invariants: [
    { id: 'match-mode', rule: 'Cognitive mode of copy must match channel + funnel stage', kind: 'must_have' },
  ],
  manipulation_risk: 2,
  applyToDraft,
  generateFromSpec,
};
