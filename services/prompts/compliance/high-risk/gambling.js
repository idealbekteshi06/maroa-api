'use strict';

/**
 * Gambling — casino, sports betting, lottery, online gambling, fantasy.
 *
 * Regulators: Gambling Commission (UK), state gaming control boards (US),
 * MGA (Malta), AGCC (Alderney), ASA, federal Wire Act.
 *
 * Hard refusals:
 *   - Targeting minors
 *   - Targeting self-excluded/vulnerable players
 *   - "Guaranteed win" / "Risk-free bet" framing
 *   - Implying gambling solves financial problems
 *
 * Required disclosures:
 *   - Age (18+/21+ per jurisdiction)
 *   - Problem-gambling helpline (BeGambleAware UK, 1-800-GAMBLER US)
 *   - "Play responsibly"
 *   - License # for licensed operators
 *
 * Platform restrictions:
 *   - Meta: heavily restricted; requires written permission
 *   - Google: limited to licensed advertisers in specific countries
 *   - TikTok: heavily restricted; banned in many regions
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'gambling',
  name: 'Gambling',
  category: COMPLIANCE_CATEGORIES.HIGH_RISK,
  industries: [],
  regions: ['*'],
  regulators: ['UK Gambling Commission', 'State Gaming Boards', 'MGA', 'ASA', 'Wire Act'],
  source_citation: 'UK Gambling Act 2005, ASA CAP §16, US Wire Act 18 USC 1084',
  banned_claims: [
    {
      patterns: ['guaranteed win', 'risk-free bet', 'no risk gambling', 'always wins', 'sure thing'],
      issue: 'misrepresents odds — UKGC and ASA prohibit',
      regulator: 'UK Gambling Commission / ASA',
      statute: 'UKGC LCCP §17',
    },
    {
      patterns: ['solve your debt', 'pay off your house', 'escape your financial problems', 'get out of debt fast'],
      issue: 'implies gambling solves financial problems — UKGC prohibits',
      regulator: 'UK Gambling Commission',
      statute: 'UKGC LCCP §17.1',
    },
    {
      patterns: [
        /\bfor\s+(kids|teens|children|minors|the\s+whole\s+family)\b/i,
        /\b(gambling|betting|casino)\s+for\s+(teens|kids|minors)\b/i,
        'for kids',
        'great for teens',
        'youth-friendly',
      ],
      issue: 'targets minors — gambling-law violation in all jurisdictions',
      regulator: 'UK Gambling Commission / State Gaming',
    },
  ],
  required_disclosures: [
    {
      when: 'always',
      disclosure: '18+ (UK) / 21+ (US). Gamble responsibly. Help: 1-800-GAMBLER (US) / BeGambleAware.org (UK)',
      regulator: 'UK Gambling Commission / State Gaming',
    },
  ],
  platform_restrictions: {
    meta: 'restricted',
    google: 'restricted',
    tiktok: 'restricted',
    linkedin: 'restricted',
  },
  examples_blocked: [
    'Guaranteed win — risk-free bet.',
    'Pay off your house by Friday with our system.',
    'Gambling for teens — fun for the whole family.',
  ],
});
