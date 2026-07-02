'use strict';

/**
 * lib/onboardingProfile.js
 * ----------------------------------------------------------------------------
 * Sanitizes the FULL onboarding-wizard payload into a `business_profiles` row.
 *
 * History: the wizard collects ~83 questions and POSTs a rich payload to
 * /api/onboarding/save, but the route only persisted ~11 generic columns on
 * `businesses` — products, pains, USP, named competitors, never-words, hours
 * and seasonality were silently dropped. The consumer chain for all of it
 * already existed (business_profiles → wf1 resolveBrandContext →
 * buildBrandContext → renderPremiumBrandContext → strategic prompt); this
 * module is the missing producer side.
 *
 * Every enum below mirrors a CHECK constraint from migration 013 — values
 * that don't match are dropped (null) rather than failing the whole write,
 * because a typo in one field must never cost the customer their profile.
 * Arrays/objects are capped so a hostile payload can't bloat JSONB columns.
 *
 * NOTE on keying: business_profiles.user_id is, by long-standing convention,
 * the BUSINESS id (wf1's resolveBrandContext and resolveLocalDate both query
 * `user_id=eq.<businessId>`, as do the brand-voice writers). Keep doing that
 * here; renaming the column is a separate, riskier migration.
 */

const { z } = require('zod');

const ENUMS = {
  business_age: ['new', 'growing', 'established'],
  operation_model: ['location_based', 'mobile', 'hybrid', 'online'],
  audience_gender: ['male', 'female', 'mixed'],
  ads_experience: ['never', 'failed', 'success', 'active'],
  seasonal: ['year_round', 'busy_season', 'slow_season'],
};

const capped = (max) =>
  z
    .string()
    .trim()
    .max(100000)
    .transform((s) => (s ? s.slice(0, max) : null))
    .nullable()
    .optional()
    .catch(null);

const enumOrNull = (allowed) =>
  z
    .string()
    .trim()
    .transform((s) => (allowed.includes(s) ? s : null))
    .nullable()
    .optional()
    .catch(null);

const strArray = (maxItems, maxLen = 120) =>
  z
    .array(z.string().trim().max(1000))
    .transform((a) =>
      a
        .filter(Boolean)
        .slice(0, maxItems)
        .map((s) => s.slice(0, maxLen))
    )
    .optional()
    .catch(undefined);

const intInRange = (min, max) =>
  z.coerce
    .number()
    .int()
    .transform((n) => (n >= min && n <= max ? n : null))
    .nullable()
    .optional()
    .catch(null);

const productSchema = z
  .object({
    name: z.string().trim().max(160),
    price: z
      .union([z.string().max(40), z.number()])
      .optional()
      .catch(undefined),
    description: z.string().trim().max(400).optional().catch(undefined),
  })
  .catch(null);

const locationSchema = z
  .object({
    city: z.string().trim().max(120).optional().catch(undefined),
    neighborhood: z.string().trim().max(120).optional().catch(undefined),
    address: z.string().trim().max(240).optional().catch(undefined),
  })
  .catch(null);

const competitorSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    city: z.string().trim().max(120).optional().catch(undefined),
  })
  .catch(null);

const onboardingProfileSchema = z.object({
  business_name: capped(120),
  business_type: capped(80),
  business_age: enumOrNull(ENUMS.business_age),
  usp: capped(500),
  tagline: capped(200),
  physical_locations: z.array(locationSchema).optional().catch(undefined),
  operation_model: enumOrNull(ENUMS.operation_model),
  service_area: strArray(25),
  ad_targeting_area: strArray(25),
  primary_language: capped(40),
  secondary_languages: strArray(10, 40),
  audience_age_min: intInRange(13, 100),
  audience_age_max: intInRange(13, 100),
  audience_gender: enumOrNull(ENUMS.audience_gender),
  audience_description: capped(1000),
  pain_point: capped(1000),
  avg_spend: capped(120),
  products: z.array(productSchema).optional().catch(undefined),
  current_offer: capped(500),
  primary_goal: capped(300),
  monthly_budget: capped(120),
  ads_experience: enumOrNull(ENUMS.ads_experience),
  tone_keywords: strArray(15, 60),
  never_do: capped(500),
  business_hours: z.record(z.string(), z.unknown()).optional().catch(undefined),
  seasonal: enumOrNull(ENUMS.seasonal),
  busy_months: strArray(12, 20),
  best_posting_times: capped(120),
  competitors: z.array(competitorSchema).optional().catch(undefined),
  they_do_better: capped(1000),
  we_do_better: capped(1000),
});

/**
 * @param {object} body raw request body (the wizard payload — extra keys ignored)
 * @param {string} businessId the business this profile belongs to (stored as
 *   business_profiles.user_id — see keying note above)
 * @returns {{ row: object|null, competitors: Array<{name:string, city?:string}> }}
 *   row: the business_profiles upsert payload (null when nothing usable was
 *   sent — callers skip the write rather than overwrite with empties).
 *   competitors: cleaned named-competitor list for businesses.competitors,
 *   which is what competitor-watch actually scans.
 */
function sanitizeOnboardingProfile(body, businessId) {
  const parsed = onboardingProfileSchema.safeParse(body || {});
  const data = parsed.success ? parsed.data : {};

  const row = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      const cleanedArr = value.filter(Boolean);
      if (!cleanedArr.length) continue;
      row[key] =
        key === 'products'
          ? cleanedArr.slice(0, 20)
          : key === 'competitors'
            ? cleanedArr.slice(0, 5)
            : key === 'physical_locations'
              ? cleanedArr.slice(0, 10)
              : cleanedArr;
      continue;
    }
    if (typeof value === 'object') {
      // business_hours — cap serialized size so one field can't bloat the row.
      if (JSON.stringify(value).length > 2000) continue;
      row[key] = value;
      continue;
    }
    row[key] = value;
  }

  const competitors = Array.isArray(row.competitors) ? row.competitors : [];

  if (!Object.keys(row).length) return { row: null, competitors: [] };

  return {
    row: {
      ...row,
      user_id: businessId,
      profile_score: computeProfileScore(row),
      updated_at: new Date().toISOString(),
    },
    competitors,
  };
}

// Rough 0-100 richness score: how much of the high-signal profile the
// customer has filled. Drives the dashboard's ProfileScore widget via
// /api/onboarding/score (richer profile → better AI output, honestly earned).
const SCORE_WEIGHTS = [
  ['usp', 12],
  ['audience_description', 12],
  ['pain_point', 12],
  ['products', 12],
  ['competitors', 10],
  ['primary_goal', 8],
  ['monthly_budget', 8],
  ['never_do', 6],
  ['tone_keywords', 6],
  ['current_offer', 6],
  ['business_hours', 4],
  ['seasonal', 4],
];

function computeProfileScore(row) {
  let score = 0;
  for (const [key, weight] of SCORE_WEIGHTS) {
    const v = row[key];
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && !v.length) continue;
    if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    score += weight;
  }
  return Math.min(100, score);
}

/**
 * Compact plain-text profile block for ad-strategy prompts (meta-campaigns
 * etc.) — the places that build prompts from the thin businesses row and
 * never saw the wizard's rich answers. Bounded ≤ ~700 chars so it's cheap
 * to inject anywhere. Returns '' when there's nothing useful.
 */
function buildAdProfileContext(profile) {
  if (!profile || typeof profile !== 'object') return '';
  const parts = [];
  if (profile.usp) parts.push(`USP: ${String(profile.usp).slice(0, 160)}`);
  if (Array.isArray(profile.products) && profile.products.length) {
    const names = profile.products
      .slice(0, 4)
      .map((p) => (p && p.name ? `${p.name}${p.price ? ` (${p.price})` : ''}` : null))
      .filter(Boolean);
    if (names.length) parts.push(`Products: ${names.join(', ')}`);
  }
  if (profile.pain_point) parts.push(`Customer pains: ${String(profile.pain_point).slice(0, 160)}`);
  if (profile.current_offer) parts.push(`Current offer: ${String(profile.current_offer).slice(0, 100)}`);
  if (profile.audience_age_min || profile.audience_age_max) {
    parts.push(
      `Audience age: ${profile.audience_age_min || 18}-${profile.audience_age_max || 65}` +
        (profile.audience_gender && profile.audience_gender !== 'mixed' ? ` (${profile.audience_gender})` : '')
    );
  }
  if (profile.we_do_better) parts.push(`Edge vs competitors: ${String(profile.we_do_better).slice(0, 140)}`);
  if (profile.never_do) parts.push(`NEVER use these words/angles: ${String(profile.never_do).slice(0, 120)}`);
  if (!parts.length) return '';
  return `PROFILE (from onboarding — use these specifics, never invent others):\n  ${parts.join('\n  ')}`;
}

module.exports = { sanitizeOnboardingProfile, computeProfileScore, onboardingProfileSchema, buildAdProfileContext };
