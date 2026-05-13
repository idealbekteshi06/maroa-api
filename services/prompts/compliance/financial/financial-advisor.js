'use strict';

/**
 * Financial advisor / investment / wealth management.
 *
 * Regulators: SEC (Marketing Rule), FINRA (Rule 2210), CFP Board ethics,
 * FCA (UK), ASIC (Australia), MAS (Singapore).
 *
 * Hard refusals:
 *   - "Guaranteed returns" / "Risk-free investing"
 *   - "Beat the market" without substantiation
 *   - Cherry-picked client testimonials with specific dollar outcomes
 *     (SEC Marketing Rule §206(4)-1 requires net of fees + same-period
 *     performance)
 *   - "Make $X in Y days" trading-style claims
 *
 * Required disclosures:
 *   - "Past performance does not guarantee future results"
 *   - For RIAs: ADV brochure availability
 *   - "All investments carry risk"
 *
 * Platform restrictions:
 *   - Meta: restricted (Financial Products policy)
 *   - Google: restricted; needs financial advertiser certification
 *   - TikTok: heavily restricted for trading/investment advice
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'financial-advisor',
  name: 'Financial Advisor / Investment',
  category: COMPLIANCE_CATEGORIES.FINANCIAL,
  industries: ['financial_advisor'],
  regions: ['*'],
  regulators: ['SEC', 'FINRA', 'CFP Board', 'FCA', 'ASIC', 'MAS'],
  source_citation: 'SEC Marketing Rule §206(4)-1 (2022), FINRA Rule 2210, FCA COBS 4',
  banned_claims: [
    {
      patterns: [
        /guaranteed\b.{0,30}\b(returns?|profit|gains?|income)\b/i,
        'guaranteed returns',
        'guaranteed profit',
        'risk-free investing',
        'no risk',
        'zero risk',
      ],
      issue: 'guaranteed-return claim — SEC Marketing Rule violation',
      regulator: 'SEC',
      statute: '§206(4)-1 (Marketing Rule)',
    },
    {
      patterns: ['beat the market', 'always outperform', 'never lose money'],
      issue: 'unsubstantiated performance claim',
      regulator: 'SEC / FINRA',
      statute: 'FINRA Rule 2210(d)(1)',
    },
    {
      patterns: ['make $1000 a day', 'make $10000 a month', 'turn $100 into', 'get rich quick'],
      issue: 'specific-income trading claim — securities fraud flag',
      regulator: 'SEC',
      statute: 'Securities Act §17',
    },
    {
      patterns: ['secret strategy', 'insider tip', 'guaranteed insider'],
      issue: 'insider-trading-implication language',
      regulator: 'SEC',
      statute: '15 USC 78j(b)',
    },
  ],
  required_disclosures: [
    {
      when: 'always',
      disclosure: 'Past performance does not guarantee future results. All investments carry risk including loss of principal',
      regulator: 'SEC / FINRA',
      statute: 'SEC §206(4)-1, FINRA Rule 2210',
    },
  ],
  platform_restrictions: {
    meta: 'restricted',
    google: 'restricted',
    tiktok: 'restricted',
    linkedin: 'allowed_with_review',
  },
  examples_blocked: [
    'Guaranteed 20% returns with no risk.',
    'Make $1000 a day trading our system.',
    'I have an insider tip — get in now.',
  ],
});
