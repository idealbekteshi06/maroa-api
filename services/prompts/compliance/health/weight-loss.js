'use strict';

/**
 * Weight-loss programs / products.
 *
 * Regulators: FTC (Gateway Health Products), FDA, plus Meta personal-
 * attributes policy.
 *
 * Hard refusals (FTC Gateway list — these are #1 advertising-fraud
 * categories):
 *   - "Lose X lbs without diet or exercise"
 *   - Specific weight loss in specific time
 *   - "Permanent" / "guaranteed" weight loss
 *   - Before/after body images in Meta/Google ads
 *
 * Required disclosures:
 *   - Typical results disclaimer
 *   - "When used with diet and exercise" if specific outcomes shown
 *
 * Platform restrictions:
 *   - Meta: banned for personal-attribute targeting ("you're overweight")
 *   - Google: heavily restricted
 *   - TikTok: weight-loss-product ads heavily restricted
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'weight-loss',
  name: 'Weight Loss',
  category: COMPLIANCE_CATEGORIES.HEALTH,
  industries: ['gym_fitness', 'wellness_spa', 'ecommerce_supplements'],
  regions: ['*'],
  regulators: ['FTC', 'FDA', 'Meta Advertising Policies'],
  source_citation: 'FTC Gateway Health Products Compliance Guide (2022), Meta Personal Attributes Policy',
  banned_claims: [
    {
      patterns: ['without diet', 'without exercise', 'no diet needed', 'eat whatever you want'],
      issue: 'FTC Gateway claim — "lose weight without diet/exercise"',
      regulator: 'FTC',
      statute: 'FTC Gateway Health Products Compliance Guide §IV.A',
    },
    {
      patterns: ['lose 10 lbs in a week', 'lose 20 lbs in a month', 'lose 30 lbs fast', 'rapid weight loss', 'instant weight loss'],
      issue: 'specific weight outcome in specific time — unsubstantiated',
      regulator: 'FTC',
      statute: 'FTC Gateway §IV.B',
    },
    {
      patterns: ['permanent weight loss', 'guaranteed weight loss', 'never gain it back'],
      issue: 'permanence/guarantee claim — FTC red flag',
      regulator: 'FTC',
    },
    {
      patterns: [
        /\b(you'?re|are\s+you)\s+(overweight|fat|obese)/i,
        "you're overweight",
        'are you overweight',
        'are you fat',
        "you're obese",
      ],
      issue: 'Meta personal-attributes policy violation — auto-disapproval',
      regulator: 'Meta',
    },
    {
      patterns: ['melt fat', 'burn belly fat overnight', 'targeted fat loss'],
      issue: 'pseudoscience claim — FTC + FDA flag',
      regulator: 'FTC / FDA',
    },
  ],
  required_disclosures: [
    {
      when: 'if_claim_present:results',
      disclosure: 'Results may vary. Typical results: [specific number]',
      regulator: 'FTC',
      statute: 'FTC Endorsement Guides 16 CFR 255',
    },
  ],
  platform_restrictions: {
    meta: 'banned',
    google: 'restricted',
    tiktok: 'restricted',
    linkedin: 'allowed',
  },
  examples_blocked: [
    'Lose 20 lbs without diet or exercise.',
    'Are you overweight? Try our program.',
    'Permanent weight loss guaranteed.',
  ],
});
