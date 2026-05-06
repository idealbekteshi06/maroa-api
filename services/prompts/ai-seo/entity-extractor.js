'use strict';

/**
 * services/prompts/ai-seo/entity-extractor.js
 * ----------------------------------------------------------------------------
 * Entity association helpers — produces sameAs URL lists that anchor the
 * brand to canonical entities (Wikipedia, Wikidata, Google KG, social profiles).
 *
 * Pure deterministic — does not call external APIs. Caller may augment with
 * actual Wikipedia / Wikidata lookups if desired.
 * ----------------------------------------------------------------------------
 */

const SOCIAL_PATTERNS = [
  { platform: 'facebook',  match: /facebook\.com\/[\w.-]+/i },
  { platform: 'instagram', match: /instagram\.com\/[\w.-]+/i },
  { platform: 'twitter',   match: /(?:twitter|x)\.com\/[\w.-]+/i },
  { platform: 'linkedin',  match: /linkedin\.com\/(?:company|in)\/[\w.-]+/i },
  { platform: 'youtube',   match: /youtube\.com\/(?:c|channel|@)[\w.-]+/i },
  { platform: 'tiktok',    match: /tiktok\.com\/@[\w.-]+/i },
  { platform: 'pinterest', match: /pinterest\.com\/[\w.-]+/i },
  { platform: 'github',    match: /github\.com\/[\w.-]+/i },
  { platform: 'crunchbase',match: /crunchbase\.com\/(?:organization|person)\/[\w.-]+/i },
];

/**
 * Extract canonical sameAs URLs from a business profile + free-text dump.
 */
function buildSameAs({ business, additionalText = '' }) {
  const urls = new Set();
  const candidates = [
    business?.facebook_url,
    business?.instagram_url,
    business?.twitter_url,
    business?.linkedin_url,
    business?.youtube_url,
    business?.tiktok_url,
    business?.crunchbase_url,
    business?.wikipedia_url,
    business?.wikidata_url,
    additionalText,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const text = String(c);
    for (const sp of SOCIAL_PATTERNS) {
      const m = text.match(sp.match);
      if (m) {
        let url = m[0];
        if (!url.startsWith('http')) url = 'https://' + url;
        urls.add(url);
      }
    }
    // Wikipedia / Wikidata explicit
    const wiki = text.match(/(?:en|de|fr|es|it|pt|sq|sr|hr)\.wikipedia\.org\/wiki\/[\w%()-]+/i);
    if (wiki) urls.add('https://' + wiki[0]);
    const wd = text.match(/wikidata\.org\/wiki\/Q\d+/i);
    if (wd) urls.add('https://' + wd[0]);
  }
  return [...urls];
}

/**
 * Detect potential entity gaps: which canonical platforms is the business
 * MISSING from? Used by the LLM to suggest "add yourself to LinkedIn /
 * Crunchbase".
 */
function detectEntityGaps({ sameAs }) {
  const present = new Set();
  for (const url of sameAs || []) {
    for (const sp of SOCIAL_PATTERNS) {
      if (sp.match.test(url)) present.add(sp.platform);
    }
    if (/wikipedia\.org/i.test(url)) present.add('wikipedia');
    if (/wikidata\.org/i.test(url)) present.add('wikidata');
  }
  const allCanonical = [
    'linkedin', 'instagram', 'facebook', 'crunchbase', 'wikipedia', 'wikidata',
  ];
  return allCanonical.filter(p => !present.has(p));
}

module.exports = {
  SOCIAL_PATTERNS,
  buildSameAs,
  detectEntityGaps,
};
