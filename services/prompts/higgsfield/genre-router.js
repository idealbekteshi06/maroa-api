'use strict';

const GENRES = {
  product_ecommerce: {
    leadWith: 'subject',
    targetWords: [30, 50],
    cameraDefaults: ['Robo Arm', 'Lazy Susan', '360 Orbit', 'Macro Dolly In'],
    styleDefault: 'Cinematic commercial',
    colorGradeDefault: 'clean_commercial',
    lightingDefault: 'softbox',
    constraintCategories: ['texture_lighting', 'product_safety', 'temporal_consistency'],
    archetype: 'reveal',
    leadExample: 'A matte-black wireless earbud case rotates slowly on a marble pedestal...'
  },
  lifestyle_social: {
    leadWith: 'action',
    targetWords: [40, 60],
    cameraDefaults: ['Handheld', 'Selfie Angle', 'Dolly In', 'Snorricam'],
    styleDefault: 'Lifestyle',
    colorGradeDefault: 'warm_nostalgia',
    lightingDefault: 'golden_hour',
    constraintCategories: ['face_identity', 'texture_lighting'],
    archetype: 'atmosphere',
    leadExample: 'She reaches for the coffee mug, steam curling upward...'
  },
  commercial_brand: {
    leadWith: 'style',
    targetWords: [40, 70],
    cameraDefaults: ['Crane Up', 'Dolly In', 'Robo Arm', '360 Orbit'],
    styleDefault: 'Cinematic commercial',
    colorGradeDefault: 'clean_commercial',
    lightingDefault: 'softbox',
    constraintCategories: ['texture_lighting', 'temporal_consistency'],
    archetype: 'reveal',
    leadExample: 'Clean white studio, soft even lighting, product hero moment...'
  },
  testimonial_ugc: {
    leadWith: 'subject',
    targetWords: [40, 60],
    cameraDefaults: ['Selfie Angle', 'Handheld', 'Static'],
    styleDefault: 'Documentary',
    colorGradeDefault: 'documentary',
    lightingDefault: 'practical_only',
    constraintCategories: ['face_identity', 'temporal_consistency'],
    archetype: 'atmosphere',
    leadExample: 'A founder in their workshop, mid-sentence, hands gesturing...'
  },
  food_beverage: {
    leadWith: 'subject',
    targetWords: [30, 50],
    cameraDefaults: ['Macro Dolly In', 'Robo Arm', 'Overhead', 'Tilt Down'],
    styleDefault: 'Cinematic commercial',
    colorGradeDefault: 'warm_nostalgia',
    lightingDefault: 'side_lit',
    constraintCategories: ['texture_lighting', 'product_safety'],
    archetype: 'reveal',
    leadExample: 'Hot espresso pours into a ceramic cup, crema swirling...'
  },
  fashion_editorial: {
    leadWith: 'style',
    targetWords: [50, 80],
    cameraDefaults: ['Dolly In', 'Arc', '360 Orbit', 'Static'],
    styleDefault: 'Editorial',
    colorGradeDefault: 'cold_thriller',
    lightingDefault: 'side_lit',
    constraintCategories: ['face_identity', 'texture_lighting'],
    archetype: 'reveal',
    leadExample: 'Anamorphic flares, crushed blacks, 16mm grain...'
  },
  founder_intro: {
    leadWith: 'subject',
    targetWords: [40, 70],
    cameraDefaults: ['Dolly In', 'Static', 'Handheld', 'OTS'],
    styleDefault: 'Documentary',
    colorGradeDefault: 'documentary',
    lightingDefault: 'practical_only',
    constraintCategories: ['face_identity'],
    archetype: 'atmosphere',
    leadExample: 'The founder leans against the counter, arms crossed...'
  },
  location_establishing: {
    leadWith: 'scene',
    targetWords: [30, 60],
    cameraDefaults: ['Crane Up', 'FPV Drone', 'Hyperlapse', 'Dolly In'],
    styleDefault: 'Cinematic',
    colorGradeDefault: 'warm_nostalgia',
    lightingDefault: 'golden_hour',
    constraintCategories: ['texture_lighting'],
    archetype: 'journey',
    leadExample: 'Dawn breaks over the storefront, mist rolling through the street...'
  },
  before_after: {
    leadWith: 'subject',
    targetWords: [40, 70],
    cameraDefaults: ['Static', 'Dolly In', 'Match Cut'],
    styleDefault: 'Documentary',
    colorGradeDefault: 'clean_commercial',
    lightingDefault: 'softbox',
    constraintCategories: ['temporal_consistency'],
    archetype: 'reveal',
    leadExample: 'The same kitchen counter, before and after — match cut on the centerpiece...'
  },
  seasonal_holiday: {
    leadWith: 'scene',
    targetWords: [40, 70],
    cameraDefaults: ['Dolly In', 'Crane Up', 'Robo Arm'],
    styleDefault: 'Cinematic',
    colorGradeDefault: 'warm_nostalgia',
    lightingDefault: 'practical_only',
    constraintCategories: ['texture_lighting', 'face_identity'],
    archetype: 'atmosphere',
    leadExample: 'Soft snow falling outside the window, fairy lights glowing...'
  },
  service_business: {
    leadWith: 'subject',
    targetWords: [40, 60],
    cameraDefaults: ['Static', 'Handheld', 'Dolly In', 'OTS'],
    styleDefault: 'Documentary',
    colorGradeDefault: 'documentary',
    lightingDefault: 'practical_only',
    constraintCategories: ['face_identity', 'texture_lighting'],
    archetype: 'atmosphere',
    leadExample: 'A technician kneels by an open panel, headlamp on, hands working steadily...',
    note: 'For non-product service businesses (plumber, dentist, mechanic). Lead with the work itself — the action that solves the customer problem.'
  },
  b2b_saas: {
    leadWith: 'subject',
    targetWords: [40, 60],
    cameraDefaults: ['Static', 'Dolly In', 'OTS', 'Macro Dolly In'],
    styleDefault: 'Editorial',
    colorGradeDefault: 'cold_thriller',
    lightingDefault: 'softbox',
    constraintCategories: ['face_identity', 'texture_lighting'],
    archetype: 'atmosphere',
    leadExample: 'A laptop screen glows on a wood desk at blue hour, dashboard chart climbing...',
    note: 'For SaaS/B2B with no physical product. Hero is the founder, the workspace, or a screen-on-desk moment.'
  }
};

const INDUSTRY_KEYWORDS = {
  food_beverage: ['food', 'restaurant', 'cafe', 'bakery', 'brewery', 'bar', 'pub', 'beverage', 'drink', 'water', 'coffee', 'tea', 'juice', 'kombucha', 'wine', 'spirit', 'pizza', 'burger'],
  fashion_editorial: ['fashion', 'apparel', 'clothing', 'jewelry', 'jewellery', 'watch', 'shoe', 'sneaker', 'handbag', 'accessor'],
  beauty_skincare: ['beauty', 'cosmetic', 'skincare', 'makeup', 'fragrance', 'perfume', 'nail', 'hair care'],
  health_wellness: ['gym', 'fitness', 'yoga', 'pilates', 'wellness', 'spa', 'salon', 'barber', 'aesthetic', 'massage', 'nutrition', 'supplement', 'mindful'],
  medical_dental: ['dental', 'dentist', 'medical', 'clinic', 'doctor', 'physio', 'chiropract', 'therap', 'ortho'],
  local_service: ['plumb', 'electric', 'hvac', 'locksmith', 'cleaning', 'landscap', 'contractor', 'roofing', 'pest', 'mover', 'handyman', 'painter', 'carpent'],
  b2b_saas: ['saas', 'software', 'b2b', 'app', 'platform', 'api', 'devtool', 'agency', 'consulting'],
  professional_service: ['legal', 'lawyer', 'attorney', 'accountant', 'cpa', 'finance', 'insurance', 'mortgage', 'tax', 'bookkeep'],
  education_coach: ['coach', 'course', 'tutor', 'training', 'school', 'academy', 'mentor', 'education', 'workshop', 'masterclass'],
  automotive: ['auto', 'car', 'vehicle', 'tire', 'mechanic', 'detail', 'dealership'],
  real_estate: ['real estate', 'realtor', 'property', 'rental', 'broker', 'lease'],
  home_decor: ['furniture', 'decor', 'interior', 'home goods', 'lighting', 'rug', 'lamp'],
  pet: ['pet', 'vet', 'grooming', 'kennel', 'dog', 'cat'],
  events_hospitality: ['event', 'wedding', 'venue', 'hotel', 'catering', 'rental hall', 'florist', 'photographer'],
  art_handmade: ['art', 'handmade', 'crafts', 'pottery', 'maker', 'studio']
};

/**
 * Normalize input strings: lowercase + strip diacritics so that
 * "Café", "CAFE", "naïve", "Bödega" all match their ASCII keywords.
 */
function normalize(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function matchIndustry(industry) {
  for (const [key, words] of Object.entries(INDUSTRY_KEYWORDS)) {
    for (const w of words) if (industry.includes(w)) return key;
  }
  return null;
}

function classifyGenre(brandDNA, contentTheme) {
  const theme = normalize(contentTheme);
  const industry = normalize(brandDNA?.industry);

  if (theme.includes('testimonial') || theme.includes('review') || theme.includes('case study')) return 'testimonial_ugc';
  if (theme.includes('founder') || theme.includes('about us') || theme.includes('our story') || theme.includes('team intro')) return 'founder_intro';
  if (theme.includes('before') && theme.includes('after')) return 'before_after';
  if (theme.includes('transformation') || theme.includes('makeover')) return 'before_after';
  if (theme.includes('holiday') || theme.includes('season') || theme.includes('christmas') || theme.includes('ramadan') || theme.includes('eid') || theme.includes('valentine') || theme.includes('halloween')) return 'seasonal_holiday';
  if (theme.includes('day in the life') || theme.includes('routine') || theme.includes('a day with')) return 'lifestyle_social';
  if (theme.includes('location') || theme.includes('store tour') || theme.includes('shop tour') || theme.includes('office tour') || theme.includes('behind the scenes')) return 'location_establishing';

  const industryGenre = matchIndustry(industry);
  if (industryGenre === 'food_beverage') return 'food_beverage';
  if (industryGenre === 'fashion_editorial' || industryGenre === 'beauty_skincare') return 'fashion_editorial';
  if (industryGenre === 'local_service' || industryGenre === 'medical_dental') return 'service_business';
  if (industryGenre === 'b2b_saas' || industryGenre === 'professional_service') return 'b2b_saas';
  if (industryGenre === 'education_coach') return 'founder_intro';
  if (industryGenre === 'health_wellness') return 'lifestyle_social';
  if (industryGenre === 'automotive') return 'service_business';
  if (industryGenre === 'real_estate' || industryGenre === 'events_hospitality') return 'location_establishing';
  if (industryGenre === 'home_decor' || industryGenre === 'art_handmade') return 'product_ecommerce';
  if (industryGenre === 'pet') return 'lifestyle_social';

  if (theme.includes('ugc') || theme.includes('social') || theme.includes('reel') || theme.includes('tiktok') || theme.includes('story')) return 'lifestyle_social';
  if (theme.includes('hero') || theme.includes('ad') || theme.includes('commercial') || theme.includes('campaign')) return 'commercial_brand';
  return 'product_ecommerce';
}

function getGenre(name) {
  return GENRES[name] || GENRES.product_ecommerce;
}

module.exports = { GENRES, classifyGenre, getGenre };
