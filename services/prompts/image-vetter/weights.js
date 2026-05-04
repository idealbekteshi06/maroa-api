'use strict';

/**
 * Per-genre dimension weights for the image vetter.
 * Mirrors ~/.claude/skills/maroa-image-vetter/decision-criteria.md
 *
 * Dimensions: technical, composition, lighting, brand_alignment, genre_fit,
 *             marketing_suitability, safety, genuineness
 */

const COMMERCIAL_HEAVY = {
  technical: 1.4,
  composition: 1.3,
  lighting: 1.3,
  brand_alignment: 1.0,
  genre_fit: 1.0,
  marketing_suitability: 1.0,
  safety: 1.0,
  genuineness: 0.5
};

const UGC_HEAVY = {
  technical: 0.7,
  composition: 0.9,
  lighting: 0.9,
  brand_alignment: 1.3,
  genre_fit: 1.2,
  marketing_suitability: 1.0,
  safety: 1.0,
  genuineness: 1.5
};

const DOCUMENTARY_HEAVY = {
  technical: 1.0,
  composition: 1.1,
  lighting: 0.9,
  brand_alignment: 1.1,
  genre_fit: 1.3,
  marketing_suitability: 1.0,
  safety: 1.0,
  genuineness: 1.2
};

const ATMOSPHERE_HEAVY = {
  technical: 1.0,
  composition: 1.4,
  lighting: 1.4,
  brand_alignment: 1.0,
  genre_fit: 1.1,
  marketing_suitability: 0.8,
  safety: 1.0,
  genuineness: 0.8
};

const GENRE_WEIGHTS = {
  food_beverage: COMMERCIAL_HEAVY,
  product_ecommerce: COMMERCIAL_HEAVY,
  commercial_brand: COMMERCIAL_HEAVY,
  fashion_editorial: COMMERCIAL_HEAVY,
  lifestyle_social: UGC_HEAVY,
  testimonial_ugc: UGC_HEAVY,
  founder_intro: UGC_HEAVY,
  service_business: DOCUMENTARY_HEAVY,
  b2b_saas: DOCUMENTARY_HEAVY,
  before_after: DOCUMENTARY_HEAVY,
  location_establishing: ATMOSPHERE_HEAVY,
  seasonal_holiday: ATMOSPHERE_HEAVY
};

const DIMENSIONS = ['technical', 'composition', 'lighting', 'brand_alignment', 'genre_fit', 'marketing_suitability', 'safety', 'genuineness'];

function weightsFor(genre) {
  return GENRE_WEIGHTS[genre] || COMMERCIAL_HEAVY;
}

module.exports = { GENRE_WEIGHTS, DIMENSIONS, weightsFor, COMMERCIAL_HEAVY, UGC_HEAVY, DOCUMENTARY_HEAVY, ATMOSPHERE_HEAVY };
