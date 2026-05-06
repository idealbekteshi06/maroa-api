'use strict';

/**
 * services/prompts/brand-voice/industry-defaults.js
 * ----------------------------------------------------------------------------
 * Industry-default brand-voice profiles. Used when onboarding + VOC data are
 * insufficient to derive a custom voice — better than generic defaults.
 *
 * Each industry has empirically-grounded defaults from how successful brands in
 * that vertical actually communicate.
 * ----------------------------------------------------------------------------
 */

const INDUSTRY_DEFAULTS = {
  // Food & beverage — warm, sensory, family-narrative
  cafe: {
    tone_descriptors: ['warm', 'inviting', 'unpretentious'],
    voice_register: 'casual-conversational',
    sentence_length_preference: 'short',
    vocabulary_style: 'everyday',
    do_words: ['fresh', 'made today', 'family', 'hand-picked', 'morning', 'roasted'],
    do_not_words: ['leverage', 'world-class', 'innovative', 'optimize', 'streamline'],
    punctuation_style: 'minimal',
    formality_level: 3,
    humor_level: 4,
    industry_metaphors_allowed: ['food-sensory', 'family-tradition', 'craftsmanship'],
  },
  restaurant: {
    tone_descriptors: ['warm', 'sensory', 'inviting'],
    voice_register: 'casual-conversational',
    sentence_length_preference: 'short',
    vocabulary_style: 'everyday',
    do_words: ['fresh', 'in-season', 'house-made', 'tonight'],
    do_not_words: ['leverage', 'world-class', 'optimize'],
    punctuation_style: 'minimal',
    formality_level: 4,
    humor_level: 4,
    industry_metaphors_allowed: ['food-sensory', 'craftsmanship'],
  },
  bar: {
    tone_descriptors: ['relaxed', 'inviting', 'a bit rebellious'],
    voice_register: 'casual-playful',
    sentence_length_preference: 'short',
    vocabulary_style: 'everyday',
    do_words: ['cold', 'after work', 'late', 'tonight', 'on tap'],
    do_not_words: ['leverage', 'world-class', 'innovative'],
    punctuation_style: 'minimal',
    formality_level: 2,
    humor_level: 6,
    industry_metaphors_allowed: ['nightlife', 'craftsmanship'],
  },

  // Health & wellness — authoritative, clear, never casual about safety
  dental: {
    tone_descriptors: ['professional', 'reassuring', 'precise'],
    voice_register: 'professional',
    sentence_length_preference: 'medium',
    vocabulary_style: 'industry-jargon',
    do_words: ['gentle', 'modern', 'pain-free', 'consultation', 'appointment'],
    do_not_words: ['leverage', 'cutting-edge', 'world-class', 'game-changing'],
    punctuation_style: 'standard',
    formality_level: 7,
    humor_level: 1,
    industry_metaphors_allowed: ['none-clinical-only'],
  },
  clinic: {
    tone_descriptors: ['caring', 'professional', 'clear'],
    voice_register: 'professional',
    sentence_length_preference: 'medium',
    vocabulary_style: 'everyday',
    do_words: ['care', 'consultation', 'specialist', 'appointment'],
    do_not_words: ['leverage', 'cutting-edge', 'innovative'],
    punctuation_style: 'standard',
    formality_level: 7,
    humor_level: 1,
    industry_metaphors_allowed: ['none-clinical-only'],
  },
  gym: {
    tone_descriptors: ['motivating', 'direct', 'results-focused'],
    voice_register: 'casual-playful',
    sentence_length_preference: 'short',
    vocabulary_style: 'everyday',
    do_words: ['stronger', 'today', 'reps', 'progress', 'results'],
    do_not_words: ['leverage', 'innovative', 'cutting-edge'],
    punctuation_style: 'minimal',
    formality_level: 2,
    humor_level: 5,
    industry_metaphors_allowed: ['athletic', 'progress-journey'],
  },

  // Retail / boutique — quality + craft
  boutique: {
    tone_descriptors: ['curated', 'tasteful', 'understated'],
    voice_register: 'professional',
    sentence_length_preference: 'mixed',
    vocabulary_style: 'luxury',
    do_words: ['curated', 'limited', 'crafted', 'hand-picked', 'rare'],
    do_not_words: ['leverage', 'cutting-edge', 'world-class', 'optimize', 'epic'],
    punctuation_style: 'em-dash-heavy',
    formality_level: 6,
    humor_level: 2,
    industry_metaphors_allowed: ['craftsmanship', 'art', 'tradition'],
  },
  retail: {
    tone_descriptors: ['friendly', 'practical', 'helpful'],
    voice_register: 'casual-conversational',
    sentence_length_preference: 'short',
    vocabulary_style: 'everyday',
    do_words: ['new', 'in stock', 'this week', 'sale', 'arrival'],
    do_not_words: ['leverage', 'cutting-edge', 'innovative'],
    punctuation_style: 'standard',
    formality_level: 4,
    humor_level: 3,
    industry_metaphors_allowed: ['practical', 'value'],
  },

  // Service businesses
  plumber: {
    tone_descriptors: ['practical', 'reliable', 'no-bullshit'],
    voice_register: 'casual-conversational',
    sentence_length_preference: 'short',
    vocabulary_style: 'everyday',
    do_words: ['fast', 'fixed', 'on-time', 'guaranteed', '24/7'],
    do_not_words: ['leverage', 'innovative', 'world-class', 'cutting-edge'],
    punctuation_style: 'minimal',
    formality_level: 3,
    humor_level: 3,
    industry_metaphors_allowed: ['practical', 'fix-it'],
  },
  contractor: {
    tone_descriptors: ['reliable', 'straightforward', 'experienced'],
    voice_register: 'professional',
    sentence_length_preference: 'medium',
    vocabulary_style: 'everyday',
    do_words: ['done right', 'on schedule', 'licensed', 'experienced'],
    do_not_words: ['leverage', 'cutting-edge', 'innovative'],
    punctuation_style: 'standard',
    formality_level: 5,
    humor_level: 2,
    industry_metaphors_allowed: ['craftsmanship', 'practical'],
  },

  // Tech / SaaS — modern but not buzzwordy
  saas: {
    tone_descriptors: ['clear', 'helpful', 'confident'],
    voice_register: 'professional-conversational',
    sentence_length_preference: 'short',
    vocabulary_style: 'industry-jargon',
    do_words: ['ship', 'works', 'today', 'integrated', 'connected'],
    do_not_words: ['leverage', 'world-class', 'cutting-edge', 'innovative', 'synergy', 'paradigm', 'disruptive'],
    punctuation_style: 'minimal',
    formality_level: 4,
    humor_level: 3,
    industry_metaphors_allowed: ['practical', 'building'],
  },
  software: {
    tone_descriptors: ['clear', 'practical', 'specific'],
    voice_register: 'professional-conversational',
    sentence_length_preference: 'short',
    vocabulary_style: 'industry-jargon',
    do_words: ['ship', 'works', 'integrated', 'today'],
    do_not_words: ['leverage', 'world-class', 'cutting-edge'],
    punctuation_style: 'minimal',
    formality_level: 4,
    humor_level: 3,
    industry_metaphors_allowed: ['practical', 'building'],
  },

  // Beauty / spa
  salon: {
    tone_descriptors: ['warm', 'pampering', 'expert'],
    voice_register: 'casual-conversational',
    sentence_length_preference: 'mixed',
    vocabulary_style: 'everyday',
    do_words: ['relax', 'pamper', 'fresh', 'transformation', 'glow'],
    do_not_words: ['leverage', 'cutting-edge', 'innovative'],
    punctuation_style: 'standard',
    formality_level: 4,
    humor_level: 4,
    industry_metaphors_allowed: ['transformation', 'self-care'],
  },
  spa: {
    tone_descriptors: ['serene', 'restorative', 'calm'],
    voice_register: 'professional',
    sentence_length_preference: 'long-flowing',
    vocabulary_style: 'luxury',
    do_words: ['retreat', 'restore', 'unwind', 'sanctuary'],
    do_not_words: ['leverage', 'cutting-edge', 'optimize'],
    punctuation_style: 'minimal',
    formality_level: 6,
    humor_level: 1,
    industry_metaphors_allowed: ['nature', 'restoration'],
  },

  // Real estate
  realestate: {
    tone_descriptors: ['knowledgeable', 'trustworthy', 'efficient'],
    voice_register: 'professional',
    sentence_length_preference: 'medium',
    vocabulary_style: 'everyday',
    do_words: ['available', 'priced', 'square meters', 'view', 'tour'],
    do_not_words: ['leverage', 'cutting-edge', 'innovative', 'world-class'],
    punctuation_style: 'standard',
    formality_level: 6,
    humor_level: 1,
    industry_metaphors_allowed: ['property', 'investment'],
  },
};

const GENERIC_FALLBACK = {
  tone_descriptors: ['clear', 'direct', 'helpful'],
  voice_register: 'professional-conversational',
  sentence_length_preference: 'short',
  vocabulary_style: 'everyday',
  do_words: ['today', 'specific', 'real'],
  do_not_words: ['leverage', 'world-class', 'cutting-edge', 'innovative', 'synergy', 'navigate the complexities'],
  punctuation_style: 'minimal',
  formality_level: 5,
  humor_level: 3,
  industry_metaphors_allowed: ['practical'],
};

/**
 * Get industry default by industry/business_type string. Fuzzy-match.
 */
function defaultsForIndustry(industry) {
  if (!industry || typeof industry !== 'string') return GENERIC_FALLBACK;
  const key = industry.toLowerCase().trim();

  // Direct match
  if (INDUSTRY_DEFAULTS[key]) return INDUSTRY_DEFAULTS[key];

  // Fuzzy match by keyword
  const aliases = {
    cafe: ['coffee', 'cafeteria', 'kafja', 'kaffeehaus', 'café'],
    restaurant: ['food', 'dining', 'kitchen', 'eatery', 'bistro', 'restorant'],
    bar: ['pub', 'cocktail', 'lounge', 'tavern'],
    dental: ['dentist', 'orthodontic', 'oral', 'tooth'],
    clinic: ['medical', 'doctor', 'health center', 'urgent care', 'medic'],
    gym: ['fitness', 'crossfit', 'pilates', 'yoga', 'training', 'palestra'],
    boutique: ['fashion', 'apparel', 'jewelry', 'luxury'],
    retail: ['shop', 'store', 'market'],
    plumber: ['plumbing', 'pipe', 'drain'],
    contractor: ['construction', 'remodel', 'builder', 'roofing', 'electrician'],
    saas: ['software service', 'b2b platform', 'cloud platform'],
    software: ['app', 'tool', 'platform', 'tech'],
    salon: ['hair', 'barber', 'beauty'],
    spa: ['wellness', 'massage'],
    realestate: ['real estate', 'realtor', 'broker', 'property', 'rental'],
  };

  for (const [canonical, aliasList] of Object.entries(aliases)) {
    if (aliasList.some(a => key.includes(a))) {
      return INDUSTRY_DEFAULTS[canonical];
    }
  }

  return GENERIC_FALLBACK;
}

module.exports = {
  INDUSTRY_DEFAULTS,
  GENERIC_FALLBACK,
  defaultsForIndustry,
};
