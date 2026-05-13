'use strict';

/**
 * services/prompts/methodologies/_helpers.js
 * ---------------------------------------------------------------------------
 * Shared utilities for the 29 framework modules. Keeps the per-module code
 * focused on the framework's IDEAS, not on tokenization minutiae.
 */

function _normalize(text) {
  if (!text) return '';
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function _sentences(text) {
  if (!text) return [];
  return String(text)
    .split(/(?<=[.!?])\s+/g)
    .map((s) => s.trim())
    .filter(Boolean);
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

function _containsAny(text, patterns) {
  const lower = _normalize(text);
  for (const p of patterns) {
    if (typeof p === 'string' && lower.includes(p.toLowerCase())) return true;
    if (p instanceof RegExp && p.test(text)) return true;
  }
  return false;
}

/**
 * Score a draft on how many of the supplied "must_have" markers are present.
 * Returns 0..1.
 */
function _markerCoverageScore(text, markers) {
  if (!Array.isArray(markers) || markers.length === 0) return 0;
  let hits = 0;
  for (const m of markers) {
    if (_containsAny(text, [m])) hits++;
  }
  return hits / markers.length;
}

/**
 * Standardized "fix" object — every module's applyToDraft should emit
 * fixes in this shape so downstream consumers (critic, rewrite step)
 * can route them uniformly.
 */
function makeFix({ severity = 'suggest', issue, suggestion, span = null }) {
  return { severity, issue: String(issue || ''), suggestion: String(suggestion || ''), span };
}

/**
 * Standardized applicability builder — saves boilerplate in each module.
 * Pass `null` or omit for `*` (any).
 */
function applicability({
  awareness_stages = ['*'],
  funnel_stages = ['*'],
  channels = ['*'],
  industries = ['*'],
  regions = ['*'],
} = {}) {
  return {
    awareness_stages,
    funnel_stages,
    channels,
    industries,
    regions,
  };
}

module.exports = {
  _normalize,
  _sentences,
  _words,
  _wordCount,
  _containsAny,
  _markerCoverageScore,
  makeFix,
  applicability,
};
