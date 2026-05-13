'use strict';

/**
 * Prescription pharmaceuticals — DTC advertising (US/NZ only; banned in
 * most of the rest of the world).
 *
 * Regulators: FDA Office of Prescription Drug Promotion (OPDP), EMA
 * (banned in EU), TGA (Australia banned), MHRA (UK banned).
 *
 * Hard refusals:
 *   - Off-label uses (any indication beyond FDA-approved label)
 *   - Lack of fair balance (US DTC requires risks shown alongside
 *     benefits)
 *   - Reminder ads with drug name + indication but no risk info
 *
 * Required disclosures (US DTC):
 *   - Brief summary or major-statement risk info
 *   - "Talk to your doctor" / "Ask your doctor"
 *   - Most-important side effects + contraindications
 *
 * Platform restrictions:
 *   - Meta: restricted; some prescription drug ads banned
 *   - Google: prescription drug ads require certification
 *   - TikTok: banned
 *   - Outside US + NZ: prescription DTC banned entirely
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'prescription-pharma',
  name: 'Prescription Pharma (DTC)',
  category: COMPLIANCE_CATEGORIES.REGULATED_SUBSTANCES,
  industries: [],
  regions: ['US', 'NZ'],
  regulators: ['FDA OPDP', 'EMA', 'TGA', 'MHRA'],
  source_citation: 'FDA 21 CFR 202.1, FDAMA §114, EU Directive 2001/83/EC',
  banned_claims: [
    {
      patterns: ['cures', 'guaranteed cure', '100% effective'],
      issue: 'absolute efficacy claim — FDA fair-balance violation',
      regulator: 'FDA',
      statute: '21 CFR 202.1(e)(5)',
    },
    {
      patterns: ['off-label', 'not approved for', 'experimental use'],
      issue: 'off-label promotion — FDA prohibited',
      regulator: 'FDA',
      statute: 'FD&C Act §502(a)',
    },
    {
      patterns: ['no side effects', 'risk-free medication', 'completely safe'],
      issue: 'safety absolute — fair-balance violation',
      regulator: 'FDA',
    },
  ],
  required_disclosures: [
    {
      when: 'always',
      disclosure: 'Talk to your doctor. See full prescribing information for risks',
      regulator: 'FDA',
      statute: '21 CFR 202.1',
    },
  ],
  platform_restrictions: {
    meta: 'restricted',
    google: 'restricted',
    tiktok: 'banned',
    linkedin: 'restricted',
  },
  examples_blocked: [
    'This drug cures depression with no side effects.',
    'Off-label use: also works for [other condition].',
    '100% effective medication.',
  ],
});
