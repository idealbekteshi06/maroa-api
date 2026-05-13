'use strict';

/**
 * Dating apps / matchmaking services.
 *
 * Regulators: FTC (matchmaking guarantee laws), state dating-service
 * statutes (NY, FL, etc.), Meta + Google sensitive-content policies.
 *
 * Hard refusals:
 *   - "Guaranteed match" / "Guaranteed marriage"
 *   - Sexual / explicit content in ads
 *   - Targeting minors
 *   - Cross-targeting protected classes
 *
 * Required disclosures (in some states like NY):
 *   - 3-day cancellation right for matchmaking contracts
 *   - Refund policy
 *
 * Platform restrictions:
 *   - Meta: dating ads must be approved as Dating advertiser
 *   - Google: restricted; certain countries banned
 *   - TikTok: dating ads restricted
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'dating',
  name: 'Dating / Matchmaking',
  category: COMPLIANCE_CATEGORIES.HIGH_RISK,
  industries: [],
  regions: ['*'],
  regulators: ['FTC', 'State Dating Service Statutes', 'Meta + Google Ad Policies'],
  source_citation: 'FTC Dating Services Compliance Guide, NY Dating Service Consumer Bill of Rights',
  banned_claims: [
    {
      patterns: ['guaranteed match', 'guaranteed soulmate', 'guaranteed marriage', '100% match rate'],
      issue: 'guaranteed-match claim — FTC + state dating-statute violation',
      regulator: 'FTC',
      statute: 'FTC Dating Services Compliance Guide',
    },
    {
      patterns: ['sexy singles', 'hot singles in your area', 'available right now', 'meet for sex'],
      issue: 'sexual/explicit framing — platform-policy violation',
      regulator: 'Meta / Google',
    },
    {
      patterns: [
        /\bfor\s+(minors|teens|high\s+school|students|children)\b/i,
        /\bhigh[- ]school\s+(singles|students|kids)\b/i,
        'for minors',
        'for teens',
        'high school singles',
      ],
      issue: 'targets minors — illegal on all major platforms',
      regulator: 'Meta / Google',
    },
  ],
  required_disclosures: [
    {
      when: 'if_claim_present:contract',
      disclosure: '3-day cancellation right (in applicable states). See refund policy',
      regulator: 'State Dating Service Statutes',
    },
  ],
  platform_restrictions: {
    meta: 'restricted',
    google: 'restricted',
    tiktok: 'restricted',
    linkedin: 'allowed',
  },
  examples_blocked: [
    'Guaranteed soulmate — 100% match rate.',
    'Hot singles in your area, available right now.',
    'Dating app for high school students.',
  ],
});
