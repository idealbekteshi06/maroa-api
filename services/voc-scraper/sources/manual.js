'use strict';

/**
 * services/voc-scraper/sources/manual.js
 * ---------------------------------------------------------------------------
 * Manual review upload adapter.
 *
 * Why this exists: the external scrapers (Google/Yelp/Trustpilot) all
 * require API keys + a business presence on those platforms. Many of our
 * customers (especially in Albania, our test market) might not have a
 * Yelp listing or might have a Google profile without enough reviews.
 *
 * This adapter lets the orchestrator accept a blob of review text the
 * customer (or our onboarding flow) provides directly. Returns the same
 * shape so it composes with the others.
 *
 * Use case: at onboarding, ask the customer to paste their best 5-star
 * reviews + their competitor's 1-star reviews. Run them through the
 * extractor immediately. Zero API costs, instant VoC signal.
 * ---------------------------------------------------------------------------
 */

/**
 * @param {object} input
 * @param {string|string[]} input.reviewsText  Reviews — single block or array
 * @param {string} input.label                 Optional: 'own' | 'competitor'
 */
async function fetch_({ reviewsText, label = 'own' } = {}) {
  if (!reviewsText) {
    return { ok: false, reason: 'reviewsText required', source: 'manual' };
  }
  const blocks = Array.isArray(reviewsText) ? reviewsText : [reviewsText];
  const reviews = blocks
    .map((text) => String(text).trim())
    .filter((t) => t.length > 0)
    .map((text) => ({
      rating: null,
      text,
      author: null,
      time: null,
      lang: null,
      label,
    }));
  return {
    ok: true,
    source: 'manual',
    reviews,
  };
}

module.exports = { fetch: fetch_ };
