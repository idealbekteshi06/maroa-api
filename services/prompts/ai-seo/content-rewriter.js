'use strict';

/**
 * services/prompts/ai-seo/content-rewriter.js
 * ----------------------------------------------------------------------------
 * Helpers for rewriting page content into AI-extractable structures:
 *
 *   - TL;DR block (top-of-page 2-3-sentence summary)
 *   - Structured Q&A (FAQPage-aligned)
 *   - Definition + comparison patterns
 *   - Anti-buzzword list to strip generic marketing language
 * ----------------------------------------------------------------------------
 */

const BUZZWORDS = [
  /world.?class/gi, /cutting.edge/gi, /innovative/gi, /best.in.class/gi,
  /game.?changing/gi, /synerg/gi, /leverage/gi, /unparalleled/gi,
  /next.?gen/gi, /revolutionar/gi, /disruptive/gi, /seamless(?!ly)/gi,
  /robust/gi, /turn-?key/gi, /streamline/gi, /best.of.breed/gi,
];

/**
 * Strip empty buzzwords from copy. Returns { stripped, removed_count, replacements }.
 * Replacements use specific neutral language; the LLM downstream rewrites those
 * with concrete claims.
 */
function stripBuzzwords(text) {
  if (!text) return { stripped: '', removed_count: 0, replacements: [] };
  let stripped = text;
  let count = 0;
  const replacements = [];
  for (const pattern of BUZZWORDS) {
    stripped = stripped.replace(pattern, (match) => {
      count++;
      replacements.push(match);
      return '___';
    });
  }
  return { stripped, removed_count: count, replacements };
}

/**
 * Suggest 5-10 likely Q&A pairs for a business based on industry + audience.
 * Used as starting list — LLM refines + answers them.
 */
function suggestStandardQuestions({ business }) {
  const name = business?.business_name || 'us';
  const industry = String(business?.industry || business?.business_type || '').toLowerCase();
  const local = business?.operation_model === 'location_based' || business?.operation_model === 'hybrid';
  const local_q = local ? [
    `Where is ${name} located?`,
    `What hours is ${name} open?`,
    `How do I contact ${name}?`,
  ] : [];

  const industry_q = (() => {
    if (/restaurant|cafe|bar|food/.test(industry)) return [
      `What is on ${name}'s menu?`,
      `Do you take reservations?`,
      `Do you offer delivery?`,
    ];
    if (/dent|medi|clinic|health/.test(industry)) return [
      `Do you accept new patients?`,
      `What insurance do you accept?`,
      `How do I book an appointment?`,
    ];
    if (/saas|software|app/.test(industry)) return [
      `What does ${name} do?`,
      `Do you offer a free trial?`,
      `What integrations do you support?`,
    ];
    if (/shop|store|boutique|retail/.test(industry)) return [
      `What products do you sell?`,
      `Do you ship internationally?`,
      `What is your return policy?`,
    ];
    return [
      `What does ${name} do?`,
      `Who do you serve?`,
      `How do I get started?`,
    ];
  })();

  return [...local_q, ...industry_q].slice(0, 10);
}

/**
 * Score a piece of content for AI-extractability (0-100). Used to compare
 * before/after of LLM rewrites.
 */
function scoreExtractability(text) {
  if (!text || typeof text !== 'string') return 0;
  let score = 30; // baseline

  // TL;DR / summary at top
  if (/\b(tl;?dr|in\s+short|summary|key\s+takeaway)\s*[:.]/i.test(text.slice(0, 500))) score += 15;
  // Specific numbers
  const numCount = (text.match(/\b\d{2,}\b/g) || []).length;
  score += Math.min(15, numCount * 3);
  // Questions (potential Q&A)
  const qCount = (text.match(/[^.!?\n]+\?/g) || []).length;
  score += Math.min(15, qCount * 2);
  // Bullet markers (in markdown / HTML stripped)
  const bullets = (text.match(/^[-*•]\s/gm) || []).length;
  score += Math.min(15, bullets * 2);
  // Buzzword penalty
  const buzz = stripBuzzwords(text).removed_count;
  score -= buzz * 2;
  // Definition pattern
  if (/\bis\s+(?:a|an|the)\s+\w/i.test(text.slice(0, 1000))) score += 5;
  // Comparison pattern
  if (/\bvs\.?|versus|compared\s+to|better\s+than\b/i.test(text)) score += 5;

  return Math.max(0, Math.min(100, score));
}

module.exports = {
  BUZZWORDS,
  stripBuzzwords,
  suggestStandardQuestions,
  scoreExtractability,
};
