'use strict';

/**
 * BAB — Before, After, Bridge.
 *
 * Modern direct-response formula. Show the painful current state, paint
 * the resolved future state, then bridge: "Here's how to get there."
 *
 * Source: lineage in Halbert/Sugarman; the BAB acronym is modern
 * (popularized by Brian Dean, Neil Patel, 2010s digital marketing).
 *
 * Manipulation_risk = 3. The "After" stage can over-promise; we flag
 * unsupported transformations.
 */

const { _containsAny, makeFix, applicability } = require('../_helpers');

const BEFORE = ['used to', 'before', 'tired of', 'frustrated', 'every day', 'currently', 'right now'];
const AFTER = ['imagine', 'now', 'today', 'after', 'finally', 'wake up to', 'enjoy'];
const BRIDGE = ['with', 'using', 'thanks to', "here's how", 'introducing', 'meet', 'enter'];

function applyToDraft(draft) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const hasBefore = _containsAny(draft, BEFORE);
  const hasAfter = _containsAny(draft, AFTER);
  const hasBridge = _containsAny(draft, BRIDGE);
  const fixes = [];
  if (!hasBefore)
    fixes.push(
      makeFix({ severity: 'suggest', issue: 'BAB-B: no "before" state', suggestion: 'Open with the current pain.' })
    );
  if (!hasAfter)
    fixes.push(
      makeFix({ severity: 'suggest', issue: 'BAB-A: no "after" state', suggestion: 'Paint the resolved future.' })
    );
  if (!hasBridge)
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'BAB-B2: no bridge connecting them',
        suggestion: 'Connect with "Here\'s how" or "With X".',
      })
    );
  const present = [hasBefore, hasAfter, hasBridge].filter(Boolean).length;
  return { score: present / 3, fixes, reasoning: `BAB stages: ${present}/3` };
}

function generateFromSpec({ pain, outcome, product }) {
  return {
    structure: 'Before → After → Bridge',
    prompt_segments: [
      `BEFORE: name the current state. ${pain || "The customer's pain"}.`,
      `AFTER: paint the resolved state. ${outcome || 'Where they end up'}.`,
      `BRIDGE: connect with ${product || 'the solution'}. Make the path feel inevitable.`,
    ],
  };
}

module.exports = {
  id: 'bab',
  name: 'BAB — Before, After, Bridge',
  category: 'structural',
  source_citation: 'Modern DR (Halbert/Sugarman lineage)',
  applicability: applicability({
    funnel_stages: ['tofu', 'mofu'],
    channels: ['meta-ads-video', 'instagram-reels', 'tiktok'],
  }),
  invariants: [{ id: 'before', rule: 'Must show current state', kind: 'must_have' }],
  manipulation_risk: 3,
  applyToDraft,
  generateFromSpec,
};
