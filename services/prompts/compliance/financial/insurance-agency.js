'use strict';

/**
 * Insurance — auto, home, health, life.
 *
 * Regulators: State Insurance Departments, NAIC, ACA (health), FCA (UK),
 * IRDAI (India), MAS (Singapore).
 *
 * Hard refusals:
 *   - "Cheapest policy" without substantiation
 *   - "Guaranteed approval" health/life claims
 *   - Specific premium quotes without underwriting disclosure
 *
 * Required disclosures:
 *   - State license # for insurance agents
 *   - "Coverage depends on underwriting" if any premium is mentioned
 *   - "Premiums shown are estimates" if specific dollar amounts are used
 *
 * Platform restrictions:
 *   - Meta: restricted; some health-insurance ads restricted by state
 *   - Google: financial advertiser certification required
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'insurance-agency',
  name: 'Insurance Agency',
  category: COMPLIANCE_CATEGORIES.FINANCIAL,
  industries: ['insurance_agency'],
  regions: ['*'],
  regulators: ['State Insurance Departments', 'NAIC', 'ACA', 'FCA', 'IRDAI', 'MAS'],
  source_citation: 'NAIC Unfair Trade Practices Act, state insurance code',
  banned_claims: [
    {
      patterns: [
        /guaranteed\s+(\w+\s+){0,3}(approval|coverage|policy|insurance)/i,
        'guaranteed approval',
        'no medical exam ever',
        'everyone approved',
        'guaranteed coverage',
        'everyone qualifies',
      ],
      issue: 'guaranteed-coverage claim — state insurance code violation in most states',
      regulator: 'State Insurance Departments',
    },
    {
      patterns: ['cheapest insurance', 'lowest premium ever', 'unbeatable price'],
      issue: 'unsubstantiated price superlative',
      regulator: 'NAIC',
      statute: 'Unfair Trade Practices Act',
    },
    {
      patterns: ['save 50% on insurance', 'save 70% on insurance', 'save 80% on insurance'],
      issue: 'unsubstantiated savings claim',
      regulator: 'State Insurance Departments / FTC',
    },
  ],
  required_disclosures: [
    {
      when: 'if_claim_present:premium',
      disclosure: 'Premium shown is an estimate. Final premium depends on underwriting. License #XXX',
      regulator: 'State Insurance Departments',
    },
  ],
  platform_restrictions: {
    meta: 'restricted',
    google: 'restricted',
    tiktok: 'restricted',
    linkedin: 'allowed',
  },
  examples_blocked: [
    'Guaranteed insurance coverage — everyone qualifies.',
    'Save 80% on insurance — cheapest in the market.',
    'No medical exam ever required for life insurance.',
  ],
});
