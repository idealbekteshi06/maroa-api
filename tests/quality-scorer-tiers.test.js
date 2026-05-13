'use strict';

/**
 * tests/quality-scorer-tiers.test.js
 *
 * Wave 59 Session 1 — verifies the tier-based scoring + hard quality floor:
 *   - ACCEPTABLE_THRESHOLD floor check
 *   - AWARD_TIER_SCORE override for award winners
 *   - LONG_RUNTIME_FLOOR override for runtime ≥ 60 days
 */

const test = require('node:test');
const assert = require('node:assert');

const qualityScorer = require('../services/public-pretrainer/quality-scorer');
const expertSources = require('../lib/taxonomy/expert_sources');

// ─── ACCEPTABLE_THRESHOLD + isAcceptable ──────────────────────────────────

test('quality-scorer S1: ACCEPTABLE_THRESHOLD is 0.55', () => {
  assert.strictEqual(qualityScorer.ACCEPTABLE_THRESHOLD, 0.55);
});

test('quality-scorer S1: isAcceptable() respects threshold', () => {
  assert.strictEqual(qualityScorer.isAcceptable(0.54), false);
  assert.strictEqual(qualityScorer.isAcceptable(0.55), true);
  assert.strictEqual(qualityScorer.isAcceptable(0.9), true);
  assert.strictEqual(qualityScorer.isAcceptable(0.3), false);
  assert.strictEqual(qualityScorer.isAcceptable(null), false);
  assert.strictEqual(qualityScorer.isAcceptable(undefined), false);
});

test('quality-scorer S1: generic mediocre row scores below threshold', () => {
  const { qualityScore } = qualityScorer.score({
    body: 'A generic ad without any specifics',
    page_name: 'Unknown Local Business',
  });
  assert.ok(qualityScore < qualityScorer.ACCEPTABLE_THRESHOLD, `expected < 0.55, got ${qualityScore}`);
  assert.strictEqual(qualityScorer.isAcceptable(qualityScore), false);
});

// ─── Award-winner boost ───────────────────────────────────────────────────

test('quality-scorer S1: award winner gets AWARD_TIER_SCORE (0.95)', () => {
  // Liquid Death is in AWARD_WINNERS
  const { qualityScore, signals } = qualityScorer.score({
    body: 'Murder your thirst',
    page_name: 'Liquid Death',
  });
  assert.ok(qualityScore >= qualityScorer.AWARD_TIER_SCORE, `expected ≥ 0.95, got ${qualityScore}`);
  assert.strictEqual(signals.award_winner, true);
});

test('quality-scorer S1: award winner override stacks above any heuristic', () => {
  // Even a weak-content award-winner ad should hit 0.95
  const { qualityScore } = qualityScorer.score({
    body: 'short text',
    page_name: 'Apple',
  });
  assert.ok(qualityScore >= qualityScorer.AWARD_TIER_SCORE);
});

test('quality-scorer S1: non-award brand does not get the award boost', () => {
  const { qualityScore, signals } = qualityScorer.score({
    body: 'A reasonable ad with some content here',
    page_name: 'Random Mediocre Cafe',
  });
  assert.ok(qualityScore < qualityScorer.AWARD_TIER_SCORE);
  assert.strictEqual(signals.award_winner, false);
});

// ─── Long-runtime boost ───────────────────────────────────────────────────

test('quality-scorer S1: ad with runtime ≥ 60 days hits LONG_RUNTIME_FLOOR (0.8)', () => {
  const { qualityScore, signals } = qualityScorer.score({
    body: 'A reasonable ad',
    runtime_days: 90,
  });
  assert.ok(qualityScore >= qualityScorer.LONG_RUNTIME_FLOOR, `expected ≥ 0.8, got ${qualityScore}`);
  assert.strictEqual(signals.long_runtime, true);
});

test('quality-scorer S1: ad with runtime < 60 days does not get the floor', () => {
  const { qualityScore, signals } = qualityScorer.score({
    body: 'A reasonable ad',
    runtime_days: 30,
  });
  assert.ok(qualityScore < qualityScorer.LONG_RUNTIME_FLOOR);
  assert.strictEqual(signals.long_runtime, false);
});

test('quality-scorer S1: award winner takes precedence over long runtime', () => {
  // If both apply, award_winner (0.95) wins over long_runtime (0.8)
  const { qualityScore } = qualityScorer.score({
    body: 'short',
    page_name: 'Notion',
    runtime_days: 120,
  });
  assert.ok(qualityScore >= qualityScorer.AWARD_TIER_SCORE);
});

// ─── AWARD_WINNERS catalog + isAwardWinner ────────────────────────────────

test('expert_sources S1: AWARD_WINNERS catalog has at least 20 entries', () => {
  assert.ok(expertSources.AWARD_WINNERS.length >= 20, `expected ≥20, got ${expertSources.AWARD_WINNERS.length}`);
});

test('expert_sources S1: every award winner has name + award + year', () => {
  for (const w of expertSources.AWARD_WINNERS) {
    assert.ok(w.name, 'missing name');
    assert.ok(w.award, `missing award for ${w.name}`);
    assert.ok(typeof w.year === 'number');
  }
});

test('expert_sources S1: isAwardWinner is case + whitespace insensitive', () => {
  assert.strictEqual(expertSources.isAwardWinner('Liquid Death'), true);
  assert.strictEqual(expertSources.isAwardWinner('liquid death'), true);
  assert.strictEqual(expertSources.isAwardWinner('  Liquid Death  '), true);
  assert.strictEqual(expertSources.isAwardWinner('LIQUID DEATH'), true);
});

test('expert_sources S1: isAwardWinner returns false for unknown brands + null', () => {
  assert.strictEqual(expertSources.isAwardWinner('Some Random Shop'), false);
  assert.strictEqual(expertSources.isAwardWinner(''), false);
  assert.strictEqual(expertSources.isAwardWinner(null), false);
  assert.strictEqual(expertSources.isAwardWinner(undefined), false);
});

test('expert_sources S1: award winners span Cannes + Effie + D&AD + One Show', () => {
  const awards = expertSources.AWARD_WINNERS.map((w) => w.award.toLowerCase()).join(' ');
  assert.ok(awards.includes('cannes'));
  assert.ok(awards.includes('effie'));
  assert.ok(awards.includes('d&ad') || awards.includes('pencil'));
  assert.ok(awards.includes('one show'));
});
