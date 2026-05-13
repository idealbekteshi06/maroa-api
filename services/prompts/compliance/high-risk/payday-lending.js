'use strict';

/**
 * Payday loans / short-term high-interest lending.
 *
 * Regulators: CFPB (US), state usury laws, FCA (UK HCSTC), Military
 * Lending Act (US service members).
 *
 * Hard refusals:
 *   - "Guaranteed approval" / "No credit check"
 *   - Specific APRs in ads without TILA disclosure
 *   - Targeting financially distressed populations (CFPB UDAAP)
 *   - Targeting active military or dependents (Military Lending Act 36%
 *     cap)
 *
 * Required disclosures:
 *   - TILA Reg Z APR + total cost
 *   - State-specific licensing
 *   - State usury caps (rates vary widely)
 *
 * Platform restrictions:
 *   - Meta: payday/personal-loan ads heavily restricted; banned in some
 *     regions
 *   - Google: payday loans BANNED; APR > 36% disallowed
 *   - TikTok: payday lending BANNED
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'payday-lending',
  name: 'Payday / Short-Term Lending',
  category: COMPLIANCE_CATEGORIES.HIGH_RISK,
  industries: [],
  regions: ['*'],
  regulators: ['CFPB', 'State Usury Laws', 'FCA-HCSTC', 'Military Lending Act'],
  source_citation: 'TILA Reg Z 12 CFR 1026, CFPB UDAAP, FCA CONC 5A',
  banned_claims: [
    {
      patterns: ['guaranteed approval', '100% approval', 'no credit check', 'guaranteed loan'],
      issue: 'guaranteed-approval claim — CFPB UDAAP flag',
      regulator: 'CFPB',
      statute: 'TILA / UDAAP',
    },
    {
      patterns: ['solve all your money problems', 'escape your debt cycle fast', 'guaranteed cash now'],
      issue: 'preys on financially distressed — CFPB UDAAP violation',
      regulator: 'CFPB',
      statute: 'UDAAP §1031',
    },
    {
      patterns: ['for military', 'for active duty', 'for service members'],
      issue: 'targeting military — Military Lending Act 36% cap applies',
      regulator: 'DoD',
      statute: 'Military Lending Act 10 USC 987',
    },
  ],
  required_disclosures: [
    {
      when: 'if_claim_present:apr',
      disclosure: 'APR shown reflects loan terms. State licensing applies. See full TILA disclosure',
      regulator: 'CFPB',
      statute: 'TILA Reg Z',
    },
  ],
  platform_restrictions: {
    meta: 'restricted',
    google: 'banned',
    tiktok: 'banned',
    linkedin: 'restricted',
  },
  examples_blocked: [
    'Guaranteed cash now — no credit check needed.',
    'Loans for active duty service members — guaranteed approval.',
    'Solve all your money problems with one quick loan.',
  ],
});
