'use strict';

/**
 * Tobacco / Vape / E-cigarettes.
 *
 * Regulators: FDA Tobacco Products (US), Tobacco Control Act, FCTC (WHO
 * Framework Convention), state e-cig laws.
 *
 * Hard refusals:
 *   - Health claims ("safer than smoking" — FDA prohibits without
 *     authorized order)
 *   - "Helps you quit smoking" without FDA cessation-product clearance
 *   - Flavored / candy-style marketing (FDA flavored-vape enforcement)
 *   - Targeting minors
 *
 * Required disclosures:
 *   - US Surgeon General warnings (per FDA Deeming Rule)
 *   - 21+ in US (Tobacco 21 Act)
 *
 * Platform restrictions:
 *   - Meta: BANNED across all surfaces
 *   - Google: BANNED
 *   - TikTok: BANNED
 *   - LinkedIn: BANNED
 *   - Only owned channels (email, SMS to opted-in 21+) allowed
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'tobacco-vape',
  name: 'Tobacco / Vape',
  category: COMPLIANCE_CATEGORIES.REGULATED_SUBSTANCES,
  industries: [],
  regions: ['*'],
  regulators: ['FDA', 'WHO FCTC', 'Tobacco Control Act'],
  source_citation: 'Family Smoking Prevention and Tobacco Control Act (2009), FDA Deeming Rule (2016), WHO FCTC Art. 13',
  banned_claims: [
    {
      patterns: ['safer than smoking', 'healthier than cigarettes', 'safe alternative'],
      issue: 'comparative health claim — FDA Deeming Rule requires authorized order',
      regulator: 'FDA',
      statute: 'FDA Deeming Rule §1141',
    },
    {
      patterns: ['helps you quit smoking', 'smoking cessation', 'stop smoking with'],
      issue: 'cessation claim — requires FDA cessation-product clearance',
      regulator: 'FDA',
      statute: '21 USC 387',
    },
    {
      patterns: ['for teens', 'cool kids', 'candy flavor', 'gummy flavor', 'cotton candy'],
      issue: 'youth-targeting flavor language — FDA enforcement priority',
      regulator: 'FDA',
      statute: 'FDA flavored ENDS enforcement (2020+)',
    },
  ],
  required_disclosures: [
    {
      when: 'always',
      disclosure: 'WARNING: This product contains nicotine. Nicotine is an addictive chemical. 21+ only',
      regulator: 'FDA',
      statute: 'FDA Deeming Rule §1143',
    },
  ],
  platform_restrictions: {
    meta: 'banned',
    google: 'banned',
    tiktok: 'banned',
    linkedin: 'banned',
  },
  examples_blocked: [
    'Vaping is safer than smoking.',
    'Helps you quit smoking — guaranteed.',
    'Cotton candy flavor that teens love.',
  ],
});
