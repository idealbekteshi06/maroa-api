'use strict';

/**
 * Blog post (SEO-optimized) — written to rank for a specific keyword.
 *
 * Sources: Ahrefs + SEMrush + Brian Dean (Backlinko) 2025 SEO playbooks.
 *
 * What performs:
 *   - 1500-3000 words (Google's "skyscraper" effect for competitive
 *     keywords)
 *   - Keyword in H1, first paragraph, and 3-5 H2s
 *   - Answers the search intent in the first 100 words (above the fold)
 *   - Internal + external linking (1 internal per 200 words)
 *   - Original data, screenshots, or case study (E-E-A-T signals)
 *
 * What underperforms:
 *   - Generic listicle written by AI without specific data
 *   - Keyword stuffing
 *   - Thin content (<800 words for competitive terms)
 *   - No author byline (E-E-A-T)
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'blog-seo',
  name: 'Blog (SEO)',
  category: CHANNEL_CATEGORIES.WEB,
  surface_type: 'long_form',
  source_citation: 'Ahrefs + Backlinko 2025 SEO Playbooks',
  channel_ids: ['blog-seo'],
  format_rules: {
    length_window: { min: 1200, max: 3000, ideal: 1800 },
    keyword_in_h1: true,
    keyword_in_first_paragraph: true,
    h2_count: { min: 3, max: 8 },
    emoji_use: 'none',
  },
  hook_patterns: [
    {
      name: 'Listicle title',
      template: '"[N] [things] for [outcome] in [year]"',
      why: 'Listicles rank for "best X" queries',
    },
    {
      name: 'How-to title',
      template: '"How to [outcome] (Step-by-Step)"',
      why: 'How-to queries are the largest search type',
    },
    {
      name: 'Comparison title',
      template: '"[Tool A] vs [Tool B]: [Specific Use Case]"',
      why: 'High-intent commercial queries',
    },
    {
      name: 'Definition title',
      template: '"What is [thing]? Definition + Examples"',
      why: 'Featured-snippet eligible',
    },
  ],
  anti_patterns: [
    { pattern: 'in conclusion', why: 'Filler — cut it' },
    { pattern: 'in this article', why: "Filler — show, don't announce" },
    { pattern: "in today's digital landscape", why: 'AI-tell phrase — Critic flag' },
    { pattern: 'unleash the power of', why: 'AI-tell phrase — Critic flag' },
  ],
  retention_mechanics: [
    'keyword in H1 + first 100 words + 3-5 H2s',
    'answers search intent above the fold',
    '1 internal link per 200 words',
    'original data / screenshot / case study (E-E-A-T)',
    'author byline + bio (E-E-A-T)',
  ],
  invariants: [
    { id: 'keyword-coverage', rule: 'Target keyword in H1 + first paragraph', kind: 'must_have' },
    { id: 'min-length', rule: '≥1200 words for competitive queries', kind: 'must_have' },
    { id: 'no-ai-tell', rule: 'No "unleash the power of" / "in today\'s digital landscape"', kind: 'must_avoid' },
  ],
  manipulation_risk: 0,
});
