'use strict';

/**
 * lib/compliance/ruleset.generic.js
 * ----------------------------------------------------------------------------
 * Generic marketing-compliance rules. Applied to every industry on top of
 * the industry-specific ruleset (when present). Keeps the engine sane for
 * unknown verticals.
 *
 * Each rule is plain data — the engine treats this as a table, not code.
 * Add an entry by appending a row. Severity:
 *   'hard'  → blocks publishing (must be rewritten or appealed)
 *   'soft'  → warns; published as-is on free/growth, rewrite offered on agency+
 *   'info'  → informational only; never blocks
 * ----------------------------------------------------------------------------
 */

module.exports = [
  // ─── Hard absolutes ────────────────────────────────────────────────
  {
    id: 'generic.guarantee',
    severity: 'hard',
    pattern: [/\bguarantee(?:s|d)?\b/i, /\b100%\s*(?:risk[- ]free|money[- ]back|guaranteed?)\b/i, /\bzero risk\b/i],
    message:
      'Unconditional guarantees can violate FTC, ASA, and ACMA disclosure rules. Most platforms (Meta, Google) reject ads with absolute guarantees.',
    suggestion:
      'Use conditional language: "If you don\'t love it, return it within 30 days for a refund" instead of "Guaranteed."',
  },
  {
    id: 'generic.income_claim',
    severity: 'hard',
    pattern: [
      // Numbers may include comma separators (5,000) or none (5000).
      /\b(?:make|earn)\s+\$?[\d,]{3,}\s*(?:per\s+(?:day|week|month|year)|\/\s*(?:day|week|month|year)|daily|weekly|monthly|annually)\b/i,
      /\b(?:guaranteed|guarantee|risk[- ]free)\s+income\b/i,
      /\bget\s+rich\s+quick\b/i,
    ],
    message:
      "Specific income claims trigger FTC Endorsement Guides + Meta's no-get-rich-quick policy. Most accounts are paused on first violation.",
    suggestion:
      'Talk outcomes generically: "see real customer stories" or "what our top-performing customers do" — never specific dollar amounts.',
  },
  {
    id: 'generic.health_cure',
    severity: 'hard',
    pattern: [
      /\b(?:cure|treats?|prevents?)\b.*(?:cancer|diabetes|covid|coronavirus|alzheimer)/i,
      /\bfda[- ]approved\b/i,
      /\bclinically proven\b/i,
      /\bmedical[- ]grade\b/i,
    ],
    message:
      'Medical / disease claims violate FDA + Meta health-product policies. FDA-approved language is reserved for actually-approved devices.',
    suggestion:
      'Use lifestyle/wellness framing instead: "supports overall wellness" or "designed for daily comfort" — and only if you can back it up.',
  },
  {
    id: 'generic.before_after_personal',
    severity: 'hard',
    pattern: [
      /\b(?:lost|gained)\s+\d+\s*(?:lbs?|pounds?|kg|kilograms?)\b/i,
      /\bbefore\s*(?:and|\&)\s*after\b.*(?:weight|skin|body)/i,
    ],
    message:
      "Before/after weight or body-transformation claims trigger Meta's personal-attribute policy. Ads are rejected automatically.",
    suggestion: 'Talk about the journey, the routine, or the framework — never a specific personal outcome.',
  },

  // ─── Soft warnings ─────────────────────────────────────────────────
  {
    id: 'generic.superlative_best',
    severity: 'soft',
    pattern: [/\bworld['']?s\s+best\b/i, /\bnumber\s*one\b/i, /\b#1\b/, /\bunbeatable\b/i],
    message:
      'Superlative claims ("world\'s best", "#1") need substantiation per FTC and platform policy. They\'re also a credibility risk.',
    suggestion:
      'Replace with specific proof: "rated 4.9 on Google", "5,000 cafés use us", "what 1,200 baristas chose this year".',
  },
  {
    id: 'generic.urgency_fake',
    severity: 'soft',
    pattern: [
      /\bact\s+now\b.*\b(?:only|hurry|today)\b/i,
      /\blast\s+chance\b/i,
      /\b(?:only|just)\s+\d+\s+(?:spots|seats)\s+(?:left|remaining)\b/i,
    ],
    message:
      "Manufactured urgency that's recurring or never-actually-ending damages trust and trips review-team escalations.",
    suggestion:
      "Only use scarcity when it's real: \"we made 80kg, when it's gone it's gone\" with a named, finite number.",
  },
  {
    id: 'generic.testimonial_typical',
    severity: 'soft',
    pattern: [/\btypical results\b/i, /\bresults will vary\b/i],
    message:
      "If you're adding the disclaimer, the underlying claim likely needs softening too. Disclaimers don't exempt the claim under FTC rules.",
    suggestion:
      'Restructure the post so no disclaimer is needed — make the claim specific to the person quoted, not implied as typical.',
  },

  // ─── Info — pattern hints, not violations ─────────────────────────
  {
    id: 'generic.exclamation_overuse',
    severity: 'info',
    pattern: /!{2,}/,
    message:
      'Multiple exclamation points trigger Meta\'s "low-quality ad" engagement penalty (lower delivery, higher CPC).',
    suggestion: 'Use at most one exclamation point per piece of copy.',
  },
  {
    id: 'generic.allcaps',
    severity: 'info',
    pattern: /\b[A-Z]{6,}\b/,
    message:
      'All-caps words longer than 5 characters reduce ad delivery on Meta + Google by 8–15% per their own published guidance.',
    suggestion: 'Use bold or italic instead. Reserve all-caps for one or two words at most.',
  },
];
