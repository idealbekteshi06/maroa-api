'use strict';

/**
 * services/prompts/brand-voice/visual-dna.js
 * ----------------------------------------------------------------------------
 * Per-business VISUAL fingerprint — guarantees no two Maroa customers'
 * generated content looks the same when running without Soul ID character
 * lock (i.e., on the Cloud-only Higgsfield path).
 *
 * Each business gets a deterministic-from-inputs visual DNA:
 *   • palette         (industry-appropriate base + per-business variant)
 *   • subject_archetype (the type of person/setting in their content)
 *   • mood / energy    (warm/cool, modern/classic, calm/energetic)
 *   • lighting         (soft natural / studio / warm-golden / etc.)
 *   • composition      (close-up / medium / wide / overhead)
 *   • setting          (interior style / outdoor type)
 *
 * Determinism: same (business_name + industry + business_id) ALWAYS
 * produces the same DNA. Stable identity across regenerations.
 *
 * Uniqueness: different businesses get different DNA because the hash
 * ranges over palette variants × archetype variants × mood variants ×
 * lighting variants — yielding thousands of combinations per industry.
 *
 * Public API:
 *   buildVisualDna({ business, vocAnalysis })  → visual_brand_dna object
 *   formatForHiggsfield(visualDna)             → compact prompt suffix
 *   formatForLlm(visualDna)                    → human-readable description
 * ----------------------------------------------------------------------------
 */

// Stable string hash (FNV-1a 32-bit). Deterministic, fast, no deps.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pick(arr, hash) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[hash % arr.length];
}

// ─── Industry-aware visual templates ────────────────────────────────────

const INDUSTRY_VISUAL = {
  // Food & hospitality — warm, sensory, human
  cafe: {
    palettes: [
      ['warm cream', 'espresso brown', 'soft terracotta'],
      ['butter yellow', 'walnut', 'sage'],
      ['linen', 'cocoa', 'amber'],
    ],
    subject_archetypes: [
      'an unhurried barista mid-pour, hands shown',
      'a regular customer at the bar in soft conversation',
      'morning sunlight on a single ceramic cup',
    ],
    moods: ['warm and unhurried', 'morning-quiet', 'inviting and lived-in'],
    lighting: ['soft window-side morning light', 'warm golden-hour interior', 'diffused overcast through tall windows'],
    composition: ['intimate medium-close', 'low-angle counter perspective', 'overhead flat lay'],
    settings: ['exposed brick & oak interior', 'minimalist scandi cafe', 'plant-filled corner with reclaimed wood'],
  },
  restaurant: {
    palettes: [
      ['burgundy', 'cream', 'brass'],
      ['ink black', 'white linen', 'fresh herb green'],
      ['sun-bleached terracotta', 'olive', 'aged copper'],
    ],
    subject_archetypes: [
      'a chef plating with focused hands',
      'a server placing the dish at a candlelit table',
      'pasta being twirled — steam rising',
    ],
    moods: ['intimate and considered', 'celebratory and warm', 'craft-driven and quiet'],
    lighting: ['low warm tungsten', 'candlelit table with rim light', 'natural light through linen curtains'],
    composition: ['shallow-focus food close-up', 'over-the-shoulder of the diner', 'tabletop two-shot'],
    settings: ['intimate 8-table room', 'open kitchen view', 'patio with string lights'],
  },
  // Health & wellness — clean, calm, trustworthy
  'dental clinic': {
    palettes: [
      ['clinical white', 'soft mint', 'navy accent'],
      ['ivory', 'warm beige', 'sage'],
      ['white', 'pale blue', 'silver'],
    ],
    subject_archetypes: [
      'a patient smiling after their appointment, natural and unposed',
      'gentle hands holding a mirror so the patient can see',
      'a calm dentist in scrubs at the chair side, listening',
    ],
    moods: ['reassuring and modern', 'calm and trustworthy', 'bright and welcoming'],
    lighting: ['daylight-balanced overhead with soft fill', 'bright window-side natural light', 'clean clinical key-light'],
    composition: ['eye-level patient close-up', 'medium two-shot of doctor + patient', 'clean wide of treatment room'],
    settings: ['contemporary clinic with plants', 'warm waiting room with art', 'modern treatment room with daylight'],
  },
  // Local services — practical, capable, real
  plumber: {
    palettes: [
      ['steel blue', 'safety yellow', 'graphite'],
      ['copper', 'navy', 'concrete grey'],
      ['workwear blue', 'orange accent', 'matte black'],
    ],
    subject_archetypes: [
      'a focused tradesperson with tools, mid-repair',
      'a hand turning a wrench with crisp detail',
      'the tradesperson explaining the fix to a homeowner',
    ],
    moods: ['capable and direct', 'no-nonsense and trustworthy', 'practical and reassuring'],
    lighting: ['available daylight under-sink', 'on-location natural', 'soft overcast outdoor'],
    composition: ['hands-and-tool detail shot', 'medium working portrait', 'before/after split'],
    settings: ['real residential kitchen or bathroom', 'utility room', 'on-the-truck or job-site'],
  },
  // SaaS / B2B — modern, confident, human-centered
  'saas b2b': {
    palettes: [
      ['cobalt blue', 'soft white', 'neon mint accent'],
      ['indigo', 'oat', 'electric coral'],
      ['deep teal', 'cream', 'amber accent'],
    ],
    subject_archetypes: [
      'a focused founder at a clean modern desk',
      'a small team in candid conversation around a screen',
      'product UI mocked into a real environment',
    ],
    moods: ['confident and clean', 'human and modern', 'optimistic and serious'],
    lighting: ['soft window-side daylight', 'modern office natural', 'studio key-light with rim'],
    composition: ['medium portrait with negative space', 'over-the-shoulder UI shot', 'wide editorial workspace'],
    settings: ['minimal modern office', 'home office with plants', 'editorial co-working space'],
  },
  // Retail / e-commerce — product-forward, lifestyle
  'e-commerce apparel': {
    palettes: [
      ['warm sand', 'cream', 'terracotta'],
      ['matte black', 'oat', 'chrome'],
      ['sage', 'ivory', 'rust'],
    ],
    subject_archetypes: [
      'lifestyle model wearing the product in a real environment',
      'product flat lay with considered styling',
      'detail close-up of fabric texture and stitching',
    ],
    moods: ['effortless and considered', 'lived-in and aspirational', 'editorial and clean'],
    lighting: ['soft golden-hour natural', 'studio with shadow play', 'overcast outdoor diffused'],
    composition: ['three-quarter lifestyle portrait', 'tabletop flat lay', 'macro detail'],
    settings: ['urban-natural exterior', 'minimal studio with concrete floor', 'home interior with character'],
  },
  // Real estate
  'real estate agent': {
    palettes: [
      ['deep navy', 'cream', 'brushed gold'],
      ['warm grey', 'white', 'forest green'],
      ['ivory', 'taupe', 'matte black'],
    ],
    subject_archetypes: [
      'the agent in front of a beautiful home, confident and welcoming',
      'a couple receiving keys, candid joy',
      'the property exterior at golden hour',
    ],
    moods: ['aspirational and trustworthy', 'warm and ceremonial', 'editorial-listing'],
    lighting: ['golden hour exterior', 'bright airy interior natural', 'twilight blue-hour exterior'],
    composition: ['environmental portrait with home in frame', 'wide listing shot', 'medium two-shot at the doorway'],
    settings: ['curb-appeal exterior', 'staged living room', 'contemporary kitchen at golden hour'],
  },
  // Professional services
  'law firm': {
    palettes: [
      ['deep navy', 'ivory', 'brass'],
      ['charcoal', 'white', 'forest green'],
      ['burgundy', 'cream', 'gunmetal'],
    ],
    subject_archetypes: [
      'the attorney in a quiet office, thoughtful',
      'an attorney listening intently to a client',
      'a focused hand on a contract page',
    ],
    moods: ['composed and trustworthy', 'considered and human', 'serious without being cold'],
    lighting: ['window-side natural with shadow', 'warm tungsten with soft fill', 'overcast through blinds'],
    composition: ['classic medium portrait', 'two-shot at the desk', 'detail of hand + document'],
    settings: ['warm wood-paneled office', 'modern minimal legal office', 'library or shelf-lined consultation room'],
  },
  // Fitness / wellness
  'fitness studio': {
    palettes: [
      ['matte black', 'electric lime', 'concrete grey'],
      ['warm grey', 'sunset orange', 'ivory'],
      ['forest green', 'warm white', 'dusty rose'],
    ],
    subject_archetypes: [
      'a member mid-movement, focused effort',
      'a coach demonstrating with care',
      'detail of equipment and form',
    ],
    moods: ['focused and energetic', 'community-warm and capable', 'considered and strong'],
    lighting: ['skylight natural', 'gym-side window light', 'evening warm tungsten'],
    composition: ['action mid-frame', 'medium portrait between sets', 'wide of the studio'],
    settings: ['minimal modern gym', 'reclaimed-wood boutique studio', 'outdoor track or park'],
  },
};

// Generic fallback for industries we don't have a template for
const GENERIC_VISUAL = {
  palettes: [
    ['warm neutral cream', 'graphite', 'soft accent'],
    ['ivory', 'navy', 'amber'],
    ['oat', 'forest green', 'rust'],
    ['cool grey', 'white', 'clear blue'],
  ],
  subject_archetypes: [
    'the founder at work, focused and human',
    'a customer interaction — candid moment',
    'a detail of the craft or product',
  ],
  moods: ['considered and human', 'approachable and capable', 'modern and warm'],
  lighting: ['soft natural daylight', 'warm-side window light', 'overcast diffused outdoor'],
  composition: ['medium portrait with negative space', 'environmental wide', 'detail close-up'],
  settings: ['real working environment', 'on-location natural', 'considered modern interior'],
};

function templateForIndustry(industry) {
  const norm = String(industry || '').toLowerCase().trim();
  if (INDUSTRY_VISUAL[norm]) return INDUSTRY_VISUAL[norm];
  // Loose match (e.g. "dentist" → "dental clinic")
  for (const [key, tpl] of Object.entries(INDUSTRY_VISUAL)) {
    if (norm.includes(key.split(' ')[0])) return tpl;
  }
  return GENERIC_VISUAL;
}

// ─── Build per-business visual DNA ──────────────────────────────────────

/**
 * Returns a deterministic visual DNA object unique to this business.
 * Same input = same output (consistency across regenerations).
 * Different businesses get different DNAs (no two customers look the same).
 *
 * Hash sources (concatenated → FNV-1a):
 *   business.id (most specific) || business.business_name + industry
 *
 * Variability:
 *   palettes × archetypes × moods × lighting × composition × settings
 *   = 3 × 3 × 3 × 3 × 3 × 3 = 729 combinations per industry, plus
 *   industry-driven variation across the 9+ industry templates.
 */
function buildVisualDna({ business, vocAnalysis } = {}) {
  if (!business) return _emptyDna();

  const seed = String(business.id || `${business.business_name || ''}::${business.industry || ''}`);
  const hash = fnv1a(seed.toLowerCase());

  const tpl = templateForIndustry(business.industry || business.business_type);

  // Pick deterministically from each axis
  const palette = pick(tpl.palettes, hash) || GENERIC_VISUAL.palettes[0];
  const subject = pick(tpl.subject_archetypes, hash >>> 3) || GENERIC_VISUAL.subject_archetypes[0];
  const mood = pick(tpl.moods, hash >>> 6) || GENERIC_VISUAL.moods[0];
  const lighting = pick(tpl.lighting, hash >>> 9) || GENERIC_VISUAL.lighting[0];
  const composition = pick(tpl.composition, hash >>> 12) || GENERIC_VISUAL.composition[0];
  const setting = pick(tpl.settings, hash >>> 15) || GENERIC_VISUAL.settings[0];

  // Tone descriptors influence mood overlay (warm/cool tilt)
  const toneTilt = (() => {
    const tones = (business?.tone_keywords || []).map((t) => String(t).toLowerCase());
    if (tones.some((t) => /warm|inviting|family|friendly|welcom/.test(t))) return 'warm';
    if (tones.some((t) => /modern|clean|sleek|minimal|premium/.test(t))) return 'cool';
    return null;
  })();

  // VOC-derived "vibe descriptors" if customer reviews have strong themes
  const vocVibe = (() => {
    if (!vocAnalysis?.themes) return null;
    const themes = Array.isArray(vocAnalysis.themes) ? vocAnalysis.themes : [];
    if (themes.some((t) => /family|kid|community/i.test(JSON.stringify(t)))) return 'family-warm';
    if (themes.some((t) => /fast|efficient|quick/i.test(JSON.stringify(t)))) return 'energetic-direct';
    if (themes.some((t) => /quality|craft|detail/i.test(JSON.stringify(t)))) return 'craft-driven';
    return null;
  })();

  return {
    palette,
    subject_archetype: subject,
    mood,
    tone_tilt: toneTilt,
    lighting,
    composition,
    setting,
    voc_vibe: vocVibe,
    seed_hash: hash,
    derived_from: business.id ? 'business_id' : 'business_name_industry',
    industry_template: INDUSTRY_VISUAL[String(business.industry || '').toLowerCase()]
      ? business.industry
      : 'generic',
  };
}

function _emptyDna() {
  return {
    palette: GENERIC_VISUAL.palettes[0],
    subject_archetype: GENERIC_VISUAL.subject_archetypes[0],
    mood: GENERIC_VISUAL.moods[0],
    tone_tilt: null,
    lighting: GENERIC_VISUAL.lighting[0],
    composition: GENERIC_VISUAL.composition[0],
    setting: GENERIC_VISUAL.settings[0],
    voc_vibe: null,
    seed_hash: 0,
    derived_from: 'fallback',
    industry_template: 'generic',
  };
}

// ─── Format for downstream prompts ──────────────────────────────────────

/**
 * Compact prompt suffix for Higgsfield (or any image-gen). Goes after the
 * primary subject/scene description. ~60–120 chars depending on inputs.
 */
function formatForHiggsfield(dna) {
  if (!dna) return '';
  const parts = [];
  parts.push(dna.subject_archetype);
  parts.push(`${dna.mood}${dna.tone_tilt ? `, ${dna.tone_tilt} tones` : ''}`);
  parts.push(dna.lighting);
  parts.push(dna.composition);
  parts.push(dna.setting);
  parts.push(`palette: ${dna.palette.join(', ')}`);
  if (dna.voc_vibe) parts.push(`feel: ${dna.voc_vibe}`);
  return parts.filter(Boolean).join(' · ');
}

/**
 * Human-readable LLM-injectable summary. For brand-voice-aware generators
 * that benefit from prose context.
 */
function formatForLlm(dna) {
  if (!dna) return '';
  return [
    `Visual brand DNA:`,
    `  Subject: ${dna.subject_archetype}`,
    `  Mood: ${dna.mood}${dna.tone_tilt ? ` (${dna.tone_tilt} tones)` : ''}`,
    `  Lighting: ${dna.lighting}`,
    `  Composition: ${dna.composition}`,
    `  Setting: ${dna.setting}`,
    `  Palette: ${dna.palette.join(', ')}`,
    dna.voc_vibe ? `  Customer-voice vibe: ${dna.voc_vibe}` : null,
    `  IMPORTANT: every visual asset for this business must honor this DNA. Do not regress to generic stock-image aesthetics.`,
  ].filter(Boolean).join('\n');
}

module.exports = {
  buildVisualDna,
  formatForHiggsfield,
  formatForLlm,
  INDUSTRY_VISUAL,
  GENERIC_VISUAL,
  templateForIndustry,
  // exposed for testing
  fnv1a,
};
