'use strict';

/**
 * Alcohol — beer, wine, spirits.
 *
 * Regulators: TTB (US), FAA Act, Beer Institute Code, ASA (UK CAP/BCAP),
 * EU Audiovisual Media Services Directive.
 *
 * Hard refusals (industry self-regulation + government):
 *   - Targeting minors (Beer Institute Code §3.A — content cannot have
 *     primary appeal to under-21 audience)
 *   - Health claims ("good for you", "low calorie" without substantiation)
 *   - Implying social/sexual success from drinking
 *   - Showing minors consuming or in proximity to alcohol
 *
 * Required disclosures:
 *   - Age gate on direct ads (21+ US, 18+ EU+UK)
 *   - "Drink responsibly" / "Please drink responsibly"
 *
 * Platform restrictions:
 *   - Meta: restricted; requires age + region targeting
 *   - Google: restricted in many countries
 *   - TikTok: alcohol ads banned in most regions
 *   - Specific countries (Saudi Arabia, India many states, etc.) ban
 *     entirely
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'alcohol',
  name: 'Alcohol',
  category: COMPLIANCE_CATEGORIES.REGULATED_SUBSTANCES,
  industries: ['bar_lounge', 'restaurant'],
  regions: ['*'],
  regulators: ['TTB', 'Beer Institute Code', 'ASA (UK)', 'EU AVMSD'],
  source_citation: 'Beer Institute Code (2024), TTB 27 CFR 7, ASA CAP §18, EU AVMSD Art. 9',
  banned_claims: [
    {
      patterns: ['perfect for teens', 'great for college parties', 'underage', 'for kids', 'for minors'],
      issue: 'targets minors — Beer Institute Code §3.A violation',
      regulator: 'Beer Institute Code',
      statute: '§3.A.1',
    },
    {
      patterns: ['good for your health', 'healthy drinking', 'low calorie miracle', 'cures stress'],
      issue: 'health claim — TTB prohibits',
      regulator: 'TTB',
      statute: '27 CFR 7.29',
    },
    {
      patterns: ['get drunk fast', 'guaranteed to make you', 'irresistible'],
      issue: 'implies excessive consumption — Beer Institute violation',
      regulator: 'Beer Institute Code',
      statute: '§3.A.5',
    },
    {
      patterns: ['better sex', 'social success', 'attract', 'irresistible to'],
      issue: 'implies social/sexual success from drinking',
      regulator: 'Beer Institute Code / ASA',
      statute: 'Beer Institute §3.A.4 / ASA CAP §18',
    },
  ],
  required_disclosures: [
    {
      when: 'always',
      disclosure: 'Please drink responsibly. 21+ (US) / 18+ (EU/UK)',
      regulator: 'Beer Institute / ASA',
    },
  ],
  platform_restrictions: {
    meta: 'restricted',
    google: 'restricted',
    tiktok: 'banned',
    linkedin: 'restricted',
  },
  examples_blocked: [
    'Great for college parties — get drunk fast.',
    'This whiskey is good for your health.',
    'Drink this and become irresistible to women.',
  ],
});
