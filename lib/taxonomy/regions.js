'use strict';

/**
 * lib/taxonomy/regions.js
 * ---------------------------------------------------------------------------
 * Geographic region taxonomy for the marketing corpus.
 *
 * Each entry has:
 *   id          ISO-3166-1 alpha-2 country code, or aggregate (GLOBAL, EU, etc.)
 *   label       human-readable
 *   languages   ISO-639-1 codes commonly spoken (for locale matching)
 *   cluster     broader market cluster — used for retrieval fallback
 *   currency    ISO-4217 — hints at locale during classification
 *
 * "Expanding circles" retrieval: a Tirana café queries with
 *   regions = ['AL', 'XK', 'MK', 'EU', 'GLOBAL']
 * so it tries Albanian first, then Balkan neighbors, then EU, then global.
 */

const VERSION = 'v1';

const REGIONS = [
  // ─── Special aggregates ─────────────────────────────────────────────
  { id: 'GLOBAL', label: 'Global / Region-Agnostic', languages: ['en'], cluster: 'GLOBAL', currency: 'USD' },
  {
    id: 'EU',
    label: 'European Union (aggregate)',
    languages: ['en', 'de', 'fr', 'es', 'it', 'nl', 'pl'],
    cluster: 'EU',
    currency: 'EUR',
  },
  { id: 'NA', label: 'North America (aggregate)', languages: ['en', 'es', 'fr'], cluster: 'NA', currency: 'USD' },
  {
    id: 'APAC',
    label: 'Asia-Pacific (aggregate)',
    languages: ['en', 'zh', 'ja', 'ko', 'hi', 'id'],
    cluster: 'APAC',
    currency: 'USD',
  },
  { id: 'LATAM', label: 'Latin America (aggregate)', languages: ['es', 'pt'], cluster: 'LATAM', currency: 'USD' },
  { id: 'MENA', label: 'Middle East & North Africa', languages: ['ar', 'fr', 'en'], cluster: 'MENA', currency: 'USD' },

  // ─── North America ─────────────────────────────────────────────────
  { id: 'US', label: 'United States', languages: ['en', 'es'], cluster: 'NA', currency: 'USD' },
  { id: 'CA', label: 'Canada', languages: ['en', 'fr'], cluster: 'NA', currency: 'CAD' },
  { id: 'MX', label: 'Mexico', languages: ['es'], cluster: 'LATAM', currency: 'MXN' },

  // ─── Western Europe ────────────────────────────────────────────────
  { id: 'GB', label: 'United Kingdom', languages: ['en'], cluster: 'EU', currency: 'GBP' },
  { id: 'IE', label: 'Ireland', languages: ['en', 'ga'], cluster: 'EU', currency: 'EUR' },
  { id: 'DE', label: 'Germany', languages: ['de'], cluster: 'EU', currency: 'EUR' },
  { id: 'FR', label: 'France', languages: ['fr'], cluster: 'EU', currency: 'EUR' },
  { id: 'IT', label: 'Italy', languages: ['it'], cluster: 'EU', currency: 'EUR' },
  { id: 'ES', label: 'Spain', languages: ['es', 'ca'], cluster: 'EU', currency: 'EUR' },
  { id: 'PT', label: 'Portugal', languages: ['pt'], cluster: 'EU', currency: 'EUR' },
  { id: 'NL', label: 'Netherlands', languages: ['nl', 'en'], cluster: 'EU', currency: 'EUR' },
  { id: 'BE', label: 'Belgium', languages: ['nl', 'fr', 'de'], cluster: 'EU', currency: 'EUR' },
  { id: 'AT', label: 'Austria', languages: ['de'], cluster: 'EU', currency: 'EUR' },
  { id: 'CH', label: 'Switzerland', languages: ['de', 'fr', 'it'], cluster: 'EU', currency: 'CHF' },
  { id: 'SE', label: 'Sweden', languages: ['sv'], cluster: 'EU', currency: 'SEK' },
  { id: 'NO', label: 'Norway', languages: ['no'], cluster: 'EU', currency: 'NOK' },
  { id: 'DK', label: 'Denmark', languages: ['da'], cluster: 'EU', currency: 'DKK' },
  { id: 'FI', label: 'Finland', languages: ['fi', 'sv'], cluster: 'EU', currency: 'EUR' },

  // ─── CEE & Balkans (Maroa's primary launch market) ─────────────────
  { id: 'AL', label: 'Albania', languages: ['sq', 'en'], cluster: 'EU', currency: 'ALL' },
  { id: 'XK', label: 'Kosovo', languages: ['sq', 'sr'], cluster: 'EU', currency: 'EUR' },
  { id: 'MK', label: 'North Macedonia', languages: ['mk', 'sq'], cluster: 'EU', currency: 'MKD' },
  { id: 'ME', label: 'Montenegro', languages: ['sr', 'hr'], cluster: 'EU', currency: 'EUR' },
  { id: 'HR', label: 'Croatia', languages: ['hr'], cluster: 'EU', currency: 'EUR' },
  { id: 'SI', label: 'Slovenia', languages: ['sl'], cluster: 'EU', currency: 'EUR' },
  { id: 'GR', label: 'Greece', languages: ['el'], cluster: 'EU', currency: 'EUR' },
  { id: 'PL', label: 'Poland', languages: ['pl'], cluster: 'EU', currency: 'PLN' },
  { id: 'CZ', label: 'Czech Republic', languages: ['cs'], cluster: 'EU', currency: 'CZK' },
  { id: 'RO', label: 'Romania', languages: ['ro'], cluster: 'EU', currency: 'RON' },
  { id: 'BG', label: 'Bulgaria', languages: ['bg'], cluster: 'EU', currency: 'BGN' },
  { id: 'HU', label: 'Hungary', languages: ['hu'], cluster: 'EU', currency: 'HUF' },

  // ─── Oceania ───────────────────────────────────────────────────────
  { id: 'AU', label: 'Australia', languages: ['en'], cluster: 'APAC', currency: 'AUD' },
  { id: 'NZ', label: 'New Zealand', languages: ['en', 'mi'], cluster: 'APAC', currency: 'NZD' },

  // ─── Asia ──────────────────────────────────────────────────────────
  { id: 'JP', label: 'Japan', languages: ['ja'], cluster: 'APAC', currency: 'JPY' },
  { id: 'KR', label: 'South Korea', languages: ['ko'], cluster: 'APAC', currency: 'KRW' },
  {
    id: 'SG',
    label: 'Singapore',
    languages: ['en', 'zh', 'ms', 'ta'],
    cluster: 'APAC',
    currency: 'SGD',
  },
  { id: 'IN', label: 'India', languages: ['en', 'hi'], cluster: 'APAC', currency: 'INR' },
  { id: 'ID', label: 'Indonesia', languages: ['id', 'en'], cluster: 'APAC', currency: 'IDR' },
  { id: 'PH', label: 'Philippines', languages: ['en', 'tl'], cluster: 'APAC', currency: 'PHP' },

  // ─── Latin America ─────────────────────────────────────────────────
  { id: 'BR', label: 'Brazil', languages: ['pt'], cluster: 'LATAM', currency: 'BRL' },
  { id: 'AR', label: 'Argentina', languages: ['es'], cluster: 'LATAM', currency: 'ARS' },
  { id: 'CO', label: 'Colombia', languages: ['es'], cluster: 'LATAM', currency: 'COP' },
  { id: 'CL', label: 'Chile', languages: ['es'], cluster: 'LATAM', currency: 'CLP' },

  // ─── Middle East ───────────────────────────────────────────────────
  { id: 'AE', label: 'United Arab Emirates', languages: ['ar', 'en'], cluster: 'MENA', currency: 'AED' },
  { id: 'SA', label: 'Saudi Arabia', languages: ['ar'], cluster: 'MENA', currency: 'SAR' },
  { id: 'IL', label: 'Israel', languages: ['he', 'en', 'ar'], cluster: 'MENA', currency: 'ILS' },
];

const _byId = new Map(REGIONS.map((r) => [r.id, r]));
const _byCluster = new Map();
for (const r of REGIONS) {
  if (!_byCluster.has(r.cluster)) _byCluster.set(r.cluster, []);
  _byCluster.get(r.cluster).push(r.id);
}

function getById(id) {
  return _byId.get(id) || null;
}

function getAllIds() {
  return REGIONS.map((r) => r.id);
}

function getByCluster(cluster) {
  return _byCluster.get(cluster) || [];
}

/**
 * Expanding-circles region list — used by the grounding library to
 * progressively widen retrieval. Order: self, same-cluster peers,
 * cluster aggregate, GLOBAL.
 *
 * Example: getExpandingCircles('AL')
 *   → ['AL', 'XK', 'MK', 'ME', 'HR', 'SI', 'GR', ..., 'EU', 'GLOBAL']
 */
function getExpandingCircles(id) {
  const r = getById(id);
  if (!r) return ['GLOBAL'];
  const out = [id];
  // Add same-cluster country codes (not the aggregate itself yet)
  const aggregates = new Set(['GLOBAL', 'EU', 'NA', 'APAC', 'LATAM', 'MENA']);
  for (const peer of getByCluster(r.cluster)) {
    if (peer === id) continue;
    if (aggregates.has(peer)) continue;
    if (!out.includes(peer)) out.push(peer);
  }
  // Then the cluster aggregate
  if (r.cluster && r.cluster !== 'GLOBAL' && !out.includes(r.cluster)) out.push(r.cluster);
  // Finally global
  if (!out.includes('GLOBAL')) out.push('GLOBAL');
  return out;
}

module.exports = {
  VERSION,
  REGIONS,
  getById,
  getAllIds,
  getByCluster,
  getExpandingCircles,
};
