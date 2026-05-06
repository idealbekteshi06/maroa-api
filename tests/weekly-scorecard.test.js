'use strict';

/**
 * tests/weekly-scorecard.test.js
 * Tests for the weekly scorecard data builder + email template.
 */

const test = require('node:test');
const assert = require('node:assert');

const sc = require('../services/prompts/weekly-scorecard');

// ─── 1-4. buildScorecardData ───────────────────────────────────────────────

test('buildScorecardData: handles empty input', () => {
  const r = sc.buildScorecardData({ thisWeekRows: [], prevWeekRows: [], campaigns: [] });
  assert.strictEqual(r.sample_quality, 'insufficient');
  assert.strictEqual(r.best_campaign, null);
});

test('buildScorecardData: aggregates spend + clicks correctly', () => {
  const thisWeekRows = [
    { campaign_id: 'c1', spend: 10, clicks: 100, conversions: 5, roas: 2.0 },
    { campaign_id: 'c1', spend: 15, clicks: 120, conversions: 6, roas: 2.1 },
    { campaign_id: 'c2', spend: 20, clicks: 80,  conversions: 1, roas: 0.5 },
  ];
  const r = sc.buildScorecardData({ thisWeekRows, prevWeekRows: [], campaigns: [{ id: 'c1', business_name: 'A' }, { id: 'c2', business_name: 'B' }] });
  assert.strictEqual(r.week.spend, 45);
  assert.strictEqual(r.week.clicks, 300);
  assert.strictEqual(r.week.conversions, 12);
});

test('buildScorecardData: identifies best/worst campaign by ROAS', () => {
  const thisWeekRows = [
    { campaign_id: 'a', spend: 50, conversions: 10, roas: 3.0 },
    { campaign_id: 'b', spend: 50, conversions: 1,  roas: 0.5 },
  ];
  const r = sc.buildScorecardData({
    thisWeekRows, prevWeekRows: [],
    campaigns: [{ id: 'a', business_name: 'Alpha' }, { id: 'b', business_name: 'Beta' }],
  });
  assert.strictEqual(r.best_campaign.campaign_name, 'Alpha');
  assert.strictEqual(r.worst_campaign.campaign_name, 'Beta');
});

test('buildScorecardData: computes WoW deltas', () => {
  const thisWeekRows = [{ campaign_id: 'c1', spend: 100, conversions: 10, roas: 2.0 }];
  const prevWeekRows = [{ campaign_id: 'c1', spend: 80,  conversions: 8,  roas: 1.5 }];
  const r = sc.buildScorecardData({ thisWeekRows, prevWeekRows, campaigns: [] });
  assert.ok(r.deltas.spend_pct > 0.20 && r.deltas.spend_pct < 0.30, 'spend delta should be ~25%');
  assert.ok(r.deltas.roas_pct > 0.30, 'ROAS delta should be ~33%');
});

// ─── 5-6. Email HTML template ──────────────────────────────────────────────

test('buildEmailHtml: produces valid HTML with business name', () => {
  const html = sc.buildEmailHtml({
    business: { business_name: 'Cafe Petit' },
    marketProfile: { currency_symbol: '€' },
    scorecardData: {
      week: { spend: 50, clicks: 200, conversions: 10, roas: 2.0 },
      deltas: { spend_pct: 0.2, conversions_pct: 0.1, roas_pct: 0.05 },
      best_campaign: null, worst_campaign: null,
    },
  });
  assert.match(html, /Cafe Petit/);
  assert.match(html, /Weekly Scorecard/);
  assert.match(html, /€/);
});

test('buildEmailHtml: handles missing commentary gracefully', () => {
  const html = sc.buildEmailHtml({
    business: { business_name: 'X' },
    marketProfile: { currency_symbol: '$' },
    scorecardData: { week: {}, deltas: {} },
    commentary: null,
  });
  assert.ok(html.length > 100);
  assert.match(html, /<h1/);
});

// ─── 7-8. System prompt + model selection ──────────────────────────────────

test('modelForPlan: agency uses Opus, others use Sonnet', () => {
  assert.strictEqual(sc.modelForPlan('agency'), 'claude-opus-4-7');
  assert.strictEqual(sc.modelForPlan('growth'), 'claude-sonnet-4-5');
  assert.strictEqual(sc.modelForPlan('free'), 'claude-sonnet-4-5');
});

test('System prompt enforces "do not invent numbers" rule', () => {
  const sys = sc.buildSystemPrompt();
  assert.match(sys, /never make up numbers/i);
  assert.match(sys, /primary_language/i);
});
