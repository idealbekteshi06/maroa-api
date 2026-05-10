'use strict';

const test = require('node:test');
const assert = require('node:assert');

const visualDna = require('../services/prompts/brand-voice/visual-dna');
const brandVoice = require('../services/prompts/brand-voice');

// ─── Determinism ─────────────────────────────────────────────────────────

test('visual-dna: same business → identical DNA on repeat calls', () => {
  const business = {
    id: 'biz-stable-1',
    business_name: 'Acme Dental Clinic',
    industry: 'dental clinic',
    location: 'Austin, TX',
  };
  const a = visualDna.buildVisualDna({ business });
  const b = visualDna.buildVisualDna({ business });
  assert.deepStrictEqual(a, b, 'Same business must always get same DNA (consistency rule)');
});

test('visual-dna: same business across multiple anchor builds → same DNA', () => {
  const business = {
    id: 'biz-stable-2',
    business_name: 'Pearly Whites',
    industry: 'dental clinic',
  };
  const anchor1 = brandVoice.buildAnchor({ business });
  const anchor2 = brandVoice.buildAnchor({ business });
  assert.deepStrictEqual(
    anchor1.visual_brand_dna.subject_archetype,
    anchor2.visual_brand_dna.subject_archetype
  );
  assert.deepStrictEqual(
    anchor1.visual_brand_dna.palette,
    anchor2.visual_brand_dna.palette
  );
});

// ─── Uniqueness — THE CORE GUARANTEE ─────────────────────────────────────

test('visual-dna: 10 different dental clinics → at least 5 distinct DNAs', () => {
  const dnas = [];
  for (let i = 0; i < 10; i += 1) {
    const dna = visualDna.buildVisualDna({
      business: {
        id: `biz-dental-${i}-uniq`,
        business_name: `Dental Practice ${i}`,
        industry: 'dental clinic',
      },
    });
    dnas.push(JSON.stringify({ p: dna.palette, s: dna.subject_archetype, m: dna.mood, l: dna.lighting }));
  }
  const distinct = new Set(dnas);
  assert.ok(distinct.size >= 5,
    `Expected at least 5 distinct DNAs across 10 same-industry businesses, got ${distinct.size}. This means clients in the same industry would get same-looking content.`);
});

test('visual-dna: 100 random businesses → mostly unique combos (prevents same-look)', () => {
  const seen = new Set();
  for (let i = 0; i < 100; i += 1) {
    const dna = visualDna.buildVisualDna({
      business: {
        id: `biz-${i}-${Math.random().toString(36).slice(2)}`,
        business_name: `Test Business ${i}`,
        industry: i % 3 === 0 ? 'cafe' : i % 3 === 1 ? 'plumber' : 'saas b2b',
      },
    });
    seen.add(JSON.stringify({
      p: dna.palette, s: dna.subject_archetype, m: dna.mood, l: dna.lighting, c: dna.composition,
    }));
  }
  // We have 3 industries × 3×3×3×3×3 = 729 possible per industry → with 100 random hashes
  // we'd expect close to 100 unique results. >40 distinct is a hard floor that proves we
  // are not collapsing to a generic look.
  assert.ok(seen.size >= 40,
    `Expected ≥40 unique DNAs across 100 businesses, got ${seen.size}. Diversity too low.`);
});

test('visual-dna: dental clinic and cafe in the same template DO NOT overlap', () => {
  const dental = visualDna.buildVisualDna({
    business: { id: 'biz-d-1', business_name: 'X', industry: 'dental clinic' },
  });
  const cafe = visualDna.buildVisualDna({
    business: { id: 'biz-d-1', business_name: 'X', industry: 'cafe' }, // same id, different industry
  });
  // Different industry templates → different palettes/subjects even with same id
  assert.notDeepStrictEqual(dental.palette, cafe.palette);
  assert.notStrictEqual(dental.subject_archetype, cafe.subject_archetype);
});

// ─── Industry-appropriate output ─────────────────────────────────────────

test('visual-dna: dental clinic always picks medical/clean palette terms', () => {
  for (let i = 0; i < 5; i += 1) {
    const dna = visualDna.buildVisualDna({
      business: { id: `biz-dent-${i}`, business_name: 'X', industry: 'dental clinic' },
    });
    const palStr = dna.palette.join(' ').toLowerCase();
    const isClinical = /(white|mint|navy|ivory|beige|sage|silver|blue)/.test(palStr);
    assert.ok(isClinical, `Dental palette should be clinical, got ${dna.palette}`);
  }
});

test('visual-dna: restaurant always picks warm/food-narrative palette', () => {
  for (let i = 0; i < 5; i += 1) {
    const dna = visualDna.buildVisualDna({
      business: { id: `biz-rest-${i}`, business_name: 'X', industry: 'restaurant' },
    });
    const palStr = dna.palette.join(' ').toLowerCase();
    const isWarm = /(burgundy|cream|brass|terracotta|olive|copper|black|linen|herb)/.test(palStr);
    assert.ok(isWarm, `Restaurant palette should be warm/food-narrative, got ${dna.palette}`);
  }
});

test('visual-dna: unknown industry falls back to generic without crashing', () => {
  const dna = visualDna.buildVisualDna({
    business: { id: 'biz-x', business_name: 'X', industry: 'underwater basket weaving' },
  });
  assert.strictEqual(dna.industry_template, 'generic');
  assert.ok(Array.isArray(dna.palette));
  assert.ok(dna.subject_archetype.length > 0);
});

// ─── Tone tilt + VOC vibe ────────────────────────────────────────────────

test('visual-dna: warm tone keywords add tone_tilt=warm', () => {
  const dna = visualDna.buildVisualDna({
    business: {
      id: 'biz-warm', business_name: 'X', industry: 'cafe',
      tone_keywords: ['warm', 'family', 'inviting'],
    },
  });
  assert.strictEqual(dna.tone_tilt, 'warm');
});

test('visual-dna: cool/modern tone keywords add tone_tilt=cool', () => {
  const dna = visualDna.buildVisualDna({
    business: {
      id: 'biz-cool', business_name: 'X', industry: 'saas b2b',
      tone_keywords: ['modern', 'clean', 'premium'],
    },
  });
  assert.strictEqual(dna.tone_tilt, 'cool');
});

test('visual-dna: VOC themes flow into voc_vibe', () => {
  const dna = visualDna.buildVisualDna({
    business: { id: 'biz-fam', business_name: 'X', industry: 'cafe' },
    vocAnalysis: { themes: [{ name: 'family-friendly atmosphere', count: 12 }] },
  });
  assert.strictEqual(dna.voc_vibe, 'family-warm');
});

// ─── Format helpers ──────────────────────────────────────────────────────

test('visual-dna: formatForHiggsfield produces a usable prompt suffix', () => {
  const dna = visualDna.buildVisualDna({
    business: { id: 'b', business_name: 'X', industry: 'cafe' },
  });
  const suffix = visualDna.formatForHiggsfield(dna);
  assert.ok(suffix.length > 30);
  assert.ok(suffix.includes('palette:'));
  assert.ok(suffix.includes('·')); // separator
});

test('visual-dna: formatForLlm produces multi-line block with all fields', () => {
  const dna = visualDna.buildVisualDna({
    business: { id: 'b', business_name: 'X', industry: 'restaurant' },
  });
  const block = visualDna.formatForLlm(dna);
  assert.ok(block.includes('Visual brand DNA'));
  assert.ok(block.includes('Subject:'));
  assert.ok(block.includes('Palette:'));
  assert.ok(block.includes('IMPORTANT:'));
});

// ─── Brand-voice integration ─────────────────────────────────────────────

test('brand-voice.buildAnchor: includes visual_brand_dna in result', () => {
  const anchor = brandVoice.buildAnchor({
    business: { id: 'biz-int', business_name: 'X', industry: 'plumber' },
  });
  assert.ok(anchor.visual_brand_dna);
  assert.ok(anchor.visual_brand_dna.palette);
  assert.ok(anchor.visual_brand_dna.subject_archetype);
  assert.ok(anchor.derived_from.includes('visual-dna'));
});

test('brand-voice.formatVisualForHiggsfield: works on built anchor', () => {
  const anchor = brandVoice.buildAnchor({
    business: { id: 'biz-fmt', business_name: 'X', industry: 'plumber' },
  });
  const suffix = brandVoice.formatVisualForHiggsfield(anchor);
  assert.ok(suffix.length > 30);
});

test('brand-voice.formatAnchorForPrompt: now contains visual DNA section', () => {
  const anchor = brandVoice.buildAnchor({
    business: { id: 'biz-prompt', business_name: 'X', industry: 'restaurant' },
  });
  const block = brandVoice.formatAnchorForPrompt(anchor);
  assert.ok(/Visual brand DNA/.test(block),
    'Anchor prompt block should now include visual DNA so every LLM call sees it');
});
