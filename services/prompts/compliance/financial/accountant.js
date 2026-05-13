'use strict';

/**
 * Accountant / CPA / Bookkeeping.
 *
 * Regulators: AICPA (Code of Conduct), state Board of Accountancy, IRS
 * Circular 230 (tax practitioner ads), ACCA (UK).
 *
 * Hard refusals:
 *   - "Guaranteed tax refund" / "Guaranteed savings"
 *   - "IRS-approved tax strategy" (the IRS doesn't endorse strategies)
 *   - Testimonials with specific dollar tax savings (most state boards
 *     restrict)
 *
 * Required disclosures:
 *   - CPA license # for licensed CPAs
 *   - "Past results don't predict future tax outcomes"
 *
 * Platform restrictions:
 *   - Meta + Google + TikTok: allowed (with substantiation)
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'accountant',
  name: 'Accountant / CPA',
  category: COMPLIANCE_CATEGORIES.FINANCIAL,
  industries: ['accountant', 'bookkeeper'],
  regions: ['*'],
  regulators: ['AICPA', 'State Board of Accountancy', 'IRS Circular 230', 'ACCA'],
  source_citation: 'AICPA Code of Professional Conduct §1.400, IRS Circular 230 §10.30',
  banned_claims: [
    {
      patterns: [
        /guaranteed\s+(\w+\s+){0,3}(tax\s+)?refund/i,
        /(maximum|biggest|largest)\s+refund\s+guaranteed/i,
        'guaranteed tax refund',
        'guaranteed refund',
        'maximum refund guaranteed',
      ],
      issue: 'guaranteed-refund claim — AICPA Code violation',
      regulator: 'AICPA / State Board of Accountancy',
      statute: 'AICPA Code §1.400.090',
    },
    {
      patterns: ['irs-approved tax strategy', 'irs-endorsed', 'government-endorsed plan'],
      issue: 'false agency endorsement claim',
      regulator: 'IRS',
      statute: 'Circular 230 §10.30',
    },
    {
      patterns: [
        /save\s+\$[\d,]+\s+(in\s+)?(taxes|on\s+taxes)/i,
        /\$[\d,]+\s+in\s+taxes\s+(this\s+year)?,?\s*guaranteed/i,
        'save $10000 in taxes',
        'pay zero taxes legally',
      ],
      issue: 'unsubstantiated specific tax outcome',
      regulator: 'AICPA',
    },
  ],
  required_disclosures: [
    {
      when: 'if_claim_present:cpa',
      disclosure: 'Licensed CPA #XXX in [State]. Past tax outcomes do not predict future results',
      regulator: 'State Board of Accountancy',
    },
  ],
  platform_restrictions: {
    meta: 'allowed',
    google: 'allowed',
    tiktok: 'allowed',
    linkedin: 'allowed',
  },
  examples_blocked: [
    'Guaranteed maximum tax refund — no exceptions.',
    'IRS-approved strategy to pay zero taxes legally.',
    'Save $20,000 in taxes this year, guaranteed.',
  ],
});
