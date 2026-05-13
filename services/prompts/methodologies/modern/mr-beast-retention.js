'use strict';

/**
 * Mr Beast Retention — first 3-second hook + reset every 30s.
 *
 * Source: MrBeast (Jimmy Donaldson) interviews + leaked production
 * playbook (2023). The most-studied retention engineer in modern video.
 *
 * Rules for long-form video:
 *   - First 3 seconds must answer "why should I watch this?"
 *   - Every 30 seconds, introduce a new beat / stakes raise / pattern interrupt
 *   - Show the goal upfront, restate periodically
 *   - Use specific numbers ("the $1M challenge") not vague ones
 *   - Cut filler aggressively — every second must earn the next
 *
 * Manipulation_risk = 2.
 */

const { _wordCount, makeFix, applicability } = require('../_helpers');

function applyToDraft(draft, context = {}) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  // Applies only to video-script formats
  const isVideoScript = [
    'instagram-reels',
    'tiktok',
    'youtube-shorts',
    'youtube-long',
    'meta-ads-video',
    'tiktok-ads',
  ].includes(context.channel);
  if (!isVideoScript) return { score: 0.7, fixes: [], reasoning: 'not a video format' };

  const lines = draft.split(/\n/).filter(Boolean);
  const fixes = [];
  // Heuristic: first line/sentence should be < 8 words and contain a hook
  const firstLine = lines[0] || '';
  const firstLineWords = _wordCount(firstLine);
  if (firstLineWords > 8) {
    fixes.push(
      makeFix({
        severity: 'block',
        issue: `MrBeast: opening ${firstLineWords} words — too long for 3-sec hook`,
        suggestion: 'Cut opener to ≤8 words. Hook + immediate stakes.',
      })
    );
  }

  // Heuristic: pattern interrupts. Look for stakes-raise phrases throughout.
  const stakesPhrases = (draft.match(/\b(but then|until|suddenly|the catch is|the twist|here\'s where)\b/gi) || [])
    .length;
  const totalWords = _wordCount(draft);
  if (totalWords > 100 && stakesPhrases === 0) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'MrBeast: no pattern interrupts detected in long-form video script',
        suggestion: 'Add at least one stakes-raise every ~30 seconds: "But then...", "The catch is...".',
      })
    );
  }
  return {
    score: fixes.length === 0 ? 1.0 : 0.4,
    fixes,
    reasoning: `firstLine=${firstLineWords}w stakes=${stakesPhrases}`,
  };
}

function generateFromSpec({ goal, stakes }) {
  return {
    structure: 'MrBeast retention: hook + stakes + reset',
    prompt_segments: [
      `OPENER (first 3 seconds): hook + immediate stakes. ≤8 words. Example: "${goal || 'I gave away $10,000'}."`,
      `STAKES: ${stakes || 'what could go wrong'}. Make it visible.`,
      "EVERY 30 SECONDS: pattern interrupt. New beat. Stakes raise. Don't let attention drop.",
      'CUT FILLER aggressively. Every second must earn the next.',
    ],
  };
}

module.exports = {
  id: 'mr-beast-retention',
  name: 'MrBeast Retention Engineering',
  category: 'modern',
  source_citation: 'MrBeast (Jimmy Donaldson), interviews + production playbook (2023)',
  applicability: applicability({
    channels: ['instagram-reels', 'tiktok', 'youtube-shorts', 'youtube-long', 'meta-ads-video', 'tiktok-ads'],
  }),
  invariants: [
    { id: 'hook', rule: 'First 3 seconds must hook + reveal stakes', kind: 'must_have' },
    { id: 'reset', rule: 'Pattern interrupts every ~30 seconds in long-form', kind: 'must_have' },
  ],
  manipulation_risk: 2,
  applyToDraft,
  generateFromSpec,
};
