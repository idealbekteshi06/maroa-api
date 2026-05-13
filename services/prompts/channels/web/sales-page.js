'use strict';

/**
 * Sales page — direct-response high-conversion page for a single offer.
 *
 * Sources: Halbert + Sugarman + Joanna Wiebe direct-response playbooks,
 * RussellBrunson DotCom Secrets 2024 update.
 *
 * What performs:
 *   - 1500-5000+ words for high-ticket
 *   - PAS-S structure (Problem, Agitation, Solution, Stack)
 *   - Stack: bullet every component of the offer with itemized value
 *   - Guarantee section (risk reversal)
 *   - One offer, one CTA, repeated 5-10x
 *
 * What underperforms / damages credibility:
 *   - Vague "this could change your life"
 *   - Stack with no value anchoring
 *   - Missing guarantee
 *   - Multiple offers on same page (anchor confusion)
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'sales-page',
  name: 'Sales Page',
  category: CHANNEL_CATEGORIES.WEB,
  surface_type: 'landing',
  source_citation: 'Halbert + Sugarman + Wiebe direct-response playbooks',
  channel_ids: ['sales-page'],
  format_rules: {
    length_window: { min: 1500, max: 5000, ideal: 2800 },
    sections: ['headline', 'problem', 'agitation', 'solution', 'stack', 'proof', 'guarantee', 'cta'],
    primary_cta_repeats: { min: 5, max: 10 },
    emoji_use: 'none',
  },
  hook_patterns: [
    { name: 'Pain-led headline', template: '"For [audience] who [specific pain]"', why: 'Pain-aware audience converts highest' },
    { name: 'Outcome + objection-flip', template: '"How to [outcome] in [time] — even if [common objection]"', why: 'Classic Halbert headline' },
    { name: 'Stack reveal', template: 'List every component with itemized retail value, total, then offer price', why: 'Anchors value' },
  ],
  anti_patterns: [
    { pattern: 'change your life', why: 'Vague promise — Critic flag' },
    { pattern: 'world-class', why: 'Vague superlative' },
    { pattern: 'unique opportunity', why: 'Salesman cliché' },
  ],
  retention_mechanics: [
    'PAS-S structure',
    'stack with itemized value anchoring',
    'guarantee section (risk reversal)',
    'one offer, one CTA repeated 5-10x',
    'social proof every ~500 words',
  ],
  invariants: [
    { id: 'guarantee', rule: 'Must include a guarantee or risk-reversal section', kind: 'must_have' },
    { id: 'single-offer', rule: 'One offer per sales page (no competing offers)', kind: 'must_have' },
    { id: 'no-vague-superlatives', rule: 'No vague "world-class" / "change your life"', kind: 'must_avoid' },
  ],
  manipulation_risk: 4,
});
