'use strict';

/**
 * lib/compliance/ruleset.cafe.js
 * ----------------------------------------------------------------------------
 * Café-specific compliance rules. Sit on top of the generic ruleset
 * (engine merges automatically).
 *
 * Café marketing has its own pitfalls: caffeine health claims, organic /
 * fair-trade / single-origin claims that need certification, and Meta's
 * food-and-drink ad policies for unverified businesses.
 * ----------------------------------------------------------------------------
 */

module.exports = [
  // ─── Hard ───────────────────────────────────────────────────────────
  {
    id: 'cafe.organic_uncertified',
    severity: 'hard',
    pattern: /\b(?:certified\s+)?organic\b/i,
    message:
      'Calling products "organic" in marketing requires actual certification (USDA Organic, EU Organic, Soil Association). Uncertified use can trigger FTC + EU consumer-protection action.',
    suggestion:
      'If the supplier is certified, say "from an EU-organic-certified farm" + name the cert. If not, drop the word entirely and use "single-farm sourced" or "specialty grade" instead.',
  },
  {
    id: 'cafe.fair_trade_unverified',
    severity: 'hard',
    pattern: /\bfair[- ]trade\b/i,
    message:
      '"Fair trade" is a trademarked certification (Fairtrade International). Using it without the cert is trademark infringement + potential consumer-deception claim.',
    suggestion:
      'Use "direct trade" if you know the farm + price, or "supplier-direct" if you can verify the relationship — both are legally safer.',
  },
  {
    id: 'cafe.health_caffeine',
    severity: 'hard',
    pattern: [
      /\bcoffee\s+(?:cures?|prevents?|treats?)\b/i,
      /\bcaffeine\s+(?:cures?|prevents?|treats?)\b/i,
      /\bantioxidant.*(?:cancer|disease|aging)\b/i,
      /\bboost.*metabolism\b/i,
    ],
    message:
      'Health benefits of coffee or caffeine require FDA / EU EFSA substantiation. Generic "boost metabolism" / "antioxidant fights aging" claims are rejected by Meta automatically.',
    suggestion:
      'Describe taste, ritual, sourcing, or craft. Never a health benefit. "Best part of the morning" is fine; "fights inflammation" isn\'t.',
  },

  // ─── Soft ───────────────────────────────────────────────────────────
  {
    id: 'cafe.single_origin_loose',
    severity: 'soft',
    pattern: /\bsingle[- ]origin\b/i,
    message:
      '"Single origin" in specialty coffee is loosely used but technically means one farm/cooperative. If the bag is from multiple sources, use "single estate" only when accurate.',
    suggestion:
      'If you actually source from one farm, name the farm. If from a region (multiple farms in the same area), say "single region" — more accurate and more credible.',
  },
  {
    id: 'cafe.specialty_grade',
    severity: 'soft',
    pattern: /\bspecialty grade\b/i,
    message:
      '"Specialty grade" has a specific meaning (SCA score ≥80). Casual use undermines trust with specialty buyers and can trigger industry-press scrutiny.',
    suggestion:
      'Use only if you can quote the cupping score: "85 SCA-scored Ethiopia Yirgacheffe."',
  },
  {
    id: 'cafe.barista_certified',
    severity: 'soft',
    pattern: /\b(?:certified|world[- ]?class)\s+barista\b/i,
    message:
      'Barista certifications (SCA, BGA) are real — only claim them if your team holds them. Generic "world-class" reads as marketing fluff.',
    suggestion:
      'Name the cert ("Our head barista holds SCA Level 2") or replace with a concrete signal ("8 years pulling shots", "trained at Onyx Coffee Lab").',
  },

  // ─── Info ───────────────────────────────────────────────────────────
  {
    id: 'cafe.emoji_overuse',
    severity: 'info',
    pattern: /(?:☕|🥐|🍰){3,}/,
    message:
      'Café-emoji clusters (☕☕☕, 🥐🥐🥐) reduce Meta delivery by 5-10%. Single, well-placed emoji is fine.',
    suggestion: 'One emoji per post, max. Let the photo do the heavy lifting.',
  },
];
