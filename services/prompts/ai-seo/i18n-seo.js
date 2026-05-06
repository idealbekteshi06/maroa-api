'use strict';

/**
 * services/prompts/ai-seo/i18n-seo.js
 * ----------------------------------------------------------------------------
 * AI-SEO international layer.
 *
 *  - Per-country: address formats, hreflang codes, AI assistant penetration,
 *    Google AI Overview presence (rolled out staggered by region in 2026).
 *  - Per-language: schema "name" + "description" output rules, RTL text dir,
 *    quote/dash conventions.
 *
 * Reuses ad-optimizer's i18n COUNTRY_DEFAULTS + RTL_LANGS to avoid drift.
 * ----------------------------------------------------------------------------
 */

const adI18n = require('../ad-optimizer/i18n-market');

// AI search penetration estimates per country (% of users with active access
// to ChatGPT/Perplexity/Google AI Overviews as of 2026 Q2 data). Higher
// penetration → AI-SEO is more valuable in that market.
const AI_SEARCH_PENETRATION = {
  US: 'high',  CA: 'high', GB: 'high',  UK: 'high', AU: 'high', NZ: 'high', IE: 'high', SG: 'high',
  DE: 'high',  FR: 'high', NL: 'high',  SE: 'high', NO: 'high', DK: 'high', FI: 'high', BE: 'high', AT: 'high', CH: 'high',
  IT: 'mid',   ES: 'mid',  PT: 'mid',   PL: 'mid',  CZ: 'mid',  HU: 'mid',  GR: 'mid',
  JP: 'mid',   KR: 'mid',  IL: 'mid',   AE: 'mid',  SA: 'mid',
  BR: 'mid',   MX: 'mid',  AR: 'low',   CL: 'low',  CO: 'low',  PE: 'low',
  IN: 'mid',   TR: 'low',  ZA: 'low',   EG: 'low',  NG: 'low',  KE: 'low',
  AL: 'low',   XK: 'low',  MK: 'low',   BA: 'low',  ME: 'low',  RS: 'low', HR: 'low',
  RO: 'low',   BG: 'low',  UA: 'low',
  PH: 'low',   ID: 'low',  TH: 'low',   VN: 'low',  MY: 'low',
};

// Address format templates per country (simplified — covers 90% of cases).
// Used by LocalBusiness schema generator.
const ADDRESS_FORMATS = {
  US: { fields: ['streetAddress','addressLocality','addressRegion','postalCode','addressCountry'], example: '1234 Main St, Springfield, IL 62701, US' },
  CA: { fields: ['streetAddress','addressLocality','addressRegion','postalCode','addressCountry'], example: '123 Yonge St, Toronto, ON M5B 1L7, CA' },
  GB: { fields: ['streetAddress','addressLocality','addressRegion','postalCode','addressCountry'], example: '10 Downing St, London SW1A 2AA, UK' },
  UK: { fields: ['streetAddress','addressLocality','addressRegion','postalCode','addressCountry'], example: '10 Downing St, London SW1A 2AA, UK' },
  DE: { fields: ['streetAddress','postalCode','addressLocality','addressCountry'], example: 'Friedrichstraße 50, 10117 Berlin, DE' },
  FR: { fields: ['streetAddress','postalCode','addressLocality','addressCountry'], example: '5 Avenue Anatole France, 75007 Paris, FR' },
  IT: { fields: ['streetAddress','postalCode','addressLocality','addressRegion','addressCountry'], example: 'Via Roma 1, 00184 Roma, RM, IT' },
  ES: { fields: ['streetAddress','postalCode','addressLocality','addressRegion','addressCountry'], example: 'Calle Mayor 1, 28013 Madrid, Madrid, ES' },
  AL: { fields: ['streetAddress','addressLocality','addressCountry'], example: 'Rruga Myslym Shyri 5, Tiranë, AL' },
  XK: { fields: ['streetAddress','addressLocality','addressCountry'], example: 'Bulevardi Nëna Terezë, Prishtinë, XK' },
  RS: { fields: ['streetAddress','postalCode','addressLocality','addressCountry'], example: 'Knez Mihailova 5, 11000 Beograd, RS' },
  BR: { fields: ['streetAddress','addressLocality','addressRegion','postalCode','addressCountry'], example: 'Av. Paulista 1000, São Paulo, SP, 01310-100, BR' },
  MX: { fields: ['streetAddress','addressLocality','addressRegion','postalCode','addressCountry'], example: 'Av. Reforma 222, Cuauhtémoc, CDMX, 06600, MX' },
  AE: { fields: ['streetAddress','addressLocality','addressCountry'], example: 'Sheikh Zayed Rd, Dubai, AE' },
  IN: { fields: ['streetAddress','addressLocality','addressRegion','postalCode','addressCountry'], example: '12 MG Road, Bengaluru, KA, 560001, IN' },
  JP: { fields: ['streetAddress','addressLocality','addressRegion','postalCode','addressCountry'], example: '1-1 Chiyoda, Chiyoda-ku, Tokyo, 100-8111, JP' },
  AU: { fields: ['streetAddress','addressLocality','addressRegion','postalCode','addressCountry'], example: '1 Macquarie St, Sydney, NSW 2000, AU' },
};

/**
 * Build the SEO market profile (extends ad-optimizer profile with SEO-specific
 * fields).
 */
function buildSeoMarketProfile(business) {
  const base = adI18n.buildMarketProfile(business);
  const aiPenetration = base.country ? AI_SEARCH_PENETRATION[base.country] || 'low' : 'low';
  const addressFormat = base.country ? ADDRESS_FORMATS[base.country] || ADDRESS_FORMATS.US : ADDRESS_FORMATS.US;

  return {
    ...base,
    ai_search_penetration: aiPenetration,
    address_format: addressFormat,
    hreflang_code: hreflangFor(base.country, base.primary_language),
    text_direction: base.is_rtl ? 'rtl' : 'ltr',
  };
}

/**
 * Build hreflang code (e.g., en-US, sq-AL, pt-BR).
 */
function hreflangFor(country, language) {
  if (!country || !language) return language || 'en';
  return `${language.toLowerCase()}-${country.toUpperCase()}`;
}

/**
 * Get the canonical AI-search assistants relevant for a country.
 */
function relevantAiAssistants(country) {
  const all = ['ChatGPT', 'Perplexity', 'Google AI Overviews', 'Claude', 'Gemini'];
  if (!country) return all;
  // Some assistants are blocked or unavailable in certain regions.
  const blocked = {
    CN: ['ChatGPT', 'Claude', 'Gemini', 'Perplexity'],
    RU: ['ChatGPT', 'Claude'],
    IR: ['ChatGPT', 'Claude', 'Gemini'],
    KP: ['ChatGPT', 'Claude', 'Gemini', 'Perplexity'],
  };
  if (blocked[country]) return all.filter(a => !blocked[country].includes(a));
  return all;
}

module.exports = {
  AI_SEARCH_PENETRATION,
  ADDRESS_FORMATS,
  buildSeoMarketProfile,
  hreflangFor,
  relevantAiAssistants,
};
