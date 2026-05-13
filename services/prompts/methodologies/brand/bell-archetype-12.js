'use strict';

/**
 * Bell Archetype 12 — the 12 brand archetypes.
 *
 * Source: Margaret Mark & Carol Pearson, "The Hero and the Outlaw" (2001).
 * Builds on Jungian archetypes (Pearson, "Awakening the Heroes Within" 1991).
 *
 * 12 archetypes map every successful brand:
 *   1. Innocent — Coca-Cola, Dove
 *   2. Sage — Google, BBC, NYT
 *   3. Explorer — Patagonia, North Face, Jeep
 *   4. Outlaw — Harley-Davidson, Virgin
 *   5. Magician — Apple, Disney
 *   6. Hero — Nike, FedEx
 *   7. Lover — Victoria\'s Secret, Chanel
 *   8. Jester — Old Spice, Skittles
 *   9. Everyman — IKEA, Target, Levi\'s
 *  10. Caregiver — Johnson & Johnson, UNICEF
 *  11. Ruler — Rolex, Mercedes
 *  12. Creator — Lego, Adobe, Apple (overlap)
 *
 * A brand is more memorable when it owns ONE archetype and uses
 * archetype-consistent vocabulary, imagery, and tone.
 *
 * Manipulation_risk = 1.
 */

const { makeFix, applicability } = require('../_helpers');

const ARCHETYPES = Object.freeze([
  { id: 'innocent', name: 'Innocent', voice_markers: ['simple', 'pure', 'honest', 'wholesome'] },
  { id: 'sage', name: 'Sage', voice_markers: ['discover', 'understand', 'truth', 'wisdom'] },
  { id: 'explorer', name: 'Explorer', voice_markers: ['adventure', 'discover', 'wild', 'free'] },
  { id: 'outlaw', name: 'Outlaw', voice_markers: ['rebel', 'break', "rules don't apply", 'fight'] },
  { id: 'magician', name: 'Magician', voice_markers: ['transform', 'magical', 'imagine', 'visionary'] },
  { id: 'hero', name: 'Hero', voice_markers: ['triumph', 'overcome', 'master', 'mastery'] },
  { id: 'lover', name: 'Lover', voice_markers: ['beautiful', 'intimate', 'pleasure', 'devoted'] },
  { id: 'jester', name: 'Jester', voice_markers: ['playful', 'fun', 'lighten up', 'joke'] },
  { id: 'everyman', name: 'Everyman', voice_markers: ['real people', 'down-to-earth', 'genuine', 'practical'] },
  { id: 'caregiver', name: 'Caregiver', voice_markers: ['care', 'protect', 'family', 'nurture'] },
  { id: 'ruler', name: 'Ruler', voice_markers: ['premium', 'authority', 'exclusive', 'sophisticated'] },
  { id: 'creator', name: 'Creator', voice_markers: ['build', 'design', 'create', 'imagine'] },
]);

function detectArchetypes(draft) {
  if (!draft) return [];
  const lower = draft.toLowerCase();
  return ARCHETYPES.filter((a) => a.voice_markers.some((m) => lower.includes(m))).map((a) => a.id);
}

function applyToDraft(draft, context = {}) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const detected = detectArchetypes(draft);
  const fixes = [];
  if (detected.length === 0) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'Bell: no recognizable archetype voice',
        suggestion: 'Lean into one archetype consistently.',
      })
    );
  } else if (detected.length > 2) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: `Bell: multiple archetypes mixed (${detected.join(', ')})`,
        suggestion: 'Pick ONE primary archetype. Mixing dilutes brand recall.',
      })
    );
  }
  return {
    score: detected.length === 1 ? 1.0 : detected.length === 2 ? 0.7 : 0.4,
    fixes,
    reasoning: `archetypes=${detected.join(',')}`,
  };
}

function generateFromSpec({ archetype }) {
  const a = ARCHETYPES.find((x) => x.id === archetype) || ARCHETYPES[8]; // default everyman
  return {
    structure: `Bell archetype: ${a.name}`,
    prompt_segments: [
      `BRAND ARCHETYPE: ${a.name}. Use vocabulary aligned with this archetype: ${a.voice_markers.join(', ')}.`,
      'Stay consistent — no archetype mixing.',
    ],
  };
}

module.exports = {
  id: 'bell-archetype-12',
  name: 'Bell 12 Brand Archetypes',
  category: 'brand',
  source_citation: 'Margaret Mark & Carol Pearson, "The Hero and the Outlaw" (2001)',
  applicability: applicability({}),
  invariants: [{ id: 'single-archetype', rule: 'Single primary archetype per brand', kind: 'must_have' }],
  manipulation_risk: 1,
  ARCHETYPES,
  detectArchetypes,
  applyToDraft,
  generateFromSpec,
};
