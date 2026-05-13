'use strict';

/**
 * Mental health services (therapy, counseling, psychiatry).
 *
 * Regulators: FDA, FTC, state licensing boards, plus crisis-response
 * guidelines from AFSP/WHO.
 *
 * Hard refusals:
 *   - "Cure depression" / "end anxiety forever" — absolute outcome
 *   - Targeting suicidal ideation with marketing copy
 *   - Showing acute crisis imagery as ad creative
 *   - Anything implying replacement for emergency services
 *
 * Required disclosures:
 *   - Crisis-line callout when content touches on self-harm / suicide
 *   - "Not a substitute for emergency care"
 *
 * Platform restrictions:
 *   - Meta: restricted (sensitive category) + crisis-content auto-flag
 *   - Google: restricted in Sensitive Events policy
 *   - TikTok: restricted; crisis imagery banned
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'mental-health',
  name: 'Mental Health Services',
  category: COMPLIANCE_CATEGORIES.HEALTH,
  industries: ['mental_health'],
  regions: ['*'],
  regulators: ['FDA', 'FTC', 'State Mental Health Boards', 'WHO Suicide Prevention Guidelines'],
  source_citation: 'WHO Preventing Suicide: A Resource for Media Professionals (2017), FTC Health Products Compliance Guide',
  banned_claims: [
    {
      patterns: [
        /\b(cure|cures|cured|curing|eliminate|eliminates|end|ends|beat|beats)\s+(\w+\s+){0,3}(depression|anxiety|ptsd|bipolar|ocd)/i,
        'cure depression',
        'end anxiety forever',
        'eliminate ptsd',
      ],
      issue: 'absolute mental-health outcome claim',
      regulator: 'FTC',
      statute: 'FTC Health Products Compliance Guide §III',
    },
    {
      patterns: ['suicidal', 'suicide', 'kill yourself', 'end your life'],
      issue: 'targeting/displaying suicide content in marketing copy violates platform policies + WHO guidelines',
      regulator: 'WHO / Platform Policies',
      severity: 'block',
    },
    {
      patterns: ['replace your therapist', 'instead of seeing a doctor', 'no need for medication'],
      issue: 'implies replacement for licensed clinical care',
      regulator: 'State Mental Health Boards',
    },
  ],
  required_disclosures: [
    {
      when: 'if_claim_present:depression',
      disclosure: 'If you or someone you know is in crisis, contact 988 (US) or your local emergency line',
      regulator: 'WHO Media Guidelines',
      statute: 'WHO 2017',
    },
    {
      when: 'if_claim_present:anxiety',
      disclosure: 'Not a substitute for emergency care',
      regulator: 'State Mental Health Boards',
    },
  ],
  platform_restrictions: {
    meta: 'restricted',
    google: 'restricted',
    tiktok: 'restricted',
    linkedin: 'allowed',
  },
  examples_blocked: [
    'Cure your depression forever with our app.',
    'Replace your therapist — we have the answer.',
    'No need for medication if you join our program.',
  ],
});
