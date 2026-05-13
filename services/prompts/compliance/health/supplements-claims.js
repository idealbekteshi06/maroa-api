'use strict';

/**
 * Supplements / nutraceuticals — FDA structure/function vs disease claims.
 *
 * Regulators: FDA (DSHEA), FTC (advertising substantiation), Health Canada,
 * MHRA (UK).
 *
 * The core rule under DSHEA (Dietary Supplement Health and Education Act):
 * supplements may NOT claim to "treat, prevent, diagnose, or cure" any
 * disease. Structure/function claims allowed ("supports immune health")
 * but require an FDA disclaimer.
 *
 * Hard refusals:
 *   - Disease claims ("treats arthritis", "prevents Alzheimer's")
 *   - Drug-like language ("clinically proven to cure")
 *   - Before/after weight-loss images attached to supplement copy
 *
 * Required disclosures:
 *   - The FDA disclaimer: "This statement has not been evaluated by the
 *     FDA. This product is not intended to diagnose, treat, cure, or
 *     prevent any disease."
 *
 * Platform restrictions:
 *   - Meta: restricted (Health & Wellness)
 *   - Google: restricted (drug-claim words trigger disapproval)
 *   - TikTok: heavily restricted; some supplement ads banned
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'supplements-claims',
  name: 'Supplements / Nutraceuticals',
  category: COMPLIANCE_CATEGORIES.HEALTH,
  industries: ['ecommerce_supplements'],
  regions: ['US', 'CA', 'UK', 'EU', 'GLOBAL'],
  regulators: ['FDA', 'FTC', 'Health Canada', 'MHRA'],
  source_citation: 'DSHEA (1994), FDA 21 USC 343, FTC Health Products Compliance Guide (2022)',
  banned_claims: [
    {
      patterns: [
        /\b(treats?|cures?|prevents?)\s+(arthritis|diabetes|cancer|alzheimer'?s?|depression|hypertension|covid)/i,
        'treats arthritis',
        'cures diabetes',
        'cures cancer',
      ],
      issue: 'disease claim — DSHEA-prohibited',
      regulator: 'FDA',
      statute: 'DSHEA §6, 21 USC 343(r)(6)',
      suggestion: 'Reframe as structure/function: "supports joint comfort" not "treats arthritis".',
    },
    {
      patterns: ['clinically proven to cure', 'fda approved drug', 'pharmaceutical-grade cure'],
      issue: 'drug-claim language for a non-drug',
      regulator: 'FDA',
      statute: '21 USC 352',
    },
    {
      patterns: ['lose 20 lbs', 'lose 30 lbs', 'guaranteed weight loss'],
      issue: 'specific weight-loss outcome promise',
      regulator: 'FTC',
      statute: 'FTC Health Products Compliance Guide §IV',
    },
    {
      patterns: ['miracle pill', 'magic bullet', 'instant cure'],
      issue: 'unsubstantiated hyperbole — FTC deceptive-advertising flag',
      regulator: 'FTC',
      statute: '15 USC 45',
    },
  ],
  required_disclosures: [
    {
      when: 'always',
      disclosure:
        'This statement has not been evaluated by the FDA. This product is not intended to diagnose, treat, cure, or prevent any disease.',
      regulator: 'FDA',
      statute: 'DSHEA §6 / 21 CFR 101.93',
    },
  ],
  platform_restrictions: {
    meta: 'restricted',
    google: 'restricted',
    tiktok: 'restricted',
    linkedin: 'allowed',
  },
  examples_blocked: [
    'This supplement cures diabetes.',
    'Clinically proven to prevent Alzheimer\'s.',
    'Take this miracle pill to lose 20 lbs in 30 days.',
  ],
});
