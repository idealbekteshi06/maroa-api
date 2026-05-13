'use strict';

/**
 * Schaefer Conversational Copy.
 *
 * Source: Bly/Schaefer school of modern conversational copywriting
 * (Bob Bly, "The Copywriter\'s Handbook" 1985; Mark Schaefer,
 * "The Tao of Twitter" 2013). The shift: write like you talk. Short
 * sentences. Contractions. Second person. One-thought-per-line.
 *
 * Especially important for: email, social, organic content where
 * tone-of-talk dominates over tone-of-write.
 *
 * Manipulation_risk = 1.
 */

const { _sentences, _wordCount, makeFix, applicability } = require('../_helpers');

function applyToDraft(draft) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const sentences = _sentences(draft);
  if (!sentences.length) return { score: 0, fixes: [], reasoning: 'no sentences' };

  const wordsPerSentence = sentences.map(_wordCount);
  const avg = wordsPerSentence.reduce((a, b) => a + b, 0) / sentences.length;
  const fixes = [];

  // Conversational target: avg sentence < 20 words
  if (avg > 22) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: `Schaefer: avg sentence ${avg.toFixed(1)} words — too long for conversational tone`,
        suggestion: 'Break long sentences at conjunctions. Target ≤ 18 words/sentence.',
      })
    );
  }

  // Contractions = conversational tone
  const hasContractions =
    /\b(don\'t|can\'t|won\'t|isn\'t|wasn\'t|haven\'t|hasn\'t|wouldn\'t|i\'m|you\'re|we\'re|they\'re|it\'s|that\'s|here\'s)\b/i.test(
      draft
    );
  if (!hasContractions && _wordCount(draft) > 30) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'Schaefer: no contractions — reads as formal/stiff',
        suggestion: 'Use "don\'t" not "do not", "you\'re" not "you are". Match how people actually talk.',
      })
    );
  }

  // Second person
  const hasYou = /\byou(\.|,|\s|$)/i.test(draft);
  if (!hasYou) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'Schaefer: no "you" — third-person feels distant',
        suggestion: 'Address the reader directly with "you".',
      })
    );
  }

  const present = [avg <= 22, hasContractions, hasYou].filter(Boolean).length;
  return {
    score: present / 3,
    fixes,
    reasoning: `avg_sent=${avg.toFixed(1)} contractions=${hasContractions} you=${hasYou}`,
  };
}

function generateFromSpec({ tone = 'friendly' }) {
  return {
    structure: 'Conversational tone',
    prompt_segments: [
      `Write like you talk. Short sentences (≤18 words). Contractions ("you\'re" not "you are").`,
      `Second person. One-thought-per-line. Tone: ${tone}.`,
      'Read it aloud — if it sounds like a press release, rewrite.',
    ],
  };
}

module.exports = {
  id: 'schaefer-conversational-copy',
  name: 'Schaefer Conversational Copy',
  category: 'response',
  source_citation: 'Bly, "The Copywriter\'s Handbook" (1985); Schaefer, "The Tao of Twitter" (2013)',
  applicability: applicability({
    channels: ['email-cold', 'email-nurture', 'instagram-post', 'tiktok', 'x-post', 'linkedin-post', 'threads-post'],
  }),
  invariants: [
    { id: 'conversational', rule: 'Avg sentence ≤ 22 words; contractions; second person', kind: 'must_have' },
  ],
  manipulation_risk: 1,
  applyToDraft,
  generateFromSpec,
};
