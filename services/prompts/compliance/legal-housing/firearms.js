'use strict';

/**
 * Firearms / ammunition / accessories.
 *
 * Regulators: ATF (US), state firearms laws, FCC, EU Firearms Directive.
 *
 * Hard refusals:
 *   - Online sales of firearms to consumers without FFL transfer
 *   - Targeting minors
 *   - Implying use for violence/intimidation
 *
 * Required disclosures:
 *   - FFL transfer required for firearm purchases
 *   - State law variations
 *   - "Must be 18+ for long guns / 21+ for handguns" (US federal)
 *
 * Platform restrictions:
 *   - Meta: BANNED (all firearm-related ads, even accessories with
 *     specific exceptions)
 *   - Google: BANNED
 *   - TikTok: BANNED
 *   - Only owned channels + permitted niche networks
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'firearms',
  name: 'Firearms',
  category: COMPLIANCE_CATEGORIES.LEGAL_HOUSING,
  industries: [],
  regions: ['*'],
  regulators: ['ATF', 'State Firearms Authorities', 'EU Firearms Directive'],
  source_citation: 'GCA 1968, NFA 1934, ATF rulings, Meta + Google ad policies',
  banned_claims: [
    {
      patterns: ['ship to your door', 'no ffl needed', 'no background check', 'skip the background check'],
      issue: 'implies illegal firearm transfer — federal felony',
      regulator: 'ATF',
      statute: 'GCA 1968 §922',
    },
    {
      patterns: [
        /\bfor\s+(kids|teens|children|minors|toddlers)\b/i,
        /\b\d{1,2}[-\s]?year[-\s]?old\b/i,
        /\b(first|starter)\s+(gun|firearm|rifle|pistol)\b/i,
        'for kids',
        'youth-friendly',
        'for teens',
      ],
      issue: 'targets minors',
      regulator: 'ATF / State',
    },
    {
      patterns: ['for self-defense killing', 'for assault', 'great for intimidation'],
      issue: 'implies violent/illegal use',
      regulator: 'ATF',
    },
  ],
  required_disclosures: [
    {
      when: 'always',
      disclosure: 'Federal firearm transfer must occur through an FFL. State and local laws apply',
      regulator: 'ATF',
      statute: 'GCA 1968',
    },
  ],
  platform_restrictions: {
    meta: 'banned',
    google: 'banned',
    tiktok: 'banned',
    linkedin: 'banned',
  },
  examples_blocked: [
    'Ships to your door — no FFL needed.',
    'Great first gun for your 10-year-old.',
    'No background check required.',
  ],
});
