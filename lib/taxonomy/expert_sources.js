'use strict';

/**
 * lib/taxonomy/expert_sources.js
 * ---------------------------------------------------------------------------
 * Curated catalog of "expert sources" — brands, accounts, publications, and
 * award archives whose marketing output we treat as gold-standard training
 * signal for the corpus pre-trainer.
 *
 * Why curated > random: a random Meta Ad Library scrape gives us mostly
 * noise — 90% of advertisers are mediocre. To make the corpus EXPERT-LEVEL
 * we explicitly seed it from:
 *
 *   - Brands with proven retention + scale ($50M+ ad spend)
 *   - Award winners (Cannes Lions, Effie, OneShow, D&AD)
 *   - DTC darlings widely studied for craft (Liquid Death, Allbirds, etc.)
 *   - Marketing publications that curate "what worked"
 *
 * The orchestrator queries Meta Ad Library / Google Ads Transparency for
 * THESE PAGE NAMES first, then fills in long-tail by industry keyword.
 * Result: the corpus is biased toward known-good examples.
 */

const VERSION = 'v1';

// ─── Award archives (highest quality signal) ─────────────────────────
const AWARD_ARCHIVES = [
  {
    id: 'cannes_lions',
    label: 'Cannes Lions',
    url: 'https://www.canneslions.com/',
    coverage: 'global',
    industries: ['all'],
    qualityScore: 0.95,
  },
  {
    id: 'effie_global',
    label: 'Effie Awards (Global)',
    url: 'https://www.effie.org/',
    coverage: 'global',
    industries: ['all'],
    qualityScore: 0.92,
  },
  {
    id: 'oneshow',
    label: 'The One Show',
    url: 'https://www.oneshow.org/',
    coverage: 'global',
    industries: ['all'],
    qualityScore: 0.9,
  },
  {
    id: 'dnad',
    label: 'D&AD Awards',
    url: 'https://www.dandad.org/',
    coverage: 'global',
    industries: ['all'],
    qualityScore: 0.9,
  },
  {
    id: 'modern_retail_awards',
    label: 'Modern Retail Awards',
    url: 'https://www.modernretail.co/awards/',
    coverage: 'NA',
    industries: ['ecommerce_apparel', 'ecommerce_beauty', 'ecommerce_food', 'ecommerce_homewares'],
    qualityScore: 0.85,
  },
];

// ─── Marketing publications (curated "what worked" examples) ─────────
const PUBLICATIONS = [
  {
    id: 'marketing_examined',
    label: 'Marketing Examined (Alex Garcia)',
    url: 'https://www.marketingexamined.com/',
    coverage: 'global',
    industries: ['all'],
    qualityScore: 0.85,
    note: 'Weekly newsletter breaking down great campaigns',
  },
  {
    id: 'marketing_brew',
    label: 'Marketing Brew',
    url: 'https://www.marketingbrew.com/',
    coverage: 'NA',
    industries: ['all'],
    qualityScore: 0.8,
  },
  {
    id: 'ariyh',
    label: 'Ariyh (Marketing Research)',
    url: 'https://www.ariyh.com/',
    coverage: 'global',
    industries: ['all'],
    qualityScore: 0.85,
  },
  {
    id: 'realgoodemails',
    label: 'Really Good Emails',
    url: 'https://reallygoodemails.com/',
    coverage: 'global',
    industries: ['all'],
    qualityScore: 0.85,
    formats: ['email'],
  },
  {
    id: 'landingfolio',
    label: 'Landingfolio',
    url: 'https://www.landingfolio.com/',
    coverage: 'global',
    industries: ['saas_b2b', 'saas_b2c', 'ecommerce_apparel', 'ecommerce_beauty'],
    qualityScore: 0.8,
    formats: ['landing_page'],
  },
];

// ─── Expert brands by industry (Meta Ad Library page-name targets) ───
// The orchestrator looks these up FIRST, then fills in long-tail.
const EXPERT_BRANDS = {
  cafe: [
    { name: 'Blue Bottle Coffee', region: 'US', qualityScore: 0.85 },
    { name: 'Starbucks', region: 'GLOBAL', qualityScore: 0.85 },
    { name: 'Stumptown Coffee', region: 'US', qualityScore: 0.85 },
    { name: 'Counter Culture Coffee', region: 'US', qualityScore: 0.8 },
    { name: 'Pret A Manger', region: 'GB', qualityScore: 0.85 },
    { name: '% Arabica', region: 'APAC', qualityScore: 0.9 },
  ],
  restaurant: [
    { name: 'Sweetgreen', region: 'US', qualityScore: 0.9 },
    { name: 'Chipotle Mexican Grill', region: 'US', qualityScore: 0.85 },
    { name: 'Joe & The Juice', region: 'GLOBAL', qualityScore: 0.85 },
    { name: 'Cava', region: 'US', qualityScore: 0.85 },
    { name: 'Wingstop', region: 'US', qualityScore: 0.8 },
  ],
  gym_fitness: [
    { name: 'Equinox', region: 'US', qualityScore: 0.9 },
    { name: 'Barry’s', region: 'GLOBAL', qualityScore: 0.9 },
    { name: 'F45 Training', region: 'GLOBAL', qualityScore: 0.85 },
    { name: 'CrossFit', region: 'GLOBAL', qualityScore: 0.8 },
    { name: 'Peloton', region: 'GLOBAL', qualityScore: 0.9 },
  ],
  yoga_pilates: [
    { name: 'Alo Yoga', region: 'GLOBAL', qualityScore: 0.9 },
    { name: 'Y7 Studio', region: 'US', qualityScore: 0.8 },
    { name: 'CorePower Yoga', region: 'US', qualityScore: 0.8 },
  ],
  wellness_spa: [
    { name: 'Aire Ancient Baths', region: 'GLOBAL', qualityScore: 0.85 },
    { name: 'Hand & Stone', region: 'NA', qualityScore: 0.75 },
  ],
  salon_beauty: [
    { name: 'Drybar', region: 'NA', qualityScore: 0.85 },
    { name: 'Madison Reed', region: 'NA', qualityScore: 0.85 },
  ],
  ecommerce_apparel: [
    { name: 'Allbirds', region: 'GLOBAL', qualityScore: 0.9 },
    { name: 'Vuori', region: 'GLOBAL', qualityScore: 0.95 },
    { name: 'On Running', region: 'GLOBAL', qualityScore: 0.9 },
    { name: 'Lululemon', region: 'GLOBAL', qualityScore: 0.9 },
    { name: 'Aviator Nation', region: 'US', qualityScore: 0.8 },
    { name: 'Buck Mason', region: 'US', qualityScore: 0.85 },
    { name: 'Outdoor Voices', region: 'US', qualityScore: 0.8 },
  ],
  ecommerce_beauty: [
    { name: 'Glossier', region: 'GLOBAL', qualityScore: 0.9 },
    { name: 'Rare Beauty', region: 'GLOBAL', qualityScore: 0.9 },
    { name: 'Drunk Elephant', region: 'GLOBAL', qualityScore: 0.85 },
    { name: 'The Ordinary', region: 'GLOBAL', qualityScore: 0.9 },
    { name: 'Topicals', region: 'NA', qualityScore: 0.85 },
    { name: 'Tower 28', region: 'NA', qualityScore: 0.8 },
  ],
  cosmetics_brand: [
    { name: 'Charlotte Tilbury', region: 'GLOBAL', qualityScore: 0.9 },
    { name: 'Rhode by Hailey Bieber', region: 'GLOBAL', qualityScore: 0.9 },
    { name: 'Fenty Beauty', region: 'GLOBAL', qualityScore: 0.9 },
  ],
  ecommerce_homewares: [
    { name: 'Article', region: 'NA', qualityScore: 0.85 },
    { name: 'Brooklinen', region: 'NA', qualityScore: 0.85 },
    { name: 'Casper', region: 'GLOBAL', qualityScore: 0.85 },
    { name: 'Parachute Home', region: 'NA', qualityScore: 0.85 },
  ],
  ecommerce_food: [
    { name: 'Liquid Death', region: 'GLOBAL', qualityScore: 0.95 },
    { name: 'Olipop', region: 'NA', qualityScore: 0.9 },
    { name: 'Magic Spoon', region: 'NA', qualityScore: 0.85 },
    { name: 'Graza', region: 'NA', qualityScore: 0.9 },
    { name: 'Fly By Jing', region: 'NA', qualityScore: 0.85 },
    { name: 'Omsom', region: 'NA', qualityScore: 0.85 },
    { name: 'Poppi', region: 'NA', qualityScore: 0.9 },
  ],
  ecommerce_supplements: [
    { name: 'Athletic Greens (AG1)', region: 'GLOBAL', qualityScore: 0.95 },
    { name: 'Ritual', region: 'GLOBAL', qualityScore: 0.9 },
    { name: 'Care/of', region: 'NA', qualityScore: 0.85 },
  ],
  ecommerce_jewelry: [
    { name: 'Mejuri', region: 'GLOBAL', qualityScore: 0.9 },
    { name: 'Aurate', region: 'NA', qualityScore: 0.8 },
    { name: 'Catbird', region: 'NA', qualityScore: 0.8 },
  ],
  ecommerce_pet: [
    { name: 'BarkBox', region: 'NA', qualityScore: 0.85 },
    { name: 'The Farmer’s Dog', region: 'NA', qualityScore: 0.9 },
  ],
  saas_b2b: [
    { name: 'Notion', region: 'GLOBAL', qualityScore: 0.9 },
    { name: 'Linear', region: 'GLOBAL', qualityScore: 0.95 },
    { name: 'Stripe', region: 'GLOBAL', qualityScore: 0.95 },
    { name: 'Vercel', region: 'GLOBAL', qualityScore: 0.9 },
    { name: 'HubSpot', region: 'GLOBAL', qualityScore: 0.85 },
    { name: 'Asana', region: 'GLOBAL', qualityScore: 0.85 },
    { name: 'Monday.com', region: 'GLOBAL', qualityScore: 0.85 },
  ],
  saas_b2c: [
    { name: 'Duolingo', region: 'GLOBAL', qualityScore: 0.95 },
    { name: 'Calm', region: 'GLOBAL', qualityScore: 0.9 },
    { name: 'Headspace', region: 'GLOBAL', qualityScore: 0.85 },
    { name: 'Robinhood', region: 'NA', qualityScore: 0.85 },
    { name: 'Cash App', region: 'NA', qualityScore: 0.85 },
  ],
  mobile_app: [
    { name: 'TikTok', region: 'GLOBAL', qualityScore: 0.9 },
    { name: 'BeReal', region: 'GLOBAL', qualityScore: 0.85 },
  ],
  real_estate_agent: [
    { name: 'The Agency', region: 'NA', qualityScore: 0.85 },
    { name: 'Compass', region: 'NA', qualityScore: 0.8 },
  ],
  insurance_agency: [
    { name: 'Lemonade', region: 'GLOBAL', qualityScore: 0.9 },
    { name: 'Hippo Insurance', region: 'NA', qualityScore: 0.8 },
  ],
  financial_advisor: [
    { name: 'Wealthfront', region: 'NA', qualityScore: 0.85 },
    { name: 'Betterment', region: 'NA', qualityScore: 0.85 },
  ],
  online_course: [
    { name: 'MasterClass', region: 'GLOBAL', qualityScore: 0.95 },
    { name: 'Skillshare', region: 'GLOBAL', qualityScore: 0.85 },
    { name: 'Brilliant', region: 'GLOBAL', qualityScore: 0.9 },
  ],
  coaching_personal: [{ name: 'BetterUp', region: 'GLOBAL', qualityScore: 0.85 }],
  hotel_hospitality: [
    { name: 'Marriott Bonvoy', region: 'GLOBAL', qualityScore: 0.85 },
    { name: 'Hyatt', region: 'GLOBAL', qualityScore: 0.85 },
    { name: 'CitizenM', region: 'GLOBAL', qualityScore: 0.9 },
    { name: 'Ace Hotel', region: 'GLOBAL', qualityScore: 0.9 },
  ],
  tourism_travel: [
    { name: 'Airbnb', region: 'GLOBAL', qualityScore: 0.95 },
    { name: 'Hopper', region: 'NA', qualityScore: 0.85 },
  ],
};

// ─── Award winners (hardest quality signal — used by quality-scorer.js) ──
// Brands that have won a major industry award (Cannes Lions, Effie, D&AD,
// One Show) in the last 3 years. When a Meta Ad Library ad's page_name
// matches one of these, quality-scorer boosts the score to 0.95.
//
// This is a hand-curated subset of EXPERT_BRANDS — being an "expert brand"
// (above) means proven scale; being an "award winner" (below) means proven
// craft. Both matter, awards is the tighter signal.
//
// Operator note: seed list of ~20 known winners. Quarterly refresh
// (Wave 59 Session 5) will propose adds/drops via Slack.
const AWARD_WINNERS = [
  // ─── Cannes Lions 2023–2025 grand prix / gold winners ────────────────
  { name: 'Liquid Death', award: 'Cannes Lions 2024 Grand Prix', year: 2024 },
  { name: 'Heinz', award: 'Cannes Lions 2024 Gold', year: 2024 },
  { name: 'Apple', award: 'Cannes Lions 2024 Gold', year: 2024 },
  { name: 'Nike', award: 'Cannes Lions 2024 Gold', year: 2024 },
  { name: 'Coca-Cola', award: 'Cannes Lions 2023 Grand Prix', year: 2023 },
  { name: 'Dove', award: 'Cannes Lions 2023 Gold', year: 2023 },
  { name: 'Burger King', award: 'Cannes Lions 2023 Gold', year: 2023 },
  { name: 'KitKat', award: 'Cannes Lions 2024 Gold', year: 2024 },

  // ─── Effie Awards 2023–2025 ──────────────────────────────────────────
  { name: 'Duolingo', award: 'Effie 2024 Gold', year: 2024 },
  { name: 'Airbnb', award: 'Effie 2023 Gold', year: 2023 },
  { name: 'Sweetgreen', award: 'Effie 2024 Silver', year: 2024 },
  { name: 'Mastercard', award: 'Effie 2024 Gold', year: 2024 },

  // ─── D&AD Pencils 2023–2025 ──────────────────────────────────────────
  { name: 'Spotify', award: 'D&AD 2024 Yellow Pencil', year: 2024 },
  { name: 'IKEA', award: 'D&AD 2023 Yellow Pencil', year: 2023 },
  { name: 'Patagonia', award: 'D&AD 2024 Wood Pencil', year: 2024 },

  // ─── One Show 2023–2025 ──────────────────────────────────────────────
  { name: 'Glossier', award: 'One Show 2023 Gold', year: 2023 },
  { name: 'Allbirds', award: 'One Show 2024 Silver', year: 2024 },
  { name: 'Stripe', award: 'One Show 2024 Gold', year: 2024 },
  { name: 'Notion', award: 'One Show 2023 Silver', year: 2023 },
  { name: 'Linear', award: 'One Show 2024 Silver', year: 2024 },
];

// Fast O(1) lookup by normalized brand name.
const _AWARD_WINNER_NAMES = new Set(
  AWARD_WINNERS.map((w) =>
    String(w.name || '')
      .toLowerCase()
      .trim()
  )
);

/**
 * Is this brand a known award winner? Used by quality-scorer.js to boost
 * the score ceiling to 0.95 (vs 0.85 for plain expert brands).
 *
 * Matches on normalized name; case + whitespace insensitive.
 */
function isAwardWinner(pageName) {
  if (!pageName) return false;
  return _AWARD_WINNER_NAMES.has(String(pageName).toLowerCase().trim());
}

function getBrandsForIndustry(industryId) {
  return EXPERT_BRANDS[industryId] || [];
}

function getAllExpertBrands() {
  const out = [];
  for (const [industryId, brands] of Object.entries(EXPERT_BRANDS)) {
    for (const brand of brands) {
      out.push({ ...brand, industry: industryId });
    }
  }
  return out;
}

module.exports = {
  VERSION,
  AWARD_ARCHIVES,
  PUBLICATIONS,
  EXPERT_BRANDS,
  AWARD_WINNERS,
  isAwardWinner,
  getBrandsForIndustry,
  getAllExpertBrands,
};
