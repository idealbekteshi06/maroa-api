'use strict';

/**
 * Cannabis — THC, CBD, hemp (regulation varies by state/country).
 *
 * Regulators: State cannabis control boards (US), FDA (CBD/hemp food),
 * DEA (federal Schedule I), Health Canada (cannabis), MHRA (UK).
 *
 * Hard refusals:
 *   - Therapeutic / disease claims for any cannabinoid product
 *   - "Get high" / direct-recreational copy
 *   - Targeting minors
 *   - Cross-state THC shipping language (still federal violation)
 *
 * Required disclosures:
 *   - 21+ age gate (US legal states)
 *   - "FDA has not evaluated" for CBD/hemp claims
 *   - State-specific warnings (CA Prop 65, etc.)
 *
 * Platform restrictions:
 *   - Meta: banned (THC), restricted (topical CBD with conditions)
 *   - Google: cannabis ads banned in most regions
 *   - TikTok: banned
 *   - Reddit + some podcast networks: allowed with restrictions
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'cannabis',
  name: 'Cannabis / THC / CBD',
  category: COMPLIANCE_CATEGORIES.REGULATED_SUBSTANCES,
  industries: [],
  regions: ['US', 'CA', 'EU', 'GLOBAL'],
  regulators: ['State Cannabis Control', 'FDA', 'DEA', 'Health Canada', 'MHRA'],
  source_citation: 'FD&C Act 21 USC 343, State cannabis statutes, Meta + Google ad policies',
  banned_claims: [
    {
      patterns: ['cures cancer', 'treats anxiety', 'cures pain', 'cures insomnia', 'replaces medication'],
      issue: 'therapeutic disease claim — FDA prohibits for cannabis/CBD',
      regulator: 'FDA',
      statute: 'FD&C Act 21 USC 343',
    },
    {
      patterns: ['get high', 'get stoned', 'best high', 'get blazed'],
      issue: 'direct-recreational claim — Meta/Google policy violation + minor-targeting risk',
      regulator: 'Meta / Google',
    },
    {
      patterns: ['ship anywhere', 'ship to all 50 states', 'cross-border thc'],
      issue: 'implies federal-violation interstate shipment',
      regulator: 'DEA',
      statute: 'Controlled Substances Act',
    },
    {
      patterns: ['for kids', 'youth-friendly', 'great for teens'],
      issue: 'targeting minors — banned in all legal states',
      regulator: 'State Cannabis Control',
    },
  ],
  required_disclosures: [
    {
      when: 'always',
      disclosure: '21+ only. The FDA has not evaluated this product. Keep out of reach of children',
      regulator: 'FDA / State',
    },
  ],
  platform_restrictions: {
    meta: 'banned',
    google: 'banned',
    tiktok: 'banned',
    linkedin: 'banned',
    reddit: 'restricted',
  },
  examples_blocked: [
    'This CBD cures cancer.',
    "Best high you'll ever experience — ship anywhere.",
    'CBD gummies for kids.',
  ],
});
