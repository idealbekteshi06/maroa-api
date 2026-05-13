'use strict';

const test = require('node:test');
const assert = require('node:assert');

const taxonomy = require('../lib/taxonomy');
const { industries, regions, expertSources } = taxonomy;

// ─── industries ────────────────────────────────────────────────────────────

test('industries: catalog has 50+ verticals', () => {
  assert.ok(industries.INDUSTRIES.length >= 50, `expected ≥50, got ${industries.INDUSTRIES.length}`);
});

test('industries: every entry has required fields', () => {
  for (const ind of industries.INDUSTRIES) {
    assert.ok(ind.id, `missing id: ${JSON.stringify(ind)}`);
    assert.ok(ind.label, `missing label: ${ind.id}`);
    assert.ok(Array.isArray(ind.seedKeywords), `seedKeywords must be array: ${ind.id}`);
    assert.ok(Array.isArray(ind.peerIndustries), `peerIndustries must be array: ${ind.id}`);
    assert.ok(Array.isArray(ind.formats), `formats must be array: ${ind.id}`);
  }
});

test('industries: getById returns matching entry', () => {
  const cafe = industries.getById('cafe');
  assert.ok(cafe);
  assert.strictEqual(cafe.id, 'cafe');
  assert.ok(cafe.peerIndustries.includes('restaurant'));
});

test('industries: getById returns null for unknown', () => {
  assert.strictEqual(industries.getById('not_an_industry'), null);
});

test('industries: getExpandingCircles for cafe returns peers + smb fallback', () => {
  const circles = industries.getExpandingCircles('cafe');
  assert.strictEqual(circles[0], 'cafe', 'self first');
  assert.ok(circles.includes('restaurant'));
  assert.ok(circles[circles.length - 1] === 'smb_general' || circles.includes('smb_general'));
});

test('industries: getExpandingCircles for unknown returns smb_general fallback', () => {
  assert.deepStrictEqual(industries.getExpandingCircles('garbage'), ['smb_general']);
});

test('industries: all peer references resolve to actual industries', () => {
  const allIds = new Set(industries.getAllIds());
  for (const ind of industries.INDUSTRIES) {
    for (const peer of ind.peerIndustries) {
      assert.ok(allIds.has(peer), `${ind.id} references unknown peer "${peer}"`);
    }
  }
});

// ─── regions ───────────────────────────────────────────────────────────────

test('regions: catalog covers 40+ markets', () => {
  assert.ok(regions.REGIONS.length >= 40, `expected ≥40, got ${regions.REGIONS.length}`);
});

test('regions: every entry has required fields', () => {
  for (const r of regions.REGIONS) {
    assert.ok(r.id);
    assert.ok(r.label);
    assert.ok(Array.isArray(r.languages));
    assert.ok(r.cluster);
    assert.ok(r.currency);
  }
});

test('regions: includes all 6 cluster aggregates', () => {
  for (const id of ['GLOBAL', 'EU', 'NA', 'APAC', 'LATAM', 'MENA']) {
    assert.ok(regions.getById(id), `missing region: ${id}`);
  }
});

test('regions: AL (Albania) expands to Balkan peers + EU + GLOBAL', () => {
  const circles = regions.getExpandingCircles('AL');
  assert.strictEqual(circles[0], 'AL');
  assert.ok(circles.includes('XK') || circles.includes('MK'), 'should include Balkan peer');
  assert.ok(circles.includes('EU'));
  assert.strictEqual(circles[circles.length - 1], 'GLOBAL');
});

test('regions: getExpandingCircles for unknown returns GLOBAL only', () => {
  assert.deepStrictEqual(regions.getExpandingCircles('ZZ'), ['GLOBAL']);
});

test('regions: getByCluster returns members', () => {
  const eu = regions.getByCluster('EU');
  assert.ok(eu.includes('DE'));
  assert.ok(eu.includes('FR'));
  assert.ok(eu.includes('AL'));
});

// ─── expert sources ────────────────────────────────────────────────────────

test('expertSources: has award archives + publications + brand catalog', () => {
  assert.ok(expertSources.AWARD_ARCHIVES.length >= 4);
  assert.ok(expertSources.PUBLICATIONS.length >= 5);
  assert.ok(Object.keys(expertSources.EXPERT_BRANDS).length >= 15);
});

test('expertSources: brands per industry have valid shape', () => {
  for (const [industryId, brands] of Object.entries(expertSources.EXPERT_BRANDS)) {
    assert.ok(industries.getById(industryId), `expert brand industry "${industryId}" missing from taxonomy`);
    for (const brand of brands) {
      assert.ok(brand.name, `missing brand name in ${industryId}`);
      assert.ok(brand.region, `missing region in ${industryId}/${brand.name}`);
      assert.ok(typeof brand.qualityScore === 'number');
      assert.ok(brand.qualityScore >= 0 && brand.qualityScore <= 1);
    }
  }
});

test('expertSources: getBrandsForIndustry returns known brands', () => {
  const cafeBrands = expertSources.getBrandsForIndustry('cafe');
  assert.ok(cafeBrands.length >= 3);
  assert.ok(cafeBrands.some((b) => /starbucks|blue bottle|stumptown/i.test(b.name)));
});

test('expertSources: getAllExpertBrands flattens with industry tag', () => {
  const all = expertSources.getAllExpertBrands();
  assert.ok(all.length > 50);
  for (const b of all) {
    assert.ok(b.industry);
    assert.ok(b.name);
  }
});

test('taxonomy: unified index exposes all sub-modules', () => {
  assert.ok(taxonomy.industries);
  assert.ok(taxonomy.regions);
  assert.ok(taxonomy.expertSources);
  assert.strictEqual(taxonomy.VERSION, 'v1');
});
