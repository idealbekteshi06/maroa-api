'use strict';

/**
 * Webinar script — 45-60 min live or evergreen, lead-gen + close.
 *
 * Sources: Jason Fladlien + Russell Brunson webinar playbooks 2024-2025,
 * Demio + WebinarJam attendance benchmarks 2025.
 *
 * Structure:
 *   - Intro + bonding (5 min)
 *   - Content (3 secrets/teaches, 30-40 min)
 *   - Pitch + transition (10-15 min)
 *   - Q&A (5-10 min)
 *
 * What performs:
 *   - Three "big shifts" / secrets, not 20 bullets
 *   - One offer at the end, with stack + bonus + guarantee
 *   - Live chat engagement throughout
 *   - Live or "just live" framing (evergreen with rolling timers)
 *
 * What underperforms / damages trust:
 *   - Pure content webinar with surprise pitch (low conversion)
 *   - Multi-offer pitch
 *   - Fake live (with real-time stamps that don't match)
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'webinar',
  name: 'Webinar Script',
  category: CHANNEL_CATEGORIES.WEB,
  surface_type: 'long_form',
  source_citation: 'Fladlien + Brunson Webinar Playbooks (2025)',
  channel_ids: ['webinar'],
  format_rules: {
    duration_min: { min: 45, max: 90, ideal: 60 },
    length_window: { min: 4000, max: 10000, ideal: 6500 },
    sections: ['intro', 'bonding', 'content', 'transition', 'pitch', 'qa'],
    secrets_taught: { min: 3, max: 3 },
  },
  hook_patterns: [
    {
      name: 'Big promise intro',
      template: 'State the 3 secrets up front; promise the framework',
      why: 'Sets stay-rate expectations',
    },
    {
      name: 'Bonding story',
      template: 'Specific 90-sec personal story → why you teach this',
      why: 'Cialdini liking + authority',
    },
    {
      name: 'Three secrets',
      template: 'Each secret = belief shift + small teach + transition',
      why: 'Fladlien "perfect webinar" structure',
    },
    {
      name: 'Stack close',
      template: 'Offer + stack + bonus + guarantee in 10-15 min',
      why: 'Value-anchor → offer-anchor',
    },
  ],
  anti_patterns: [
    { pattern: 'fake live', why: 'Inconsistent timestamps damage trust' },
    { pattern: 'super excited', why: 'Filler — cut it' },
    { pattern: 'as you can see', why: 'Filler' },
  ],
  retention_mechanics: [
    'state the 3 secrets up front (stay-rate)',
    'live chat callouts every 5 min',
    'one offer at the end with stack',
    'guarantee section',
  ],
  invariants: [
    { id: 'three-secrets', rule: '3 big shifts / secrets, not 20 bullets', kind: 'must_have' },
    { id: 'one-offer', rule: 'Single offer at the close (no competing offers)', kind: 'must_have' },
  ],
  manipulation_risk: 4,
});
