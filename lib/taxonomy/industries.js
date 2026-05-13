'use strict';

/**
 * lib/taxonomy/industries.js
 * ---------------------------------------------------------------------------
 * Canonical industry taxonomy for the marketing corpus pre-trainer (ADR-0008).
 * ~50 verticals covering ~95% of SMB businesses, aligned with IAB Content
 * Taxonomy v3 where applicable.
 *
 * Each entry has:
 *   id              canonical key — used in DB rows + retrieval queries
 *   label           human-readable
 *   parent          hierarchy group (for "expanding circles" retrieval)
 *   seedKeywords    queries the pre-trainer uses to find ads/content
 *   peerIndustries  related verticals — cohort fallback when same-industry
 *                   corpus rows are sparse (a café falls back to restaurant)
 *   formats         which corpus formats are highest-leverage for this vertical
 *
 * Changes here bump the corpus row's `taxonomy_version` field so the
 * grounding library can stay backwards compatible.
 */

const VERSION = 'v1';

const INDUSTRIES = [
  // ─── Food & Hospitality ──────────────────────────────────────────────
  {
    id: 'cafe',
    label: 'Café / Coffee Shop',
    parent: 'food_hospitality',
    seedKeywords: ['cafe marketing', 'coffee shop ads', 'specialty coffee promotion', 'brunch cafe'],
    peerIndustries: ['restaurant', 'bakery', 'dessert_shop'],
    formats: ['meta_ad', 'social_post', 'google_ad', 'seo_article'],
  },
  {
    id: 'restaurant',
    label: 'Restaurant',
    parent: 'food_hospitality',
    seedKeywords: ['restaurant ads', 'restaurant marketing', 'casual dining promotion', 'fine dining campaign'],
    peerIndustries: ['cafe', 'bar_lounge', 'food_truck'],
    formats: ['meta_ad', 'social_post', 'google_ad', 'seo_article'],
  },
  {
    id: 'bar_lounge',
    label: 'Bar / Lounge / Nightlife',
    parent: 'food_hospitality',
    seedKeywords: ['bar ads', 'cocktail lounge marketing', 'happy hour promotion', 'nightclub ads'],
    peerIndustries: ['restaurant', 'cafe'],
    formats: ['meta_ad', 'social_post'],
  },
  {
    id: 'bakery',
    label: 'Bakery / Pastry Shop',
    parent: 'food_hospitality',
    seedKeywords: ['bakery marketing', 'artisan bakery ads', 'custom cake promotion'],
    peerIndustries: ['cafe', 'dessert_shop'],
    formats: ['meta_ad', 'social_post', 'google_ad'],
  },
  {
    id: 'food_truck',
    label: 'Food Truck / Delivery Kitchen',
    parent: 'food_hospitality',
    seedKeywords: ['food truck marketing', 'ghost kitchen ads', 'food delivery promotion'],
    peerIndustries: ['restaurant', 'cafe'],
    formats: ['meta_ad', 'social_post'],
  },
  {
    id: 'dessert_shop',
    label: 'Ice Cream / Dessert Shop',
    parent: 'food_hospitality',
    seedKeywords: ['ice cream shop ads', 'dessert marketing', 'gelato promotion'],
    peerIndustries: ['cafe', 'bakery'],
    formats: ['meta_ad', 'social_post'],
  },
  {
    id: 'hotel_hospitality',
    label: 'Hotel / B&B / Hospitality',
    parent: 'food_hospitality',
    seedKeywords: ['hotel marketing', 'boutique hotel ads', 'bnb promotion', 'hospitality campaign'],
    peerIndustries: ['tourism_travel', 'restaurant'],
    formats: ['meta_ad', 'google_ad', 'landing_page', 'seo_article'],
  },

  // ─── Fitness & Wellness ──────────────────────────────────────────────
  {
    id: 'gym_fitness',
    label: 'Gym / Fitness Studio',
    parent: 'fitness_wellness',
    seedKeywords: ['gym marketing', 'fitness studio ads', 'personal training promotion', 'crossfit ads'],
    peerIndustries: ['yoga_pilates', 'sports_recreation'],
    formats: ['meta_ad', 'social_post', 'landing_page'],
  },
  {
    id: 'yoga_pilates',
    label: 'Yoga / Pilates Studio',
    parent: 'fitness_wellness',
    seedKeywords: ['yoga studio marketing', 'pilates ads', 'wellness retreat promotion'],
    peerIndustries: ['gym_fitness', 'wellness_spa'],
    formats: ['meta_ad', 'social_post', 'landing_page'],
  },
  {
    id: 'wellness_spa',
    label: 'Spa / Wellness Center',
    parent: 'fitness_wellness',
    seedKeywords: ['spa marketing', 'wellness retreat ads', 'massage therapy promotion'],
    peerIndustries: ['salon_beauty', 'yoga_pilates'],
    formats: ['meta_ad', 'social_post', 'landing_page'],
  },
  {
    id: 'salon_beauty',
    label: 'Salon / Beauty / Barbershop',
    parent: 'fitness_wellness',
    seedKeywords: ['hair salon marketing', 'beauty salon ads', 'barbershop promotion', 'nail salon'],
    peerIndustries: ['wellness_spa', 'cosmetics_brand'],
    formats: ['meta_ad', 'social_post', 'google_ad'],
  },
  {
    id: 'dental_practice',
    label: 'Dental Practice',
    parent: 'healthcare',
    seedKeywords: ['dental practice marketing', 'dentist ads', 'orthodontics promotion'],
    peerIndustries: ['medical_clinic', 'healthcare_general'],
    formats: ['meta_ad', 'google_ad', 'landing_page'],
  },
  {
    id: 'medical_clinic',
    label: 'Medical Clinic / Specialty Practice',
    parent: 'healthcare',
    seedKeywords: ['medical clinic marketing', 'specialty clinic ads', 'healthcare provider'],
    peerIndustries: ['dental_practice', 'healthcare_general'],
    formats: ['meta_ad', 'google_ad', 'landing_page'],
  },
  {
    id: 'healthcare_general',
    label: 'Healthcare General',
    parent: 'healthcare',
    seedKeywords: ['healthcare marketing', 'telehealth ads', 'patient acquisition'],
    peerIndustries: ['medical_clinic', 'dental_practice'],
    formats: ['meta_ad', 'google_ad', 'landing_page', 'seo_article'],
  },
  {
    id: 'mental_health',
    label: 'Mental Health / Therapy Practice',
    parent: 'healthcare',
    seedKeywords: ['therapy practice marketing', 'mental health ads', 'counseling promotion'],
    peerIndustries: ['healthcare_general', 'wellness_spa'],
    formats: ['meta_ad', 'landing_page', 'seo_article'],
  },

  // ─── Trades & Local Services ────────────────────────────────────────
  {
    id: 'plumber',
    label: 'Plumber',
    parent: 'home_services',
    seedKeywords: ['plumber marketing', 'emergency plumber ads', 'plumbing service promotion'],
    peerIndustries: ['electrician', 'hvac', 'home_repair_general'],
    formats: ['google_ad', 'landing_page', 'seo_article'],
  },
  {
    id: 'electrician',
    label: 'Electrician',
    parent: 'home_services',
    seedKeywords: ['electrician marketing', 'electrical contractor ads'],
    peerIndustries: ['plumber', 'hvac'],
    formats: ['google_ad', 'landing_page'],
  },
  {
    id: 'hvac',
    label: 'HVAC / Heating & Cooling',
    parent: 'home_services',
    seedKeywords: ['hvac marketing', 'ac repair ads', 'furnace install promotion'],
    peerIndustries: ['plumber', 'electrician'],
    formats: ['google_ad', 'landing_page'],
  },
  {
    id: 'home_repair_general',
    label: 'Home Repair / Handyman',
    parent: 'home_services',
    seedKeywords: ['handyman ads', 'home repair marketing', 'contractor promotion'],
    peerIndustries: ['plumber', 'electrician', 'hvac'],
    formats: ['google_ad', 'landing_page'],
  },
  {
    id: 'landscaping',
    label: 'Landscaping / Lawn Care',
    parent: 'home_services',
    seedKeywords: ['landscaping ads', 'lawn care marketing', 'garden design promotion'],
    peerIndustries: ['home_repair_general'],
    formats: ['meta_ad', 'google_ad', 'landing_page'],
  },
  {
    id: 'cleaning_service',
    label: 'Cleaning Service',
    parent: 'home_services',
    seedKeywords: ['cleaning service marketing', 'house cleaning ads', 'commercial cleaning'],
    peerIndustries: ['home_repair_general'],
    formats: ['meta_ad', 'google_ad', 'landing_page'],
  },
  {
    id: 'auto_repair',
    label: 'Auto Repair / Mechanic',
    parent: 'automotive',
    seedKeywords: ['auto repair marketing', 'mechanic ads', 'car service promotion'],
    peerIndustries: ['auto_detail'],
    formats: ['google_ad', 'landing_page', 'seo_article'],
  },
  {
    id: 'auto_detail',
    label: 'Auto Detailing / Car Wash',
    parent: 'automotive',
    seedKeywords: ['car detailing ads', 'auto detail marketing', 'ceramic coating promotion'],
    peerIndustries: ['auto_repair'],
    formats: ['meta_ad', 'social_post', 'google_ad'],
  },

  // ─── Professional Services ───────────────────────────────────────────
  {
    id: 'accountant',
    label: 'Accounting / CPA Firm',
    parent: 'professional_services',
    seedKeywords: ['accountant marketing', 'cpa firm ads', 'tax preparation promotion'],
    peerIndustries: ['bookkeeper', 'legal_practice'],
    formats: ['google_ad', 'landing_page', 'seo_article'],
  },
  {
    id: 'bookkeeper',
    label: 'Bookkeeper',
    parent: 'professional_services',
    seedKeywords: ['bookkeeping service marketing', 'virtual bookkeeper ads'],
    peerIndustries: ['accountant'],
    formats: ['google_ad', 'landing_page'],
  },
  {
    id: 'legal_practice',
    label: 'Law Firm / Legal Practice',
    parent: 'professional_services',
    seedKeywords: ['law firm marketing', 'attorney ads', 'legal practice promotion'],
    peerIndustries: ['accountant'],
    formats: ['google_ad', 'landing_page', 'seo_article'],
  },
  {
    id: 'real_estate_agent',
    label: 'Real Estate Agent / Brokerage',
    parent: 'professional_services',
    seedKeywords: ['real estate agent marketing', 'realtor ads', 'brokerage promotion'],
    peerIndustries: ['mortgage_broker'],
    formats: ['meta_ad', 'social_post', 'landing_page'],
  },
  {
    id: 'mortgage_broker',
    label: 'Mortgage Broker / Lender',
    parent: 'professional_services',
    seedKeywords: ['mortgage broker marketing', 'home loan ads', 'refinance promotion'],
    peerIndustries: ['real_estate_agent'],
    formats: ['google_ad', 'landing_page'],
  },
  {
    id: 'insurance_agency',
    label: 'Insurance Agency',
    parent: 'professional_services',
    seedKeywords: ['insurance agency marketing', 'life insurance ads', 'auto insurance promotion'],
    peerIndustries: ['financial_advisor'],
    formats: ['google_ad', 'landing_page'],
  },
  {
    id: 'financial_advisor',
    label: 'Financial Advisor / Wealth Mgmt',
    parent: 'professional_services',
    seedKeywords: ['financial advisor marketing', 'wealth management ads'],
    peerIndustries: ['insurance_agency', 'accountant'],
    formats: ['google_ad', 'landing_page', 'seo_article'],
  },
  {
    id: 'marketing_agency',
    label: 'Marketing / Creative Agency',
    parent: 'professional_services',
    seedKeywords: ['marketing agency ads', 'creative agency promotion', 'agency new business'],
    peerIndustries: ['consulting_firm'],
    formats: ['meta_ad', 'landing_page', 'social_post'],
  },
  {
    id: 'consulting_firm',
    label: 'Consulting Firm',
    parent: 'professional_services',
    seedKeywords: ['consulting firm marketing', 'management consulting ads'],
    peerIndustries: ['marketing_agency'],
    formats: ['landing_page', 'seo_article'],
  },

  // ─── E-commerce ──────────────────────────────────────────────────────
  {
    id: 'ecommerce_apparel',
    label: 'E-commerce — Apparel / Fashion',
    parent: 'ecommerce',
    seedKeywords: ['fashion brand ads', 'apparel ecommerce marketing', 'dtc clothing'],
    peerIndustries: ['ecommerce_jewelry', 'cosmetics_brand'],
    formats: ['meta_ad', 'social_post', 'email'],
  },
  {
    id: 'ecommerce_beauty',
    label: 'E-commerce — Beauty / Skincare',
    parent: 'ecommerce',
    seedKeywords: ['beauty brand ads', 'skincare ecommerce', 'cosmetics dtc'],
    peerIndustries: ['cosmetics_brand', 'salon_beauty'],
    formats: ['meta_ad', 'social_post', 'email'],
  },
  {
    id: 'cosmetics_brand',
    label: 'Cosmetics / Skincare Brand',
    parent: 'ecommerce',
    seedKeywords: ['cosmetics marketing', 'skincare brand ads', 'beauty influencer'],
    peerIndustries: ['ecommerce_beauty', 'salon_beauty'],
    formats: ['meta_ad', 'social_post', 'email'],
  },
  {
    id: 'ecommerce_homewares',
    label: 'E-commerce — Home / Furniture',
    parent: 'ecommerce',
    seedKeywords: ['home decor ads', 'furniture ecommerce', 'homewares dtc'],
    peerIndustries: ['ecommerce_apparel'],
    formats: ['meta_ad', 'social_post', 'email'],
  },
  {
    id: 'ecommerce_jewelry',
    label: 'E-commerce — Jewelry / Accessories',
    parent: 'ecommerce',
    seedKeywords: ['jewelry brand ads', 'jewelry ecommerce marketing'],
    peerIndustries: ['ecommerce_apparel'],
    formats: ['meta_ad', 'social_post', 'email'],
  },
  {
    id: 'ecommerce_food',
    label: 'E-commerce — Food / CPG',
    parent: 'ecommerce',
    seedKeywords: ['cpg brand ads', 'food ecommerce marketing', 'dtc snack'],
    peerIndustries: ['ecommerce_apparel'],
    formats: ['meta_ad', 'social_post', 'email'],
  },
  {
    id: 'ecommerce_supplements',
    label: 'E-commerce — Supplements / Wellness',
    parent: 'ecommerce',
    seedKeywords: ['supplement brand ads', 'wellness ecommerce', 'vitamin marketing'],
    peerIndustries: ['ecommerce_beauty'],
    formats: ['meta_ad', 'landing_page', 'email'],
  },
  {
    id: 'ecommerce_pet',
    label: 'E-commerce — Pet Products',
    parent: 'ecommerce',
    seedKeywords: ['pet brand ads', 'pet ecommerce', 'dog product marketing'],
    peerIndustries: ['ecommerce_food'],
    formats: ['meta_ad', 'social_post', 'email'],
  },

  // ─── SaaS & B2B ──────────────────────────────────────────────────────
  {
    id: 'saas_b2b',
    label: 'SaaS — B2B',
    parent: 'software',
    seedKeywords: ['b2b saas ads', 'enterprise software marketing', 'saas demo signup'],
    peerIndustries: ['saas_b2c', 'agency_b2b'],
    formats: ['google_ad', 'landing_page', 'email', 'seo_article'],
  },
  {
    id: 'saas_b2c',
    label: 'SaaS — B2C / Prosumer',
    parent: 'software',
    seedKeywords: ['b2c saas ads', 'consumer app marketing', 'productivity app promotion'],
    peerIndustries: ['saas_b2b', 'mobile_app'],
    formats: ['meta_ad', 'google_ad', 'landing_page'],
  },
  {
    id: 'mobile_app',
    label: 'Mobile App',
    parent: 'software',
    seedKeywords: ['mobile app marketing', 'app install ads', 'freemium app promotion'],
    peerIndustries: ['saas_b2c'],
    formats: ['meta_ad', 'social_post'],
  },
  {
    id: 'agency_b2b',
    label: 'Agency Services — B2B',
    parent: 'professional_services',
    seedKeywords: ['b2b agency marketing', 'lead gen agency ads', 'demand gen'],
    peerIndustries: ['marketing_agency', 'consulting_firm'],
    formats: ['landing_page', 'seo_article', 'email'],
  },

  // ─── Education ───────────────────────────────────────────────────────
  {
    id: 'online_course',
    label: 'Online Course / Cohort Program',
    parent: 'education',
    seedKeywords: ['online course ads', 'cohort program marketing', 'skill course promotion'],
    peerIndustries: ['coaching_personal', 'education_general'],
    formats: ['meta_ad', 'landing_page', 'email'],
  },
  {
    id: 'coaching_personal',
    label: 'Personal Coaching / Mentorship',
    parent: 'education',
    seedKeywords: ['life coach marketing', 'business coach ads', 'executive coaching'],
    peerIndustries: ['online_course'],
    formats: ['meta_ad', 'social_post', 'landing_page'],
  },
  {
    id: 'tutoring_k12',
    label: 'Tutoring — K-12 / Test Prep',
    parent: 'education',
    seedKeywords: ['tutoring service marketing', 'sat prep ads', 'test prep promotion'],
    peerIndustries: ['education_general'],
    formats: ['google_ad', 'landing_page'],
  },
  {
    id: 'education_general',
    label: 'Education General',
    parent: 'education',
    seedKeywords: ['education marketing', 'school enrollment ads', 'university promotion'],
    peerIndustries: ['online_course', 'tutoring_k12'],
    formats: ['google_ad', 'landing_page', 'seo_article'],
  },

  // ─── Travel & Recreation ─────────────────────────────────────────────
  {
    id: 'tourism_travel',
    label: 'Tourism / Travel Agency',
    parent: 'travel',
    seedKeywords: ['travel agency marketing', 'tourism ads', 'tour operator promotion'],
    peerIndustries: ['hotel_hospitality'],
    formats: ['meta_ad', 'social_post', 'landing_page'],
  },
  {
    id: 'sports_recreation',
    label: 'Sports / Outdoor Recreation',
    parent: 'recreation',
    seedKeywords: ['sports gear ads', 'outdoor recreation marketing', 'climbing gym promotion'],
    peerIndustries: ['gym_fitness'],
    formats: ['meta_ad', 'social_post'],
  },

  // ─── Events & Photography ────────────────────────────────────────────
  {
    id: 'event_planning',
    label: 'Event Planning / Wedding',
    parent: 'events',
    seedKeywords: ['wedding planner marketing', 'event planner ads', 'corporate events'],
    peerIndustries: ['photography_studio', 'catering'],
    formats: ['meta_ad', 'social_post', 'landing_page'],
  },
  {
    id: 'photography_studio',
    label: 'Photography Studio',
    parent: 'events',
    seedKeywords: ['photographer marketing', 'wedding photographer ads', 'portrait studio'],
    peerIndustries: ['event_planning'],
    formats: ['meta_ad', 'social_post'],
  },
  {
    id: 'catering',
    label: 'Catering Service',
    parent: 'events',
    seedKeywords: ['catering service marketing', 'corporate catering ads'],
    peerIndustries: ['restaurant', 'event_planning'],
    formats: ['meta_ad', 'google_ad', 'landing_page'],
  },

  // ─── Catch-all ───────────────────────────────────────────────────────
  {
    id: 'smb_general',
    label: 'SMB General — Other',
    parent: null,
    seedKeywords: ['small business marketing', 'smb ads'],
    peerIndustries: [],
    formats: ['meta_ad', 'google_ad', 'landing_page', 'seo_article'],
  },
];

const _byId = new Map(INDUSTRIES.map((i) => [i.id, i]));

function getById(id) {
  return _byId.get(id) || null;
}

function getAllIds() {
  return INDUSTRIES.map((i) => i.id);
}

/**
 * Expanding-circles industry list — used by the grounding library to
 * progressively widen retrieval when the most-specific bucket is sparse.
 *
 * Example: getExpandingCircles('cafe')
 *   → ['cafe', 'restaurant', 'bakery', 'dessert_shop', 'smb_general']
 *
 * Order: self, peers, smb_general fallback.
 */
function getExpandingCircles(id) {
  const ind = getById(id);
  if (!ind) return ['smb_general'];
  const out = [id];
  for (const peer of ind.peerIndustries || []) {
    if (!out.includes(peer)) out.push(peer);
  }
  if (!out.includes('smb_general')) out.push('smb_general');
  return out;
}

module.exports = {
  VERSION,
  INDUSTRIES,
  getById,
  getAllIds,
  getExpandingCircles,
};
