'use strict';

/**
 * Law firm / attorney marketing.
 *
 * Regulators: ABA Model Rules + State Bar advertising rules (varies
 * widely by state), SRA (UK Solicitors Regulation Authority).
 *
 * Hard refusals (vary by state but generally):
 *   - "Best lawyer" / "Top lawyer" (NY, FL, etc. prohibit superlatives
 *     without empirical proof)
 *   - Specific outcomes / dollar verdicts without disclaimer
 *   - Testimonial outcomes without state-required disclaimer (FL, NY, OH)
 *   - Promising results
 *
 * Required disclosures:
 *   - "Past results don't guarantee similar outcomes"
 *   - "Attorney advertising" (NY required)
 *   - Bar #/admitted-in-state
 *
 * Platform restrictions:
 *   - Meta + Google: allowed with substantiation
 *   - TikTok: allowed; some state bars warn against
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'legal-practice',
  name: 'Legal Practice / Attorney',
  category: COMPLIANCE_CATEGORIES.LEGAL_HOUSING,
  industries: ['legal_practice'],
  regions: ['*'],
  regulators: ['ABA Model Rules', 'State Bars', 'SRA (UK)'],
  source_citation: 'ABA Model Rules 7.1 + 7.2, NY Rules of Professional Conduct 7.1, FL Bar Rule 4-7',
  banned_claims: [
    {
      patterns: [
        /\b(best|top|#1|leading)\s+(\w+(-\w+)?\s+){0,3}(lawyer|attorney|law\s+firm)\b/i,
        'best lawyer',
        'top lawyer',
        '#1 attorney',
        'leading lawyer',
      ],
      issue: 'superlative without empirical proof — multiple state bars prohibit',
      regulator: 'State Bars',
      statute: 'NY Rules 7.1, FL Bar 4-7.13',
    },
    {
      patterns: ['guaranteed verdict', 'guaranteed win', 'will win your case', '100% case-win'],
      issue: 'outcome guarantee — ABA Model Rule 7.1 violation',
      regulator: 'ABA / State Bars',
      statute: 'ABA Model Rule 7.1',
    },
    {
      patterns: ['won $1 million', 'recovered $5 million', 'won $10 million'],
      issue: 'specific verdict without state-required disclaimer',
      regulator: 'State Bars',
      statute: 'FL Bar 4-7.13(b)',
    },
  ],
  required_disclosures: [
    {
      when: 'if_claim_present:result',
      disclosure: 'Past results do not guarantee similar outcomes. Attorney advertising. Bar #XXX',
      regulator: 'State Bars',
    },
    {
      when: 'if_claim_present:verdict',
      disclosure: 'The hiring of a lawyer is an important decision that should not be based solely on advertisements',
      regulator: 'ABA',
      statute: 'ABA Model Rule 7.2',
    },
  ],
  platform_restrictions: {
    meta: 'allowed',
    google: 'allowed',
    tiktok: 'allowed',
    linkedin: 'allowed',
  },
  examples_blocked: [
    'Best personal-injury lawyer in the city.',
    'Guaranteed verdict — 100% case-win rate.',
    'Recovered $5 million for our clients.',
  ],
});
