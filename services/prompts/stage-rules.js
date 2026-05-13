'use strict';

/**
 * services/prompts/stage-rules.js
 * ---------------------------------------------------------------------------
 * The 20-cell rule matrix for awareness × funnel routing.
 *
 *   awareness: unaware / problem_aware / solution_aware / product_aware / most_aware
 *   funnel:    tofu / mofu / bofu / retention
 *
 * For each cell, dictate:
 *   - recommended_frameworks  — which methodology IDs to apply
 *   - cta_style               — low-friction | medium | direct-offer | none
 *   - tone                    — curious | educational | urgent | appreciative | provocative
 *   - max_manip_risk          — summed manipulation_risk ceiling for this cell
 *   - max_length_hint         — soft word-count guidance
 *   - channel_priority        — list of channel IDs ordered by fit
 *
 * Some cells are intentionally empty (e.g. unaware × retention makes no
 * sense — a "most aware" customer is by definition NOT unaware). The
 * router refuses these as `invalid_cell`.
 *
 * Sources: synthesized from Eugene Schwartz's "Breakthrough Advertising"
 * (1966), funnel-stage marketing canon (TOFU/MOFU/BOFU is a HubSpot-era
 * codification of older AIDA-style funnels), and the methodology registry
 * applicability fields. Calibrated against the patterns we observed in
 * top-performing campaigns by industry across the public corpus.
 * ---------------------------------------------------------------------------
 */

const AWARENESS_STAGES = Object.freeze(['unaware', 'problem_aware', 'solution_aware', 'product_aware', 'most_aware']);
const FUNNEL_STAGES = Object.freeze(['tofu', 'mofu', 'bofu', 'retention']);

const CTA_STYLES = Object.freeze({
  NONE: 'none', // no CTA — pure attention / engagement
  LOW: 'low-friction', // "read more", "learn more"
  MEDIUM: 'medium', // "free trial", "see a demo"
  DIRECT: 'direct-offer', // "buy now", "subscribe", "order"
  APPRECIATIVE: 'appreciative', // "thanks for being a customer — here's X"
});

const TONES = Object.freeze({
  CURIOUS: 'curious',
  EDUCATIONAL: 'educational',
  URGENT: 'urgent',
  APPRECIATIVE: 'appreciative',
  PROVOCATIVE: 'provocative',
  EMPATHETIC: 'empathetic',
});

/**
 * The 20-cell matrix. Cells marked `invalid: true` are nonsense
 * combinations (e.g. unaware × bofu — you can't sell directly to
 * someone who doesn't know the problem exists).
 */
const MATRIX = Object.freeze({
  // ─── UNAWARE × … ───────────────────────────────────────────────────
  'unaware:tofu': {
    recommended_frameworks: ['star-story-solution', 'burnett-inherent-drama', 'mr-beast-retention', 'feed-native-laws'],
    cta_style: CTA_STYLES.NONE,
    tone: TONES.CURIOUS,
    max_manip_risk: 5,
    max_length_hint: { words_min: 30, words_max: 120 },
    channel_priority: ['tiktok', 'instagram-reels', 'youtube-shorts', 'x-post', 'meta-ads-video'],
    notes: 'Open a loop. Tell a story. No product mention. No CTA.',
  },
  'unaware:mofu': {
    invalid: true,
    reason: "an unaware customer is by definition not in MOFU — they're still TOFU",
  },
  'unaware:bofu': {
    invalid: true,
    reason: 'unaware customers cannot be in BOFU',
  },
  'unaware:retention': {
    invalid: true,
    reason: "unaware customers aren't customers yet",
  },

  // ─── PROBLEM_AWARE × … ─────────────────────────────────────────────
  'problem_aware:tofu': {
    recommended_frameworks: ['pas', 'caples-headline-types', 'schaefer-conversational-copy', 'bell-archetype-12'],
    cta_style: CTA_STYLES.LOW,
    tone: TONES.EMPATHETIC,
    max_manip_risk: 6,
    max_length_hint: { words_min: 40, words_max: 150 },
    channel_priority: ['instagram-post', 'tiktok', 'linkedin-post', 'blog-seo', 'email-cold'],
    notes: 'Name the pain in their words. Empathize. Offer to teach more — no sell yet.',
  },
  'problem_aware:mofu': {
    recommended_frameworks: ['pas', 'storybrand', 'hopkins-testimonials', 'edelman-trust-decline'],
    cta_style: CTA_STYLES.MEDIUM,
    tone: TONES.EDUCATIONAL,
    max_manip_risk: 7,
    max_length_hint: { words_min: 80, words_max: 400 },
    channel_priority: ['email-nurture', 'blog-seo', 'landing-page-long', 'linkedin-article'],
    notes: 'Pain → solution category → why our approach. Add proof.',
  },
  'problem_aware:bofu': {
    // Possible but uncommon — direct-offer to problem-aware (skipping solution + product awareness)
    recommended_frameworks: ['pas', 'hormozi-value-equation', 'kennedy-direct-response'],
    cta_style: CTA_STYLES.DIRECT,
    tone: TONES.URGENT,
    max_manip_risk: 8,
    max_length_hint: { words_min: 150, words_max: 1000 },
    channel_priority: ['sales-page', 'email-promo', 'landing-page-long'],
    notes:
      'Long-form. Walk from pain through value equation to direct offer. Use only when you have permission to skip.',
  },
  'problem_aware:retention': {
    invalid: true,
    reason: "problem-aware customers haven't bought yet",
  },

  // ─── SOLUTION_AWARE × … ─────────────────────────────────────────────
  'solution_aware:tofu': {
    recommended_frameworks: ['reeves-usp', 'bernbach-creative-revolution', 'caples-headline-types'],
    cta_style: CTA_STYLES.LOW,
    tone: TONES.PROVOCATIVE,
    max_manip_risk: 6,
    max_length_hint: { words_min: 40, words_max: 150 },
    channel_priority: ['linkedin-post', 'x-post', 'instagram-post', 'blog-seo'],
    notes: 'Lead with what makes you different. Challenge the conventional wisdom of the category.',
  },
  'solution_aware:mofu': {
    recommended_frameworks: ['reeves-usp', 'storybrand', 'fab', 'sciaba'],
    cta_style: CTA_STYLES.MEDIUM,
    tone: TONES.EDUCATIONAL,
    max_manip_risk: 7,
    max_length_hint: { words_min: 100, words_max: 500 },
    channel_priority: ['landing-page-long', 'email-nurture', 'blog-thought-leadership', 'webinar'],
    notes: 'Comparison content. Why us vs them. Real differentiators, not generic claims.',
  },
  'solution_aware:bofu': {
    recommended_frameworks: ['hormozi-value-equation', 'reeves-usp', 'cialdini-7', '4ps'],
    cta_style: CTA_STYLES.DIRECT,
    tone: TONES.URGENT,
    max_manip_risk: 9,
    max_length_hint: { words_min: 150, words_max: 800 },
    channel_priority: ['sales-page', 'email-promo', 'landing-page-long', 'meta-ads-video'],
    notes: 'Full value-equation offer. Anchor + decoy if pricing page. Real urgency.',
  },
  'solution_aware:retention': {
    invalid: true,
    reason: "solution-aware customers haven't bought yet",
  },

  // ─── PRODUCT_AWARE × … ──────────────────────────────────────────────
  'product_aware:tofu': {
    // Reminder/awareness for product-aware = brand-recall plays
    recommended_frameworks: ['bell-archetype-12', 'bernbach-creative-revolution', 'feed-native-laws'],
    cta_style: CTA_STYLES.LOW,
    tone: TONES.CURIOUS,
    max_manip_risk: 5,
    max_length_hint: { words_min: 25, words_max: 120 },
    channel_priority: ['instagram-post', 'tiktok', 'x-post'],
    notes: 'Top-of-mind plays. Brand archetype expression. Light CTA.',
  },
  'product_aware:mofu': {
    recommended_frameworks: ['hopkins-testimonials', 'lattman-credibility-hierarchy', 'fab', 'edelman-trust-decline'],
    cta_style: CTA_STYLES.MEDIUM,
    tone: TONES.EDUCATIONAL,
    max_manip_risk: 7,
    max_length_hint: { words_min: 100, words_max: 400 },
    channel_priority: ['email-nurture', 'landing-page-long', 'webinar', 'linkedin-article'],
    notes: 'Objection-handling. Proof-stacking. Case studies.',
  },
  'product_aware:bofu': {
    recommended_frameworks: ['kennedy-direct-response', 'hormozi-value-equation', 'cialdini-7', 'halbert-ps-line'],
    cta_style: CTA_STYLES.DIRECT,
    tone: TONES.URGENT,
    max_manip_risk: 9,
    max_length_hint: { words_min: 80, words_max: 500 },
    channel_priority: ['email-promo', 'sales-page', 'landing-page-long', 'meta-ads-image'],
    notes: 'Offer + price + real urgency + risk-reversal. PS line if long-form.',
  },
  'product_aware:retention': {
    invalid: true,
    reason: "product-aware customers haven't bought yet — retention is for past customers",
  },

  // ─── MOST_AWARE × … ─────────────────────────────────────────────────
  'most_aware:tofu': {
    invalid: true,
    reason: 'most-aware = past customer; TOFU is acquisition — re-engagement belongs in retention',
  },
  'most_aware:mofu': {
    invalid: true,
    reason: 'most-aware = past customer; MOFU is consideration — belongs in retention',
  },
  'most_aware:bofu': {
    // The "buy now, you know us" flow — one-click reorder / upgrade
    recommended_frameworks: ['kennedy-direct-response', 'halbert-ps-line', 'cialdini-7'],
    cta_style: CTA_STYLES.DIRECT,
    tone: TONES.URGENT,
    max_manip_risk: 7,
    max_length_hint: { words_min: 20, words_max: 100 },
    channel_priority: ['email-promo', 'sms', 'whatsapp'],
    notes: 'Bare-offer copy. They know you. Headline + price + button.',
  },
  'most_aware:retention': {
    recommended_frameworks: [
      'schaefer-conversational-copy',
      'edelman-trust-decline',
      'hopkins-testimonials',
      'cialdini-7', // reciprocity for loyalty perks
    ],
    cta_style: CTA_STYLES.APPRECIATIVE,
    tone: TONES.APPRECIATIVE,
    max_manip_risk: 4,
    max_length_hint: { words_min: 30, words_max: 200 },
    channel_priority: ['email-retention', 'sms', 'whatsapp', 'instagram-stories'],
    notes: 'Thank-you tone. Loyalty perks. Referral asks. Soft sells only.',
  },
});

module.exports = {
  AWARENESS_STAGES,
  FUNNEL_STAGES,
  CTA_STYLES,
  TONES,
  MATRIX,
};
