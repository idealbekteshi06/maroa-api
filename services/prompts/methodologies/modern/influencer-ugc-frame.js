'use strict';

/**
 * Influencer / UGC Frame — native-feeling content rules.
 *
 * Source: industry consensus from creator-economy practitioners
 * (NeuronVC, Insense, Trend, 2020+). Synthesizes what works in
 * UGC-style paid ads on Meta + TikTok.
 *
 * Rules:
 *   - Speak from "I"/"my experience", not "we"/"our product"
 *   - Vertical video. Phone-quality, not studio
 *   - Opens with hook in first 1.5 seconds
 *   - Casual, unscripted feel — even if scripted
 *   - Real packaging shots, not stock
 *   - Mentions specific moments ("I tried this last Tuesday")
 *
 * Manipulation_risk = 3. Paid UGC must disclose; otherwise it\'s
 * deceptive endorsement (FTC violation).
 */

const { _containsAny, makeFix, applicability } = require('../_helpers');

const UGC_VOICE_MARKERS = ['i', 'my', 'i tried', 'i bought', 'i was', 'a few weeks ago', 'last week i'];
const CORPORATE_VOICE_FLAGS = ['our product', 'we offer', 'our team', 'we believe', 'the company'];

function applyToDraft(draft) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const ugcVoice = _containsAny(draft, UGC_VOICE_MARKERS);
  const corpVoice = _containsAny(draft, CORPORATE_VOICE_FLAGS);
  const fixes = [];
  if (corpVoice) {
    fixes.push(
      makeFix({
        severity: 'block',
        issue: 'UGC frame: corporate voice breaks the native feel',
        suggestion: 'Rewrite in first person as the creator: "I bought this", not "Our product helps you".',
      })
    );
  }
  return { score: ugcVoice && !corpVoice ? 1.0 : 0.3, fixes, reasoning: `ugc=${ugcVoice} corp=${corpVoice}` };
}

function generateFromSpec({ creator_persona, product_use_moment }) {
  return {
    structure: 'UGC creator voice',
    prompt_segments: [
      `Write as the CREATOR (${creator_persona || 'a real user'}), not the brand.`,
      `Open with the hook: "${product_use_moment || 'I tried this last week and...'}".`,
      'First person throughout. Specific moments. Phone-quality vibe.',
      'AVOID "we offer" / "our product" / corporate scaffolding.',
      'COMPLIANCE: paid UGC must include #ad or "paid partnership" disclosure (FTC).',
    ],
  };
}

module.exports = {
  id: 'influencer-ugc-frame',
  name: 'Influencer / UGC Frame',
  category: 'modern',
  source_citation: 'Industry consensus, creator-economy practitioners (2020+)',
  applicability: applicability({
    channels: ['instagram-reels', 'tiktok', 'meta-ads-video', 'tiktok-ads', 'youtube-shorts'],
  }),
  invariants: [
    { id: 'creator-voice', rule: 'First person creator voice, never corporate', kind: 'must_have' },
    { id: 'disclosure', rule: 'Paid UGC must disclose per FTC', kind: 'must_have' },
  ],
  manipulation_risk: 3,
  applyToDraft,
  generateFromSpec,
};
