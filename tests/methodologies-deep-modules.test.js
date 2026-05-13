'use strict';

/**
 * tests/methodologies-deep-modules.test.js
 *
 * Wave 60 Session 1 — deep tests for the 6 named "high-fidelity" modules:
 *   aida, pas, storybrand, schwartz-5-stages, sugarman-30-triggers,
 *   hormozi-value-equation.
 */

const test = require('node:test');
const assert = require('node:assert');

const aida = require('../services/prompts/methodologies/structural/aida');
const pas = require('../services/prompts/methodologies/structural/pas');
const sb = require('../services/prompts/methodologies/structural/storybrand');
const schwartz = require('../services/prompts/methodologies/psychology/schwartz-5-stages');
const sugarman = require('../services/prompts/methodologies/psychology/sugarman-30-triggers');
const hormozi = require('../services/prompts/methodologies/psychology/hormozi-value-equation');

// ─── AIDA ─────────────────────────────────────────────────────────────────

test('aida: full 4-stage copy scores 1.0', () => {
  const draft =
    'Why are SaaS founders still losing 4 hours a week to spreadsheets? Because Excel was designed for accountants. With Marlow, your team gets 47% more done because dashboards build themselves. Sign up for a 14-day free trial today.';
  const r = aida.applyToDraft(draft);
  assert.ok(r.score >= 0.75, `expected ≥0.75, got ${r.score}`);
});

test('aida: missing CTA blocks at "A2" invariant', () => {
  const draft =
    "Why are founders losing time? Excel is the wrong tool. You'll finally feel in control. Marlow handles it.";
  const r = aida.applyToDraft(draft);
  const blocked = r.fixes.find((f) => f.severity === 'block' && /AIDA-A:/.test(f.issue));
  assert.ok(blocked, 'should block on missing CTA');
});

test('aida: generateFromSpec produces 4-stage prompt', () => {
  const out = aida.generateFromSpec({ product: 'Marlow', audience: 'SaaS founders' });
  assert.match(out.structure, /Attention/);
  assert.strictEqual(out.prompt_segments.length, 4);
});

// ─── PAS ──────────────────────────────────────────────────────────────────

test('pas: well-formed P-A-S copy scores high', () => {
  const draft =
    "Tired of cold leads ghosting you? Every week you spend hours emailing prospects who never respond — meanwhile your pipeline shrinks. That's why we built Marlow: warm intros, not cold pitches.";
  const r = pas.applyToDraft(draft);
  assert.ok(r.score >= 0.66);
});

test('pas: catastrophizing without grounding is flagged', () => {
  // Has "disaster" + "nightmare" (catastrophizing) but no grounded
  // anchor like "every day", "customers tell us", etc.
  const draft = 'Tired of disaster after disaster? Nothing but nightmares ahead. The cure is here: Marlow.';
  const r = pas.applyToDraft(draft);
  const ethicsWarning = r.fixes.find((f) => /catastrophizing/i.test(f.issue));
  assert.ok(ethicsWarning, 'should flag catastrophizing without grounded customer experience');
});

test('pas: manipulation_risk is 4 (medium — agitate stage can tip)', () => {
  assert.strictEqual(pas.manipulation_risk, 4);
});

// ─── StoryBrand ──────────────────────────────────────────────────────────

test('storybrand: brand-as-hero language is blocked', () => {
  const draft =
    'We are the industry-leading platform. Our award-winning team will guide you. We are committed to excellence. Book a call.';
  const r = sb.applyToDraft(draft);
  const blocked = r.fixes.find((f) => f.severity === 'block' && /hero/i.test(f.issue));
  assert.ok(blocked, 'should block brand-as-hero framing');
});

test('storybrand: "you" must beat "we"', () => {
  const draft = 'We do this. We do that. We are great. We help.';
  const r = sb.applyToDraft(draft);
  const blocked = r.fixes.find((f) => /Character/.test(f.issue));
  assert.ok(blocked);
});

test('storybrand: customer-hero copy with clear plan + CTA scores high', () => {
  const draft =
    "You're juggling 12 tools. We get it — we helped 200+ founders simplify their stack. Here's how: step 1, audit. Step 2, consolidate. Step 3, automate. Imagine waking up to a clean dashboard. Book a free audit today.";
  const r = sb.applyToDraft(draft);
  assert.ok(r.score >= 0.6, `expected ≥0.6, got ${r.score}`);
});

// ─── Schwartz 5 Stages ───────────────────────────────────────────────────

test('schwartz: detectStage picks the dominant stage from signals', () => {
  const productAware = 'Try our free trial today — sign up in 60 seconds.';
  assert.strictEqual(schwartz.detectStage(productAware).dominant, 'product_aware');
});

test('schwartz: detects mixed stages and warns', () => {
  // Mix problem_aware + most_aware signals
  const mixed = 'Tired of frustration? Sick of struggle? Buy now! Order today! Last chance ends tonight!';
  const det = schwartz.detectStage(mixed);
  assert.strictEqual(det.mixed, true);
});

test('schwartz: applyToDraft blocks when dominant != target', () => {
  const draft = 'Buy now! Order today! Last chance!';
  const r = schwartz.applyToDraft(draft, { awareness_stage: 'unaware' });
  const blocked = r.fixes.find((f) => f.severity === 'block');
  assert.ok(blocked, 'should block when stage mismatch');
});

test('schwartz: generateFromSpec includes stage-appropriate guidance', () => {
  const unawareSpec = schwartz.generateFromSpec({ stage: 'unaware', product: 'X' });
  const fullText = unawareSpec.prompt_segments.join(' ');
  assert.match(fullText, /AVOID/i);
  assert.match(fullText, /product/i);
});

// ─── Sugarman 30 Triggers ────────────────────────────────────────────────

test('sugarman: detects 3-5 triggers as the sweet spot', () => {
  // 4 triggers: specifics + social proof + simplicity + urgency
  const draft = 'Used by 12,847 founders. Save 4 hours a week. Setup takes 60 seconds. Sign up before Friday.';
  const r = sugarman.applyToDraft(draft);
  assert.ok(r.score >= 0.6);
});

test('sugarman: flags stacked manipulation triggers (total risk > 18)', () => {
  // Stack fear + greed + scarcity + guilt + exclusivity = high risk
  const draft =
    "Don't miss out — fall behind your competitors! Save thousands! Last chance — only 3 spots! You owe yourself this!";
  const r = sugarman.applyToDraft(draft);
  const blocked = r.fixes.find((f) => /stacked|risk/i.test(f.issue));
  assert.ok(blocked, 'should flag manipulation stacking');
});

test('sugarman: TRIGGERS catalog has 30 entries', () => {
  assert.ok(sugarman.TRIGGERS.length >= 29, `expected ~30, got ${sugarman.TRIGGERS.length}`);
});

// ─── Hormozi Value Equation ──────────────────────────────────────────────

test('hormozi: full value equation copy scores high', () => {
  const draft =
    'Finally reach 100k followers (we helped 200+ creators do exactly this, guaranteed). Setup in 5 minutes. We handle every post for you.';
  const r = hormozi.applyToDraft(draft, { funnel_stage: 'bofu' });
  assert.ok(r.score >= 0.75);
});

test('hormozi: unsupported certainty claim is blocked', () => {
  const draft = 'Guaranteed results in 7 days. No exceptions. Always works.';
  const r = hormozi.applyToDraft(draft);
  const blocked = r.fixes.find((f) => f.severity === 'block' && /certainty/i.test(f.issue));
  assert.ok(blocked, 'should block unsupported certainty claims');
});

test('hormozi: supported certainty (with money-back) passes', () => {
  const draft = 'Guaranteed results in 7 days — 30-day money-back guarantee, no questions asked.';
  const r = hormozi.applyToDraft(draft);
  const blocked = r.fixes.find((f) => f.severity === 'block' && /certainty/i.test(f.issue));
  assert.strictEqual(blocked, undefined, 'should not block when certainty has backup terms');
});

test('hormozi: bofu missing time/effort reduction prompts suggestion', () => {
  const draft = 'Become the expert you want to be. Many customers report success.';
  const r = hormozi.applyToDraft(draft, { funnel_stage: 'bofu' });
  const suggestion = r.fixes.find((f) => /time-saving|effort-reduction/i.test(f.issue));
  assert.ok(suggestion);
});
