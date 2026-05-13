'use strict';

/**
 * Real estate — Fair Housing Act compliance.
 *
 * Regulators: HUD (Fair Housing Act), state fair-housing agencies,
 * NAR Code of Ethics, EU equality law, UK Equality Act 2010.
 *
 * Hard refusals — protected-class language in advertising (US Fair
 * Housing Act §3604):
 *   - Race, color, national origin
 *   - Religion
 *   - Sex / gender
 *   - Familial status
 *   - Disability
 *   - Marital status, age, source of income (some states + locales)
 *
 * Specific prohibited phrases (HUD case law):
 *   - "Perfect for young couples", "great for families", "ideal for
 *     singles" — familial-status discrimination
 *   - "Walking distance to church/synagogue/mosque" — religious
 *     discrimination (per HUD guidance)
 *   - "No section 8" — source-of-income discrimination (illegal in many
 *     states + DC + many cities)
 *
 * Required disclosures:
 *   - "Equal Housing Opportunity" or HUD logo
 *
 * Platform restrictions:
 *   - Meta: Special Ad Category (Housing) — restricted targeting
 *   - Google: similar restrictions
 */

const { buildComplianceModule, COMPLIANCE_CATEGORIES } = require('../_helpers');

module.exports = buildComplianceModule({
  id: 'real-estate-fair-housing',
  name: 'Real Estate / Fair Housing',
  category: COMPLIANCE_CATEGORIES.LEGAL_HOUSING,
  industries: ['real_estate_agent'],
  regions: ['*'],
  regulators: ['HUD', 'NAR', 'State Fair Housing', 'EU Equality', 'UK Equality Act'],
  source_citation: 'Fair Housing Act 42 USC 3604, HUD Advertising Guidelines, NAR Code of Ethics Art. 10',
  banned_claims: [
    {
      patterns: [
        /\b(perfect|great|ideal|wonderful)\s+(\w+\s+){0,3}(for\s+)?(young couples?|families|singles|retirees|seniors|christians|professionals)/i,
        'perfect for young couples',
        'for young couples',
        'great for families',
        'ideal for singles',
        'no kids',
        'adults only',
        'great for retirees',
      ],
      issue: 'familial-status discrimination — Fair Housing Act violation',
      regulator: 'HUD',
      statute: 'Fair Housing Act §3604(c)',
    },
    {
      patterns: ['walking distance to church', 'near the synagogue', 'close to mosque', 'christian neighborhood'],
      issue: 'religion-targeting language — HUD guidance prohibits',
      regulator: 'HUD',
      statute: 'HUD Advertising Guidelines',
    },
    {
      patterns: ['no section 8', 'no government assistance', 'no housing voucher'],
      issue: 'source-of-income discrimination — illegal in many jurisdictions',
      regulator: 'State Fair Housing',
    },
    {
      patterns: ['must be employed', 'professionals only', 'no students'],
      issue: 'protected-class proxy — potential Fair Housing violation',
      regulator: 'HUD',
    },
  ],
  required_disclosures: [
    {
      when: 'always',
      disclosure: 'Equal Housing Opportunity',
      regulator: 'HUD',
      statute: 'Fair Housing Act §3604',
    },
  ],
  platform_restrictions: {
    meta: 'restricted',
    google: 'restricted',
    tiktok: 'allowed',
    linkedin: 'allowed',
  },
  examples_blocked: [
    'Perfect for young couples — walking distance to the church.',
    'No section 8 vouchers. Professionals only.',
    'Christian neighborhood, no kids welcome.',
  ],
});
