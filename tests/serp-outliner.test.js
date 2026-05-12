'use strict';

const test = require('node:test');
const assert = require('node:assert');

const outliner = require('../services/ai-seo/serp-outliner');

// ─── parseOutlineOutput ─────────────────────────────────────────────────────

test('serp-outliner: parses well-formed outline', () => {
  const out = outliner.parseOutlineOutput(
    JSON.stringify({
      title: 'Best Cafes in Tirana — 2026 Guide',
      meta_description: 'A curated guide to the top cafés in Tirana with maps + opening hours.',
      primary_entity: 'cafés in Tirana',
      lsi_keywords: ['specialty coffee', 'brunch', 'Blloku'],
      gaps_found: ['no one covers cafe wifi quality'],
      sections: [
        {
          h2: 'How we ranked',
          intent: 'informational',
          key_points: ['methodology'],
          lsi_to_include: ['ranking'],
          is_gap_fill: false,
          is_citable: true,
        },
        {
          h2: 'Best wifi cafes',
          intent: 'informational',
          key_points: ['fiber'],
          lsi_to_include: ['wifi'],
          is_gap_fill: true,
          is_citable: true,
        },
      ],
    })
  );
  assert.strictEqual(out.title, 'Best Cafes in Tirana — 2026 Guide');
  assert.strictEqual(out.sections.length, 2);
  assert.strictEqual(out.sections[1].is_gap_fill, true);
});

test('serp-outliner: returns null on garbage', () => {
  assert.strictEqual(outliner.parseOutlineOutput('not json'), null);
  assert.strictEqual(outliner.parseOutlineOutput(''), null);
  assert.strictEqual(outliner.parseOutlineOutput('{}'), null, 'no sections array → null');
});

test('serp-outliner: clamps section count to MAX_SECTIONS', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ h2: `H${i}`, key_points: [] }));
  const out = outliner.parseOutlineOutput(JSON.stringify({ sections: many }));
  assert.strictEqual(out.sections.length, outliner.MAX_SECTIONS);
});

test('serp-outliner: strips markdown fences', () => {
  const out = outliner.parseOutlineOutput('```json\n{"title":"x","sections":[{"h2":"intro"}]}\n```');
  assert.strictEqual(out.title, 'x');
});

test('serp-outliner: drops sections without h2', () => {
  const out = outliner.parseOutlineOutput(
    JSON.stringify({
      sections: [{ h2: 'good one', key_points: [] }, { h2: '', key_points: ['x'] }, { /* no h2 */ key_points: ['y'] }],
    })
  );
  assert.strictEqual(out.sections.length, 1);
});

// ─── buildOutline ───────────────────────────────────────────────────────────

test('buildOutline: throws on missing args', async () => {
  await assert.rejects(outliner.buildOutline({}), /callClaude required/);
  await assert.rejects(outliner.buildOutline({ callClaude: async () => '' }), /keyword required/);
});

test('buildOutline: passes SERP results into Claude prompt', async () => {
  const captured = [];
  const fakeClaude = async (args) => {
    captured.push(args);
    return JSON.stringify({
      title: 'X',
      sections: [{ h2: 'section 1', key_points: ['p1'] }],
    });
  };
  const fakeFetchSerp = async () => [
    { title: 'Top result A', url: 'https://a.com', snippet: 'Snippet A' },
    { title: 'Top result B', url: 'https://b.com', snippet: 'Snippet B' },
  ];
  const out = await outliner.buildOutline({
    keyword: 'best cafe tirana',
    business: { business_name: 'Test', industry: 'cafe' },
    callClaude: fakeClaude,
    fetchSerp: fakeFetchSerp,
  });
  assert.ok(out);
  assert.match(captured[0].user, /best cafe tirana/);
  assert.match(captured[0].user, /Top result A/);
  assert.match(captured[0].user, /https:\/\/a\.com/);
  assert.strictEqual(out._serp_citations.length, 2);
});

test('buildOutline: survives SERP fetch failure with empty serp_citations', async () => {
  const fakeClaude = async () => JSON.stringify({ title: 'x', sections: [{ h2: 'h', key_points: [] }] });
  const out = await outliner.buildOutline({
    keyword: 'kw',
    callClaude: fakeClaude,
    fetchSerp: async () => {
      throw new Error('SerpAPI down');
    },
  });
  assert.ok(out, 'outline must still build when SERP fails');
  assert.deepStrictEqual(out._serp_citations, []);
});

test('buildOutline: returns null on malformed Claude output', async () => {
  const fakeClaude = async () => 'completely not json';
  const out = await outliner.buildOutline({
    keyword: 'kw',
    callClaude: fakeClaude,
    fetchSerp: async () => [],
  });
  assert.strictEqual(out, null);
});

test('buildOutline: returns null when Claude throws', async () => {
  const out = await outliner.buildOutline({
    keyword: 'kw',
    callClaude: async () => {
      throw new Error('rate limit');
    },
    fetchSerp: async () => [],
  });
  assert.strictEqual(out, null);
});

// ─── writeArticle ───────────────────────────────────────────────────────────

test('writeArticle: writes one Claude call per section', async () => {
  const captured = [];
  const fakeClaude = async (args) => {
    captured.push(args);
    return `Body for section ${captured.length}.`;
  };
  const outline = {
    title: 'Title',
    primary_entity: 'cafes',
    sections: [
      { h2: 'Intro', key_points: ['p1'], lsi_to_include: [], is_gap_fill: false },
      { h2: 'Method', key_points: ['p2'], lsi_to_include: [], is_gap_fill: false },
      { h2: 'Gap section', key_points: ['p3'], lsi_to_include: [], is_gap_fill: true },
    ],
    _serp_citations: [{ url: 'x', title: 'y' }],
  };
  const article = await outliner.writeArticle({
    outline,
    callClaude: fakeClaude,
    business: { business_name: 'Test' },
  });
  assert.strictEqual(captured.length, 3);
  assert.strictEqual(article.sections.length, 3);
  assert.strictEqual(article.sections_shipped, 3);
  assert.strictEqual(article.sections_attempted, 3);
  // Gap-fill section must include the gap-fill warning in its prompt
  assert.match(captured[2].user, /GAP-FILL/);
  // Continuity: second section should reference the first
  assert.match(captured[1].user, /PRIOR SECTIONS/);
  assert.match(captured[1].user, /Body for section 1/);
});

test('writeArticle: surviving sections still ship when one fails', async () => {
  let i = 0;
  const fakeClaude = async () => {
    i++;
    if (i === 2) throw new Error('rate limit');
    return `section ${i}`;
  };
  const outline = {
    title: 'T',
    primary_entity: 'e',
    sections: [
      { h2: 's1', key_points: [], lsi_to_include: [] },
      { h2: 's2', key_points: [], lsi_to_include: [] },
      { h2: 's3', key_points: [], lsi_to_include: [] },
    ],
  };
  const article = await outliner.writeArticle({ outline, callClaude: fakeClaude });
  assert.strictEqual(article.sections_attempted, 3);
  assert.strictEqual(article.sections_shipped, 2);
});

test('writeArticle: throws on missing outline', async () => {
  await assert.rejects(outliner.writeArticle({ callClaude: async () => 'x' }), /outline with sections required/);
});

test('writeArticle: throws on missing callClaude', async () => {
  await assert.rejects(outliner.writeArticle({ outline: { sections: [{ h2: 'x' }] } }), /callClaude required/);
});
