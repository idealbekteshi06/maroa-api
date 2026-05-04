'use strict';

const POSITIVE_CONSTRAINTS = {
  body_motion: [
    'anatomically correct, all limbs visible and naturally positioned',
    'one primary action with one or two secondary actions max',
    'distinct body separation between characters'
  ],
  face_identity: [
    'consistent character appearance, same outfit and features throughout',
    'natural skin texture, subtle imperfections',
    'sharp focus on face, no warping during camera movement'
  ],
  texture_lighting: [
    'specific named surface and lighting source',
    'committed single visual style, no style mixing',
    'measurable lighting source and quality'
  ],
  temporal_consistency: [
    'one primary camera movement per shot',
    'explicit named camera preset',
    'atmospheric motion specified (steam rises, dust floats, fabric moves)'
  ],
  product_safety: [
    'describe product by appearance only — no brand names',
    'specific surface and background, no floating in undefined space',
    'natural skin texture if hand visible'
  ],
  cinema_studio_3: [
    'use positive constraints only — no "no/avoid/don\'t" syntax',
    'locked-off static camera if no motion wanted',
    'sharp focus throughout, deep depth of field if no blur wanted'
  ]
};

function constraintsFor(categories) {
  const out = [];
  for (const cat of categories) {
    if (POSITIVE_CONSTRAINTS[cat]) out.push(...POSITIVE_CONSTRAINTS[cat]);
  }
  return [...new Set(out)];
}

const CONSTRAINT_INSTRUCTION = `
Use POSITIVE constraints only. Never write "no blur", "no shaky", "avoid X", "don't make it Y".
Instead write what you want directly:
- Want stable? "locked-off static camera"
- Want sharp? "sharp focus throughout, deep depth of field"
- Want bright? "evenly lit, overcast daylight"
- Want consistent character? "same outfit and features throughout"`.trim();

module.exports = { POSITIVE_CONSTRAINTS, constraintsFor, CONSTRAINT_INSTRUCTION };
