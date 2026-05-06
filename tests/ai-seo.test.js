'use strict';

/**
 * tests/ai-seo.test.js
 * ----------------------------------------------------------------------------
 * Expert-level test suite for the AI-SEO module.
 * 24 tests covering i18n + checks + llms.txt + schema + content rewriter +
 * entity extraction + output schema + end-to-end audit + generate.
 * ----------------------------------------------------------------------------
 */

const test = require('node:test');
const assert = require('node:assert');

const aiSeo = require('../services/prompts/ai-seo');

// ─── 1-3. International market profile ──────────────────────────────────────

test('i18n-seo: buildSeoMarketProfile fills AI penetration + address format', () => {
  const us = aiSeo.i18nSeo.buildSeoMarketProfile({ location: 'New York' });
  assert.strictEqual(us.country, 'US');
  assert.strictEqual(us.ai_search_penetration, 'high');
  assert.deepStrictEqual(us.address_format.fields[0], 'streetAddress');

  const al = aiSeo.i18nSeo.buildSeoMarketProfile({ location: 'Tirana' });
  assert.strictEqual(al.country, 'AL');
  assert.strictEqual(al.ai_search_penetration, 'low');
  assert.strictEqual(al.text_direction, 'ltr');
});

test('i18n-seo: hreflangFor builds correct codes', () => {
  assert.strictEqual(aiSeo.i18nSeo.hreflangFor('US', 'en'), 'en-US');
  assert.strictEqual(aiSeo.i18nSeo.hreflangFor('AL', 'sq'), 'sq-AL');
  assert.strictEqual(aiSeo.i18nSeo.hreflangFor('BR', 'pt'), 'pt-BR');
});

test('i18n-seo: relevantAiAssistants excludes blocked regions', () => {
  const us = aiSeo.i18nSeo.relevantAiAssistants('US');
  assert.ok(us.includes('ChatGPT'));
  const cn = aiSeo.i18nSeo.relevantAiAssistants('CN');
  assert.strictEqual(cn.includes('ChatGPT'), false);
  assert.strictEqual(cn.includes('Claude'), false);
});

// ─── 4-7. Citability checks ────────────────────────────────────────────────

test('checks: S01 fires when no JSON-LD present', () => {
  const f = aiSeo.checks.runChecks({
    html: '<html><body>Hello</body></html>',
    text: 'Hello world',
    business: {},
    marketProfile: {},
    plan: 'agency',
  });
  assert.ok(f.find(x => x.check_id === 'S01'), 'S01 must fire on no-schema page');
});

test('checks: S03 fires for location-based business with no LocalBusiness schema', () => {
  const f = aiSeo.checks.runChecks({
    html: '<html><body>Welcome</body></html>',
    text: 'Welcome',
    business: { operation_model: 'location_based' },
    marketProfile: { country: 'US' },
    plan: 'agency',
  });
  assert.ok(f.find(x => x.check_id === 'S03'), 'S03 must fire for missing LocalBusiness schema');
});

test('checks: S15 fires when llms.txt missing (critical)', () => {
  const f = aiSeo.checks.runChecks({
    html: '<html></html>', text: 'x',
    business: {}, marketProfile: {},
    llms_txt_present: false,
    plan: 'agency',
  });
  const s15 = f.find(x => x.check_id === 'S15');
  assert.ok(s15, 'S15 must fire when llms.txt missing');
  assert.strictEqual(s15.severity, 'critical');
});

test('checks: plan-tier limits — free=5, growth has more, agency runs all', () => {
  assert.strictEqual(aiSeo.checks.PRIORITY_FREE_SET.length, 5);
  assert.ok(aiSeo.checks.PRIORITY_GROWTH_SET.length > 5);
});

// ─── 8-10. llms.txt generator ───────────────────────────────────────────────

test('llms-txt: buildLlmsTxt produces compact valid markdown', () => {
  const txt = aiSeo.llmsTxt.buildLlmsTxt({
    business: { business_name: 'Cafe Petit', tagline: 'Best coffee in Tirana', industry: 'cafe', country_code: 'AL' },
    pages: [{ title: 'Menu', url: '/menu', summary: 'Drinks + pastries' }],
    primaryLanguage: 'sq',
  });
  assert.match(txt, /^# Cafe Petit/);
  assert.match(txt, /> Best coffee/);
  assert.match(txt, /## Key Pages/);
  assert.match(txt, /Menu/);
  assert.match(txt, /Language: sq/);
});

test('llms-txt: handles missing fields without crashing', () => {
  const txt = aiSeo.llmsTxt.buildLlmsTxt({ business: {}, pages: [], primaryLanguage: 'en' });
  assert.match(txt, /^# Business/);
  assert.ok(txt.length > 0);
});

test('llms-txt: token estimate roughly correct (4 chars/token)', () => {
  const t = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';
  const tokens = aiSeo.llmsTxt.estimateTokens(t);
  assert.ok(tokens > 10 && tokens < 20, `estimate should be 10-20, got ${tokens}`);
});

// ─── 11-15. Schema builders ─────────────────────────────────────────────────

test('schema: Organization includes only fields present in business', () => {
  const org = aiSeo.schemaBuilder.buildOrganization({
    business: { business_name: 'Acme', website: 'https://acme.com' },
  });
  assert.strictEqual(org['@type'], 'Organization');
  assert.strictEqual(org.name, 'Acme');
  assert.strictEqual(org.url, 'https://acme.com');
  assert.strictEqual(org.email, undefined);  // not invented
  assert.strictEqual(org.contactPoint, undefined);
});

test('schema: LocalBusiness uses correct address fields per country', () => {
  const us = aiSeo.schemaBuilder.buildLocalBusiness({
    business: { business_name: 'Joe Cafe', address: { streetAddress: '123 Main', addressLocality: 'NYC' } },
    marketProfile: { country: 'US' },
  });
  assert.strictEqual(us['@type'], 'LocalBusiness');
  assert.strictEqual(us.address['@type'], 'PostalAddress');
  assert.strictEqual(us.address.addressCountry, 'US');
});

test('schema: FAQPage built only with valid Q&A pairs', () => {
  const faq = aiSeo.schemaBuilder.buildFaqPage({
    qaPairs: [
      { question: 'Are you open Sundays?', answer: 'Yes 10-6.' },
      { question: '', answer: 'orphan' },        // invalid — should drop
      { question: 'Where?', answer: 'Tirana.' },
    ],
  });
  assert.strictEqual(faq.mainEntity.length, 2);
  assert.strictEqual(faq.mainEntity[0]['@type'], 'Question');
});

test('schema: HowTo requires name + steps; returns null otherwise', () => {
  assert.strictEqual(aiSeo.schemaBuilder.buildHowTo({ name: 'X', steps: [] }), null);
  assert.strictEqual(aiSeo.schemaBuilder.buildHowTo({ name: '', steps: ['s1'] }), null);
  const ht = aiSeo.schemaBuilder.buildHowTo({ name: 'Make coffee', steps: ['Boil water', 'Add grounds', 'Wait'] });
  assert.strictEqual(ht.step.length, 3);
  assert.strictEqual(ht.step[0].position, 1);
});

test('schema: opening hours formatter handles "9-17" and {open,close} formats', () => {
  const out = aiSeo.schemaBuilder.formatHours({
    mon: '9-17',
    tue: { open: '10:00', close: '18:00' },
  });
  assert.ok(Array.isArray(out));
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].dayOfWeek, 'Monday');
  assert.strictEqual(out[0].opens, '09:00');
  assert.strictEqual(out[1].opens, '10:00');
});

// ─── 16-18. Content rewriter ────────────────────────────────────────────────

test('rewriter: stripBuzzwords removes generic marketing language', () => {
  const r = aiSeo.rewriter.stripBuzzwords('Our world-class, cutting-edge, innovative platform leverages synergy.');
  assert.ok(r.removed_count >= 4, `should strip 4+ buzzwords, got ${r.removed_count}`);
  assert.ok(!/world.?class/i.test(r.stripped));
});

test('rewriter: scoreExtractability rewards TL;DR + bullets + numbers', () => {
  const bad = aiSeo.rewriter.scoreExtractability('We are best in class. Innovative. World-class. Cutting-edge.');
  const good = aiSeo.rewriter.scoreExtractability(
    'TL;DR: We help cafes increase orders by 30%.\n- Open 8-22 daily\n- 50+ menu items\n- 4.7/5 across 200 reviews\nWhat is X? It is Y.'
  );
  assert.ok(good > bad, `good text should outscore bad: good=${good}, bad=${bad}`);
});

test('rewriter: suggestStandardQuestions varies by industry + locality', () => {
  const cafe = aiSeo.rewriter.suggestStandardQuestions({
    business: { business_name: 'Q', industry: 'cafe', operation_model: 'location_based' },
  });
  assert.ok(cafe.some(q => /menu/i.test(q)));
  assert.ok(cafe.some(q => /located/i.test(q)));

  const saas = aiSeo.rewriter.suggestStandardQuestions({
    business: { business_name: 'Q', industry: 'saas', operation_model: 'online' },
  });
  assert.ok(saas.some(q => /trial/i.test(q) || /integration/i.test(q)));
});

// ─── 19-20. Entity extraction ──────────────────────────────────────────────

test('entity: buildSameAs extracts canonical platform URLs', () => {
  const sa = aiSeo.entity.buildSameAs({
    business: {
      facebook_url: 'https://facebook.com/acme',
      instagram_url: 'instagram.com/acme',
    },
    additionalText: 'Find us on linkedin.com/company/acme',
  });
  assert.ok(sa.find(u => u.includes('facebook.com/acme')));
  assert.ok(sa.find(u => u.includes('instagram.com/acme')));
  assert.ok(sa.find(u => u.includes('linkedin.com/company/acme')));
});

test('entity: detectEntityGaps lists missing canonical platforms', () => {
  const gaps = aiSeo.entity.detectEntityGaps({ sameAs: ['https://facebook.com/acme'] });
  assert.ok(gaps.includes('linkedin'));
  assert.ok(gaps.includes('wikipedia'));
});

// ─── 21-22. Output schema ─────────────────────────────────────────────────

test('schema-validate: rejects audit_score out of range', () => {
  const r = aiSeo.schema.validateAuditOutput({ audit_score: 150, dimension_scores: {} });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => /audit_score/.test(e)));
});

test('schema-validate: accepts valid audit + normalizes', () => {
  const r = aiSeo.schema.validateAuditOutput({
    audit_score: 65,
    dimension_scores: { schema_markup: 40, citation_worthiness: 70 },
    critical_gaps: [{ id: 'S01', severity: 'critical', fix: 'Add schema' }],
    ai_search_readiness: 'partial',
    estimated_citation_potential: 'medium',
  });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.normalized.audit_score, 65);
  assert.strictEqual(r.normalized.ai_search_readiness, 'partial');
});

// ─── 23-24. End-to-end audit + generate ────────────────────────────────────

test('auditSite: short-circuits with no content + returns deterministic baseline', async () => {
  let claudeCalled = false;
  const r = await aiSeo.auditSite({
    business: { business_name: 'Empty Site', plan: 'free' },
    html: '',
    text: '',
    plan: 'free',
    callClaude: async () => { claudeCalled = true; return '{}'; },
    extractJSON: JSON.parse,
  });
  assert.strictEqual(claudeCalled, false);
  assert.strictEqual(r.short_circuited, true);
  assert.strictEqual(r.ai_search_readiness, 'minimal');
  assert.ok(r.audit_score <= 30, 'empty site cannot exceed 30');
});

test('generateArtifacts: free tier returns deterministic-only output (no LLM call)', async () => {
  let claudeCalled = false;
  const r = await aiSeo.generateArtifacts({
    business: { business_name: 'Tirana Cafe', operation_model: 'location_based', location: 'Tirana, Albania', primary_language: 'sq', website: 'https://tiranacafe.al' },
    pages: [{ title: 'Home', url: 'https://tiranacafe.al/', summary: 'Welcome' }],
    plan: 'free',
    callClaude: async () => { claudeCalled = true; return '{}'; },
    extractJSON: JSON.parse,
  });
  assert.strictEqual(claudeCalled, false, 'free tier should NOT call LLM');
  assert.strictEqual(r.llm_used, false);
  assert.ok(r.llms_txt.length > 0);
  // Should include Organization + WebSite + LocalBusiness (location_based)
  const types = r.schema_blocks.map(b => b.type);
  assert.ok(types.includes('Organization'));
  assert.ok(types.includes('WebSite'));
  assert.ok(types.includes('LocalBusiness'));
});
