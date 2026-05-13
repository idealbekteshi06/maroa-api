'use strict';

/**
 * Mortgage broker / home lending.
 *
 * Regulators: CFPB (TILA, RESPA, ECOA), HUD (Fair Housing), state DFI,
 * FCA (UK MCOB).
 *
 * Hard refusals:
 *   - APR claims without disclosure of all terms (TILA §226.24)
 *   - Specific monthly payment without disclosure of full amortization
 *   - Discriminatory targeting based on protected class (ECOA, Fair
 *     Housing — race, color, religion, national origin, sex, marital
 *     status, age, source of income, familial status, handicap)
 *
 * Required disclosures:
 *   - "Equal Housing Lender" (federally chartered mortgage lenders)
 *   - APR + terms + fees if a specific rate is advertised
 *   - NMLS ID (state requirement for individual MLOs)
 *
 * Platform restrictions:
 *   - Meta: special category restrictions (no detailed targeting; Housing
 *     special-ad category)
 *   - Google: financial advertiser certification required
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'mortgage-broker',
  name: 'Mortgage / Home Lending',
  category: COMPLIANCE_CATEGORIES.FINANCIAL,
  industries: ['mortgage_broker'],
  regions: ['*'],
  regulators: ['CFPB', 'HUD', 'State DFI', 'FCA-MCOB'],
  source_citation: 'TILA Reg Z 12 CFR 1026.24, RESPA 12 USC 2607, ECOA 15 USC 1691, Fair Housing 42 USC 3604',
  banned_claims: [
    {
      patterns: ['guaranteed approval', 'guaranteed loan', '100% approval', 'no credit check'],
      issue: 'guaranteed-approval claim — CFPB deceptive-practice flag',
      regulator: 'CFPB',
      statute: 'TILA / UDAAP',
    },
    {
      patterns: [
        /\b(lowest|best|unbeatable)\s+(rate|rates)\b/i,
        'lowest rate ever',
        'unbeatable rate',
        'best rate in the market',
      ],
      issue: 'unsubstantiated rate superlative',
      regulator: 'CFPB',
      statute: 'TILA Reg Z 12 CFR 1026.24',
    },
    {
      patterns: [
        /\b(perfect|great|ideal|wonderful)\s+(\w+\s+){0,3}(for\s+)?(young couples?|families|singles|retirees|seniors)/i,
        'perfect for young couples',
        'great for families',
        'ideal for retirees',
      ],
      issue: 'protected-class targeting language — Fair Housing violation',
      regulator: 'HUD',
      statute: 'Fair Housing Act 42 USC 3604',
    },
  ],
  required_disclosures: [
    {
      when: 'if_claim_present:apr',
      disclosure: 'APR shown reflects [specific terms]. Equal Housing Lender. NMLS #XXX',
      regulator: 'CFPB',
      statute: 'TILA Reg Z 12 CFR 1026.24(d)',
    },
    {
      when: 'always',
      disclosure: 'Equal Housing Lender',
      regulator: 'HUD',
    },
  ],
  platform_restrictions: {
    meta: 'restricted', // Housing special-ad category
    google: 'restricted',
    tiktok: 'restricted',
    linkedin: 'allowed',
  },
  examples_blocked: [
    'Guaranteed approval — no credit check needed.',
    'Lowest rate in the market, guaranteed.',
    'Perfect mortgage for young couples in [neighborhood].',
  ],
});
