'use strict';

const SLOP_REPLACEMENTS = {
  beautiful: null,
  stunning: null,
  amazing: null,
  gorgeous: null,
  awesome: null,
  incredible: null,
  epic: 'large-scale, sweeping, towering',
  dynamic: 'fast-tracking, whip-pan, handheld',
  energetic: 'sprinting, jumping, arms pumping',
  vibrant: 'saturated jewel tones',
  premium: 'matte black, soft diffused light',
  luxurious: 'dark moody, single hard side-light',
  professional: 'soft diffused even lighting, clean composition',
  'cinematic camera movement': 'slow Dolly In',
  'cool transition': 'match-cut',
  'dramatic camera': 'slow Crane Up',
  'eye-catching': null,
  'attention-grabbing': null
};

function killSlop(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  for (const [slop, replacement] of Object.entries(SLOP_REPLACEMENTS)) {
    const re = new RegExp(`\\b${slop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    out = out.replace(re, replacement || '');
  }
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').trim();
}

const SLOP_INSTRUCTION = `
Anti-slop rules — kill these zero-information words:
beautiful, stunning, amazing, gorgeous, awesome, incredible, vibrant, premium (alone), luxurious (alone), professional (alone), eye-catching, attention-grabbing.
Replace abstractions with concrete observable physics:
- "epic" → "large-scale, sweeping, towering"
- "dynamic" → "fast-tracking, whip-pan, handheld"
- "energetic" → "sprinting, jumping, arms pumping"
- "cinematic camera movement" → name the camera (e.g. "slow Dolly In")
- "cool transition" → "match-cut" or "whip pan"
- "dramatic entrance" → "door slams open, dust erupts, light floods the room"`.trim();

module.exports = { SLOP_REPLACEMENTS, killSlop, SLOP_INSTRUCTION };
