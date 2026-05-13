'use strict';

/**
 * Cosmetics / personal care — FDA cosmetic vs drug distinction.
 *
 * Regulators: FDA (FD&C Act, MoCRA 2022), FTC, EU Cosmetics Regulation
 * 1223/2009.
 *
 * Core rule: a "cosmetic" makes ONLY appearance claims. The moment copy
 * claims structural change ("rebuilds collagen", "cures acne"), the
 * product is reclassified as a drug — requires FDA approval, which most
 * brands haven't obtained.
 *
 * Hard refusals:
 *   - "Cures acne" / "treats wrinkles" / "rebuilds skin"
 *   - "Anti-aging" claim WITHOUT cosmetic qualifier (e.g. "anti-aging
 *     appearance" is OK, "anti-aging cream" alone implies drug)
 *   - "Clinically proven to repair" structural change claims
 *
 * Required disclosures:
 *   - EU: ingredients list (INCI) — required for any cosmetic ad
 *   - "May vary" near visible-result claims
 *
 * Platform restrictions:
 *   - Meta: restricted before/after for skin/body
 *   - Google: drug-claim words auto-disapproved
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'cosmetics-claims',
  name: 'Cosmetics / Personal Care',
  category: COMPLIANCE_CATEGORIES.HEALTH,
  industries: ['ecommerce_beauty', 'cosmetics_brand', 'salon_beauty'],
  regions: ['*'],
  regulators: ['FDA', 'FTC', 'EU Cosmetics Regulation', 'Health Canada'],
  source_citation: 'FD&C Act 21 USC 321(i), MoCRA 2022, EU Regulation 1223/2009, FTC Truth in Advertising',
  banned_claims: [
    {
      patterns: [
        /\b(cures?|treats?|eliminates?|rebuilds?|reverses?)\s+(acne|wrinkles?|aging|collagen|scars?)/i,
        'cures acne',
        'rebuild collagen',
        'rebuilds collagen',
      ],
      issue: 'drug claim — reclassifies cosmetic as drug under FDA',
      regulator: 'FDA',
      statute: 'FD&C Act 21 USC 321(g)',
      suggestion: 'Reframe to appearance: "reduces the appearance of wrinkles" not "treats wrinkles".',
    },
    {
      patterns: ['clinically proven to repair', 'medical-grade cure', 'pharmaceutical-grade treatment'],
      issue: 'drug-claim language for cosmetic',
      regulator: 'FDA',
    },
    {
      patterns: [
        /100\s*%\s*(wrinkle|acne|scar)/i,
        '100% wrinkle-free',
        '100% wrinkle elimination',
        'completely eliminates',
      ],
      issue: 'unsubstantiated absolute outcome',
      regulator: 'FTC',
      statute: '15 USC 45',
    },
  ],
  required_disclosures: [
    {
      when: 'if_claim_present:wrinkle',
      disclosure: 'Reduces the appearance of [claim]. Results may vary',
      regulator: 'FDA / FTC',
    },
  ],
  platform_restrictions: {
    meta: 'restricted',
    google: 'restricted',
    tiktok: 'allowed',
    linkedin: 'allowed',
  },
  examples_blocked: [
    'This cream cures acne.',
    'Clinically proven to rebuild collagen.',
    '100% wrinkle elimination in 7 days.',
  ],
});
