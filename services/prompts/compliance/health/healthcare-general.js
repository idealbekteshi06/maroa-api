'use strict';

/**
 * Healthcare general (medical clinics, dental, urgent care, telemedicine).
 *
 * Regulators: FDA (drug/device claims), FTC (advertising substantiation),
 * HHS/OCR (HIPAA), state medical boards.
 *
 * Hard refusals:
 *   - "Cure" / "guaranteed cure" / "100% effective" for any condition
 *   - Specific outcome promises without "Individual results may vary"
 *   - Testimonials presenting specific clinical outcomes (most state
 *     medical boards prohibit)
 *   - Using protected health info in any ad copy
 *
 * Required disclosures:
 *   - "Individual results may vary" near outcome claims
 *   - Practitioner credentials for clinical claims
 *
 * Platform restrictions:
 *   - Meta: restricted (Health & Wellness category — requires special
 *     ad-account approval for prescription / "before/after" content)
 *   - Google: restricted in Healthcare and Medicines policy
 *   - TikTok: restricted health-claim ads
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'healthcare-general',
  name: 'Healthcare (general)',
  category: COMPLIANCE_CATEGORIES.HEALTH,
  industries: ['healthcare_general', 'medical_clinic', 'dental_practice'],
  regions: ['*'],
  regulators: ['FDA', 'FTC', 'HHS-OCR', 'State Medical Boards'],
  source_citation: 'FDA 21 USC 343 (false labeling), FTC Health Products Compliance Guide (2022), HIPAA 45 CFR 164',
  banned_claims: [
    {
      patterns: ['cure', 'cures', 'guaranteed cure', '100% effective', 'completely safe'],
      issue: 'absolute medical claim ("cure" / "100% effective")',
      regulator: 'FDA / FTC',
      statute: 'FTC Health Products Compliance Guide §III',
      suggestion: 'Use specific outcomes with substantiation, not absolutes.',
    },
    {
      patterns: ['miracle', 'breakthrough cure', 'revolutionary treatment'],
      issue: 'unsubstantiated hyperbole — FTC deceptive-advertising flag',
      regulator: 'FTC',
      statute: '15 USC 45',
    },
    {
      patterns: ['no risk', 'no side effects', 'risk-free treatment'],
      issue: 'false safety claim — all medical procedures carry risk',
      regulator: 'FDA / State Medical Board',
    },
    {
      patterns: ['lose 20 lbs', 'lose 30 lbs', 'lose 50 lbs'],
      issue: 'specific weight-loss outcome promise',
      regulator: 'FTC',
      statute: 'FTC Health Products Compliance Guide §IV',
    },
  ],
  required_disclosures: [
    {
      when: 'if_claim_present:result',
      disclosure: 'Individual results may vary',
      regulator: 'FTC',
      statute: 'FTC Endorsement Guides 16 CFR 255',
    },
  ],
  platform_restrictions: {
    meta: 'restricted',
    google: 'restricted',
    tiktok: 'restricted',
    linkedin: 'allowed',
  },
  examples_blocked: [
    'Our clinic guarantees a cure for chronic pain.',
    'Lose 30 lbs in 30 days with our weight-loss program.',
    'A revolutionary breakthrough treatment with no side effects.',
  ],
});
