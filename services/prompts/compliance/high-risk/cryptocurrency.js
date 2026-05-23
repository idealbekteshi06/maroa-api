'use strict';

/**
 * Cryptocurrency / digital assets / DeFi / NFT.
 *
 * Regulators: SEC (US securities), CFTC (commodities), FCA (UK), ESMA
 * (EU MiCA), AMF (France), BaFin (Germany), MAS (Singapore).
 *
 * Hard refusals:
 *   - Investment-advice framing without licensing
 *   - "Guaranteed returns" / "Risk-free" crypto
 *   - Pump signals / "moon" / "to the moon" promotional language
 *   - Cherry-picked portfolio gains
 *   - Pre-launch / ICO / unregistered-securities offerings
 *
 * Required disclosures:
 *   - Volatility / loss-of-principal warning
 *   - "Crypto is speculative" / "not FDIC insured"
 *   - Regulatory status in jurisdiction
 *
 * Platform restrictions:
 *   - Meta: restricted; requires written approval per cryptocurrency
 *     advertising policy
 *   - Google: requires certification + only in approved countries
 *   - TikTok: heavily restricted
 *   - Twitter/X: largely allowed (with heavy crypto-scam moderation)
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'cryptocurrency',
  name: 'Cryptocurrency / Digital Assets',
  category: COMPLIANCE_CATEGORIES.HIGH_RISK,
  industries: [],
  regions: ['*'],
  regulators: ['SEC', 'CFTC', 'FCA', 'ESMA-MiCA', 'AMF', 'BaFin', 'MAS'],
  source_citation: 'SEC v. Howey (1946), MiCA Regulation 2023/1114, FCA PERG 8',
  banned_claims: [
    {
      patterns: ['guaranteed crypto returns', 'risk-free crypto', '100% gains guaranteed', 'guaranteed pump'],
      issue: 'guaranteed-return crypto claim — securities-fraud flag',
      regulator: 'SEC / FCA',
      statute: 'Securities Act §17',
    },
    {
      patterns: ['to the moon', 'guaranteed moon', 'pump signal', 'insider pump', 'guaranteed 100x'],
      issue: 'pump/manipulation language — market-manipulation flag',
      regulator: 'SEC / CFTC',
    },
    {
      patterns: [
        'turn $100 into $1 million',
        'turn $1000 into $10 million',
        'get rich with crypto',
        'guaranteed riches',
      ],
      issue: 'unsubstantiated specific-return claim',
      regulator: 'SEC',
      statute: 'Securities Act §17',
    },
    {
      patterns: ['ico opportunity', 'pre-launch token', 'unregistered offering'],
      issue: 'may be unregistered securities — SEC Howey test',
      regulator: 'SEC',
      statute: 'SEC v. Howey',
    },
  ],
  required_disclosures: [
    {
      when: 'always',
      disclosure: 'Cryptocurrency is speculative and high-risk. Not FDIC insured. You may lose your entire investment',
      regulator: 'SEC / FCA',
    },
  ],
  platform_restrictions: {
    meta: 'restricted',
    google: 'restricted',
    tiktok: 'restricted',
    linkedin: 'restricted',
  },
  examples_blocked: [
    'Turn $100 into $1 million — guaranteed 100x pump.',
    'Insider pump signal — to the moon, guaranteed.',
    'Pre-launch token — get in before the ICO.',
  ],
});
