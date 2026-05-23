'use strict';

/**
 * services/prompts/channels/_helpers.js
 * ---------------------------------------------------------------------------
 * Shared utilities for channel-native format modules.
 *
 * Each channel module describes:
 *   - the SURFACE (where the post lives — feed, story, search results, inbox)
 *   - the FORMAT (length, hook window, aspect ratio, max chars)
 *   - HOOK PATTERNS that perform on this surface
 *   - ANTI-PATTERNS that get downranked / ignored on this surface
 *
 * The contract is enforced by tests/channels-registry.test.js.
 */

function _normalize(text) {
  if (!text) return '';
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function _words(text) {
  if (!text) return [];
  return String(text)
    .replace(/[^A-Za-z0-9' ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function _wordCount(text) {
  return _words(text).length;
}

function _charCount(text) {
  if (!text) return 0;
  return String(text).length;
}

function _firstLine(text) {
  if (!text) return '';
  const lines = String(text)
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[0] || '';
}

function _countHashtags(text) {
  if (!text) return 0;
  return (String(text).match(/#[A-Za-z0-9_]+/g) || []).length;
}

function _countEmoji(text) {
  if (!text) return 0;
  // Rough emoji range matcher — good enough for "is there lots of emoji" checks.
  return (String(text).match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/gu) || []).length;
}

function _containsAny(text, patterns) {
  const lower = _normalize(text);
  for (const p of patterns) {
    if (typeof p === 'string' && lower.includes(p.toLowerCase())) return true;
    if (p instanceof RegExp && p.test(text)) return true;
  }
  return false;
}

function makeFix({ severity = 'suggest', issue, suggestion, span = null }) {
  return { severity, issue: String(issue || ''), suggestion: String(suggestion || ''), span };
}

function applicability({
  awareness_stages = ['*'],
  funnel_stages = ['*'],
  channels = ['*'],
  industries = ['*'],
  regions = ['*'],
} = {}) {
  return { awareness_stages, funnel_stages, channels, industries, regions };
}

/**
 * Score draft length against a min/max/ideal window. Returns 0..1.
 *   exact ideal → 1.0
 *   within [min, max] → 0.7..1.0 linearly
 *   outside [min, max] → 0.3..0.5 linearly to 0.0 at 3× max
 */
function _scoreLength(actual, { min, max, ideal }) {
  if (actual == null) return 0.5;
  if (ideal != null && actual === ideal) return 1.0;
  if (min != null && max != null && actual >= min && actual <= max) {
    if (ideal != null) {
      const distance = Math.abs(actual - ideal);
      const halfRange = Math.max(ideal - min, max - ideal);
      return 1.0 - 0.3 * (distance / Math.max(halfRange, 1));
    }
    return 0.9;
  }
  if (max != null && actual > max) {
    const over = (actual - max) / Math.max(max, 1);
    return Math.max(0, 0.5 - 0.5 * Math.min(over, 1));
  }
  if (min != null && actual < min) {
    const under = (min - actual) / Math.max(min, 1);
    return Math.max(0, 0.5 - 0.5 * Math.min(under, 1));
  }
  return 0.5;
}

/**
 * Build a standard channel module from a declarative spec. Cuts boilerplate
 * for the 30+ modules — each module supplies only what's special, not the
 * scaffolding.
 *
 * @param {object} spec
 * @param {string} spec.id
 * @param {string} spec.name
 * @param {string} spec.category    one of CHANNEL_CATEGORIES
 * @param {string} spec.surface_type 'short_video' | 'feed_post' | 'story' | 'long_form' | 'ad_image' | 'ad_video' | 'search_result' | 'email' | 'sms' | 'long_video' | 'landing' | 'listing' | 'message' | 'notification'
 * @param {string} spec.source_citation
 * @param {object} spec.format_rules
 * @param {array}  spec.hook_patterns
 * @param {array}  spec.anti_patterns
 * @param {array}  [spec.retention_mechanics]
 * @param {array}  [spec.invariants]
 * @param {number} [spec.manipulation_risk=1]
 * @param {array}  spec.channel_ids
 * @param {function} [spec.applyExtras]  optional extra checks (draft, ctx) → fixes[]
 * @param {function} [spec.generateExtras] optional extra prompt segments (ctx) → string[]
 */
function buildChannelModule(spec) {
  const {
    id,
    name,
    category,
    surface_type,
    source_citation,
    format_rules = {},
    hook_patterns = [],
    anti_patterns = [],
    retention_mechanics = [],
    invariants = [],
    manipulation_risk = 1,
    channel_ids,
    applyExtras,
    generateExtras,
  } = spec;

  function applyToDraft(draft, context = {}) {
    if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };

    // Bail out cleanly if applied to a draft for a different channel.
    if (context.channel && Array.isArray(channel_ids) && !channel_ids.includes(context.channel)) {
      return { score: 0.7, fixes: [], reasoning: `not ${id} channel` };
    }

    const fixes = [];
    const wc = _wordCount(draft);
    const cc = _charCount(draft);
    let lengthScore = 0.8;

    if (format_rules.max_words && wc > format_rules.max_words) {
      fixes.push(
        makeFix({
          severity: 'block',
          issue: `${name}: ${wc} words exceeds max ${format_rules.max_words}`,
          suggestion: `Cut to ≤${format_rules.max_words} words.`,
        })
      );
      lengthScore = 0.3;
    }
    if (format_rules.min_words && wc < format_rules.min_words) {
      fixes.push(
        makeFix({
          severity: 'suggest',
          issue: `${name}: ${wc} words below min ${format_rules.min_words}`,
          suggestion: `Expand to ≥${format_rules.min_words} words.`,
        })
      );
      lengthScore = 0.5;
    }
    if (format_rules.max_chars && cc > format_rules.max_chars) {
      fixes.push(
        makeFix({
          severity: 'block',
          issue: `${name}: ${cc} chars exceeds max ${format_rules.max_chars}`,
          suggestion: `Cut to ≤${format_rules.max_chars} chars.`,
        })
      );
      lengthScore = 0.3;
    }

    if (format_rules.length_window) {
      lengthScore = _scoreLength(wc, format_rules.length_window);
    }

    // Anti-pattern phrase scan
    if (anti_patterns.length) {
      const phrases = anti_patterns
        .map((p) => (typeof p === 'string' ? p : p.pattern))
        .filter((p) => typeof p === 'string');
      const violations = phrases.filter((p) => _normalize(draft).includes(p.toLowerCase()));
      if (violations.length) {
        fixes.push(
          makeFix({
            severity: 'suggest',
            issue: `${name}: contains anti-pattern phrases (${violations.join(', ')})`,
            suggestion: 'Rephrase — these phrases get downranked or hidden on this surface.',
          })
        );
      }
    }

    if (typeof applyExtras === 'function') {
      try {
        const extra = applyExtras(draft, context) || [];
        for (const f of extra) fixes.push(f);
      } catch (e) {
        // soft-fail — extras shouldn't crash applyToDraft
      }
    }

    const score = fixes.some((f) => f.severity === 'block') ? 0.3 : Math.max(0.4, lengthScore - fixes.length * 0.05);
    return { score, fixes, reasoning: `wc=${wc} cc=${cc} fixes=${fixes.length}` };
  }

  function generateFromSpec(context = {}) {
    const segments = [];
    segments.push(`SURFACE: ${surface_type} (${name}).`);
    if (format_rules.max_words) segments.push(`MAX WORDS: ${format_rules.max_words}.`);
    if (format_rules.min_words) segments.push(`MIN WORDS: ${format_rules.min_words}.`);
    if (format_rules.max_chars) segments.push(`MAX CHARS: ${format_rules.max_chars}.`);
    if (format_rules.hook_window_sec) {
      segments.push(`HOOK WINDOW: first ${format_rules.hook_window_sec} seconds must earn the next 10.`);
    }
    if (format_rules.aspect_ratio) segments.push(`ASPECT RATIO: ${format_rules.aspect_ratio}.`);
    if (format_rules.captions === 'required') segments.push('CAPTIONS: required (80% watch muted).');
    if (format_rules.hashtag_count) {
      segments.push(`HASHTAGS: ${format_rules.hashtag_count.min}-${format_rules.hashtag_count.max}.`);
    }
    if (format_rules.emoji_use) segments.push(`EMOJI USE: ${format_rules.emoji_use}.`);
    if (hook_patterns.length) {
      segments.push(`HOOK PATTERNS (pick one): ${hook_patterns.map((h) => h.name).join(' | ')}.`);
    }
    if (retention_mechanics.length) {
      segments.push(`RETENTION: ${retention_mechanics.join('; ')}.`);
    }
    if (anti_patterns.length) {
      const list = anti_patterns
        .map((p) => (typeof p === 'string' ? p : p.pattern))
        .slice(0, 5)
        .join(', ');
      segments.push(`AVOID: ${list}.`);
    }
    if (typeof generateExtras === 'function') {
      try {
        const extra = generateExtras(context) || [];
        for (const seg of extra) if (seg) segments.push(seg);
      } catch (e) {
        // soft-fail
      }
    }
    return {
      structure: `${name} (${category}/${surface_type})`,
      prompt_segments: segments,
    };
  }

  return {
    id,
    name,
    category,
    surface_type,
    source_citation,
    format_rules,
    hook_patterns,
    anti_patterns,
    retention_mechanics,
    applicability: applicability({ channels: channel_ids }),
    invariants,
    manipulation_risk,
    applyToDraft,
    generateFromSpec,
  };
}

const CHANNEL_CATEGORIES = Object.freeze({
  SOCIAL: 'social',
  PAID_ADS: 'paid-ads',
  OWNED: 'owned',
  WEB: 'web',
  COMMERCE: 'commerce',
});

module.exports = {
  _normalize,
  _words,
  _wordCount,
  _charCount,
  _firstLine,
  _countHashtags,
  _countEmoji,
  _containsAny,
  _scoreLength,
  makeFix,
  applicability,
  buildChannelModule,
  CHANNEL_CATEGORIES,
};
