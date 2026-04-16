/*
 * services/wf1/brandContext.js
 * ----------------------------------------------------------------------------
 * Builds the BrandContext object the strategic prompt requires, from whatever
 * is in the businesses + business_profiles tables today. Maps messy real-world
 * onboarding data to the clean shape defined in foundation.ts.
 *
 * The mapping is conservative: when a field is ambiguous, we pick the
 * interpretation that makes the LTV:CAC math and playbook selection safe.
 * ----------------------------------------------------------------------------
 */

'use strict';

// Map raw industry/business_type strings to one of the 11 business models
// the foundation framework knows about. Order matters — we return the first
// match. Keep this map pragmatic — the BUSINESSES table has been populated by
// humans over months and values like 'Water' 'Bottled water' 'DTC water brand'
// all exist.
const BUSINESS_MODEL_RULES = [
  { rx: /\bsaas\b|\bsoftware\b|\bapi\b/i, model: 'b2b_saas' },
  { rx: /\bagency\b|\bconsult|\bfreelance|\blawyer|\baccount(ing|ant)/i, model: 'professional_services' },
  { rx: /\bb2b (service|agenc)/i, model: 'b2b_services' },
  { rx: /\brestaurant\b|\bcafe\b|\bdiner\b|\bbakery\b|\bbar\b|\bcoffee\b/i, model: 'restaurant' },
  { rx: /\bhotel\b|\bhostel\b|\btravel\b|\btour\b|\bresort\b/i, model: 'hospitality' },
  { rx: /\bgym\b|\bfitness\b|\byoga\b|\bwellness\b|\bpilates\b|\bpersonal trainer\b/i, model: 'fitness_wellness' },
  { rx: /\bhome service|\bcleaning\b|\bplumb|\belectric|\bhvac\b|\blocksmith|\bmoving\b/i, model: 'local_services' },
  { rx: /\bretail\b|\becommerce|\bstore\b|\bshop\b|\bboutique\b|\bbrand\b/i, model: 'dtc_ecommerce' },
  { rx: /\bmedia\b|\bpublisher\b|\bnewsletter\b|\bpodcast\b|\byoutube\b/i, model: 'media_content' },
  { rx: /\benterprise\b|\bfortune\s?\d+\b/i, model: 'enterprise' },
];

// Rough LTV defaults per model when the business hasn't set one.
// Used only as a fallback — never overrides an explicit value.
const DEFAULT_LTV = {
  b2b_saas: 3000,
  b2b_services: 8000,
  dtc_ecommerce: 120,
  local_services: 500,
  restaurant: 80,
  hospitality: 800,
  fitness_wellness: 900,
  professional_services: 5000,
  ecommerce_marketplace: 250,
  media_content: 50,
  enterprise: 50000,
};

function guessBusinessModel(industry = '', businessType = '', description = '') {
  const haystack = [industry, businessType, description].filter(Boolean).join(' ');
  for (const rule of BUSINESS_MODEL_RULES) {
    if (rule.rx.test(haystack)) return rule.model;
  }
  return 'dtc_ecommerce'; // sensible default for unknown consumer brands
}

function guessMarketingStage(business, profile) {
  // Heuristic: followers + post history + LTV maturity.
  const totalReach = Number(business?.total_reach || 0);
  const postsPublished = Number(business?.posts_published || 0);
  const hasLtv = Boolean(profile?.ltv || business?.ltv);
  if (postsPublished > 500 || totalReach > 200000) return 'mature';
  if (postsPublished > 100 || totalReach > 20000) return 'growth';
  if (hasLtv || postsPublished > 10) return 'growth';
  return 'early';
}

function parseList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    return v.split(/[;,\n]/).map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function parseCompetitors(v) {
  const list = parseList(v);
  return list.map(c => {
    if (typeof c === 'string') return { name: c, position: 'unknown' };
    return { name: c.name || c.title || 'unknown', position: c.position || c.positioning || 'unknown' };
  });
}

function parsePersonas(profile, business) {
  const raw = profile?.personas || business?.personas || [];
  const list = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : raw;
  if (Array.isArray(list) && list.length) {
    return list.map(p => ({
      name: p.name || p.persona_name || 'Target customer',
      jtbd: p.jtbd || p.job_to_be_done || p.goal || p.description || 'Improve their situation',
      painPoints: parseList(p.painPoints || p.pain_points || p.pains),
    }));
  }
  // Fallback: synthesize one from audience_description + pain_point.
  const desc = profile?.audience_description || business?.target_audience || 'general audience';
  const pain = profile?.pain_point || '';
  return [{
    name: 'Primary audience',
    jtbd: desc.slice(0, 120),
    painPoints: pain ? [pain] : [],
  }];
}

function parseBrandVoice(profile, business) {
  const tone = profile?.brand_tone || business?.brand_tone || 'professional and warm';
  const vocab = parseList(profile?.brand_vocabulary || business?.brand_vocabulary);
  const banned = parseList(profile?.banned_words || business?.banned_words);
  return { tone, vocabulary: vocab, bannedWords: banned };
}

function parsePillars(profile, business) {
  const raw = profile?.content_pillars || business?.content_pillars || [];
  const list = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : raw;
  if (Array.isArray(list) && list.length) {
    return list.map(p => ({
      name: p.name || p.pillar || String(p),
      allocation: Number(p.allocation || p.percentage || 25),
    }));
  }
  return [];
}

function parseMarkets(profile, business) {
  const arr = parseList(profile?.markets || profile?.service_area || business?.location);
  if (arr.length) return arr;
  const country = profile?.country || 'XK';
  return [country];
}

function parseLanguages(profile, business) {
  const primary = profile?.primary_language || business?.primary_language || 'English';
  const rest = parseList(profile?.secondary_languages || business?.secondary_languages);
  return [primary, ...rest];
}

/**
 * Builds the BrandContext that foundation.ts renderBrandContext expects.
 * @param {{ business: object, profile: object }} input
 * @returns {import('../prompts/foundation.js').BrandContext}
 */
function buildBrandContext({ business = {}, profile = {} }) {
  const businessModel = guessBusinessModel(
    profile.industry || business.industry,
    profile.business_type,
    profile.audience_description || business.target_audience
  );
  const marketingStage = guessMarketingStage(business, profile);
  const ltv = Number(profile.ltv || business.ltv || DEFAULT_LTV[businessModel] || 0);
  const cacTarget = ltv > 0 ? Math.round(ltv / 3) : undefined;

  return {
    businessId: business.id || profile.user_id || '',
    businessName: business.business_name || profile.business_name || 'Unnamed business',
    businessModel,
    industry: profile.industry || business.industry || 'unknown',
    marketingStage,
    narrativeArc: profile.narrative_arc || undefined,
    ltv: ltv || undefined,
    cacTarget,
    brandVoice: parseBrandVoice(profile, business),
    contentPillars: parsePillars(profile, business),
    primaryMarkets: parseMarkets(profile, business),
    primaryLanguages: parseLanguages(profile, business),
    audience: { personas: parsePersonas(profile, business) },
    competitors: parseCompetitors(profile.competitors || business.competitors),

    // ─── Expanded onboarding context (additive — backward compatible) ───
    // Maps real DB columns from business_profiles + businesses tables.
    // Every field has a safe fallback so downstream code never breaks.

    // Positioning & identity
    uniqueSellingProposition: profile.usp || business.usp || '',
    businessDescription: profile.audience_description || business.target_audience || '',
    businessType: profile.business_type || business.business_type || '',
    tagline: profile.tagline || '',
    websiteUrl: business.website_url || '',

    // Budget & economics
    monthlyBudget: Number(profile.monthly_budget || business.monthly_budget || 0) || 0,
    avgOrderValue: Number(profile.avg_spend || business.avg_spend || 0) || 0,
    currentOffer: profile.current_offer || '',

    // Audience demographics
    ageMin: Number(profile.audience_age_min || 18),
    ageMax: Number(profile.audience_age_max || 65),
    gender: profile.audience_gender || 'mixed',
    dreamCustomer: profile.audience_description || business.target_audience || '',
    painPointsFull: profile.pain_point || '',
    audienceInterests: parseList(profile.tone_keywords || business.tone_keywords),

    // Content guardrails
    bannedWords: parseList(profile.never_do || business.never_do),

    // Competitive positioning
    theyDoBetter: profile.they_do_better || '',
    weDoBetter: profile.we_do_better || '',

    // Products & offers
    products: (() => {
      const raw = profile.products || business.products || [];
      if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return []; } }
      return Array.isArray(raw) ? raw : [];
    })(),

    // Scheduling & platforms
    activePlatforms: parseList(business.social_accounts_connected),
    postingFrequency: profile.best_posting_times || 'auto',

    // Seasonality
    seasonal: profile.seasonal || 'year_round',
    busyMonths: (() => {
      const raw = profile.busy_months || [];
      if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return []; } }
      return Array.isArray(raw) ? raw : [];
    })(),

    // Marketing context
    primaryMarketingGoal: profile.primary_goal || business.marketing_goal || '',
    adsExperience: profile.ads_experience || '',

    // Defensive: expose field presence flags for downstream logic
    _rawBusinessFields: {
      hasUSP: !!(profile.usp || business.usp),
      hasDescription: !!(profile.audience_description || business.target_audience),
      hasBudget: !!(profile.monthly_budget || business.monthly_budget),
      hasBannedWords: !!(profile.never_do || business.never_do),
      hasPainPoints: !!profile.pain_point,
      hasProducts: !!(profile.products || business.products),
      hasCompetitorContext: !!(profile.they_do_better || profile.we_do_better),
    },
  };
}

module.exports = {
  buildBrandContext,
  guessBusinessModel,
  guessMarketingStage,
  DEFAULT_LTV,
};
