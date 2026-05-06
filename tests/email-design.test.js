'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ed = require('../services/prompts/email-design');

// ─── SVG charts ────────────────────────────────────────────────────────────

test('sparkline: produces valid SVG with polyline', () => {
  const svg = ed.sparkline({ values: [1, 2, 3, 2, 4, 5, 3] });
  assert.match(svg, /<svg[^>]*>/);
  assert.match(svg, /<polyline/);
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});

test('sparkline: handles too-few values gracefully', () => {
  const svg = ed.sparkline({ values: [] });
  assert.match(svg, /<svg/);
  // Should NOT contain polyline since no data
  assert.ok(!/polyline/.test(svg));
});

test('bar: produces SVG with rect for each item', () => {
  const svg = ed.bar({
    items: [
      { label: 'Meta', value: 3.0 },
      { label: 'Google', value: 1.5 },
    ],
  });
  // 4 rects (background + value) per item × 2 items = 4 rects
  const rectCount = (svg.match(/<rect/g) || []).length;
  assert.strictEqual(rectCount, 4);
  assert.match(svg, /Meta/);
  assert.match(svg, /Google/);
});

test('bar: empty input returns minimal SVG', () => {
  const svg = ed.bar({ items: [] });
  assert.match(svg, /<svg[^>]*><\/svg>/);
});

test('gauge: color reflects score band', () => {
  const high = ed.gauge({ value: 85 });
  const mid  = ed.gauge({ value: 55 });
  const low  = ed.gauge({ value: 25 });
  assert.match(high, /#10B981/); // green
  assert.match(mid,  /#F59E0B/); // amber
  assert.match(low,  /#EF4444/); // red
});

test('gauge: clamps out-of-range values', () => {
  const over = ed.gauge({ value: 150 });
  const under = ed.gauge({ value: -50 });
  // Both should produce valid SVG with score capped
  assert.match(over, />100</);
  assert.match(under, /<text[^>]*>0</);
});

test('donut: zero total returns empty SVG', () => {
  const svg = ed.donut({ slices: [{ label: 'A', value: 0 }, { label: 'B', value: 0 }] });
  assert.match(svg, /<svg[^>]*><\/svg>/);
});

test('donut: produces path per slice', () => {
  const svg = ed.donut({
    slices: [
      { label: 'positive', value: 70, color: '#10B981' },
      { label: 'neutral',  value: 20 },
      { label: 'negative', value: 10 },
    ],
    centerLabel: '70%',
  });
  const pathCount = (svg.match(/<path/g) || []).length;
  assert.strictEqual(pathCount, 3);
  assert.match(svg, /70%/);
});

// ─── Brand color helper ────────────────────────────────────────────────────

test('brandColor: uses brand_color_primary when set', () => {
  const c = ed.brandColor({ brand_color_primary: '#FF6B00' });
  assert.strictEqual(c, '#FF6B00');
});

test('brandColor: industry default for cafe', () => {
  const c = ed.brandColor({ industry: 'cafe' });
  assert.match(c, /^#/);
});

test('brandColor: falls back to generic blue', () => {
  const c = ed.brandColor({});
  assert.strictEqual(c, '#3B82F6');
});

// ─── Scorecard email ─────────────────────────────────────────────────────

test('scorecard: produces valid HTML + plain-text + subject + preview', () => {
  const r = ed.scorecard({
    business: { business_name: 'Cafe Petit', industry: 'cafe', logo_url: 'https://example.com/logo.png' },
    marketProfile: { primary_language: 'sq', currency: 'ALL', locale: 'sq-AL' },
    scorecardData: {
      week: { spend: 350, conversions: 28, roas: 2.4 },
      deltas: { spend_pct: 0.15, conversions_pct: 0.20, roas_pct: 0.05 },
      campaigns_ranked: [{ campaign_name: 'Summer Promo', roas_avg: 3.0 }],
      roas_daily_7d: [2.1, 2.3, 2.4, 2.2, 2.5, 2.4, 2.4],
    },
    commentary: {
      trend_interpretation: 'Konvertimet u rritën 20% këtë javë.',
      top_actions: [{ action: 'Shtoni buxhetin për fushatën verore.', time_to_ship_minutes: 10 }],
      win_of_the_week: 'Java më e mirë e këtij muaji!',
    },
  });
  assert.match(r.html, /<html/);
  assert.match(r.html, /<svg/);
  assert.match(r.html, /Cafe Petit/);
  assert.match(r.html, /Konvertimet u rritën/);
  assert.ok(r.plain_text.length > 50);
  assert.match(r.subject, /Cafe Petit/);
  assert.match(r.subject, /raporti/i);
  assert.ok(r.preview_text.length <= 120);
});

test('scorecard: gracefully handles missing commentary', () => {
  const r = ed.scorecard({
    business: { business_name: 'Plain Co' },
    marketProfile: { primary_language: 'en', currency: 'USD', locale: 'en-US' },
    scorecardData: { week: { spend: 100, conversions: 5, roas: 2.0 }, deltas: {} },
    commentary: null,
  });
  assert.match(r.html, /<html/);
  assert.match(r.html, /Plain Co/);
});

test('scorecard: RTL flag flips body direction for Arabic', () => {
  const r = ed.scorecard({
    business: { business_name: 'Cafe Dubai' },
    marketProfile: { primary_language: 'ar', currency: 'AED', locale: 'ar-AE', text_direction: 'rtl' },
    scorecardData: { week: { spend: 1000, conversions: 50, roas: 3.0 }, deltas: {} },
  });
  assert.match(r.html, /dir="rtl"/);
});

test('scorecard: localizes labels per language', () => {
  const en = ed.scorecard({
    business: { business_name: 'X' },
    marketProfile: { primary_language: 'en', currency: 'USD', locale: 'en-US' },
    scorecardData: { week: { spend: 100, conversions: 5, roas: 2.0 }, deltas: {} },
  });
  const de = ed.scorecard({
    business: { business_name: 'X' },
    marketProfile: { primary_language: 'de', currency: 'EUR', locale: 'de-DE' },
    scorecardData: { week: { spend: 100, conversions: 5, roas: 2.0 }, deltas: {} },
  });
  assert.match(en.html, /Spend/);
  assert.match(de.html, /Ausgaben/);
});

// ─── Ad audit summary email ──────────────────────────────────────────────

test('adAuditSummary: produces HTML with decision badge + gauge', () => {
  const r = ed.adAuditSummary({
    business: { business_name: 'X', industry: 'saas' },
    marketProfile: { primary_language: 'en', currency: 'USD', locale: 'en-US' },
    audit: {
      decision: 'pause',
      decision_reason: 'ROAS dropped below break-even for 5 days',
      audit_score: 35,
    },
    narrative: {
      narrative_full: 'ROAS at 0.7. We considered keeping. Trend declining 5 days. Pausing now. Re-test with new creative.',
    },
  });
  assert.match(r.html, /pause/);
  assert.match(r.html, /<svg/); // gauge
  assert.match(r.html, /ROAS at 0.7/);
  assert.match(r.subject, /audit/i);
});

test('adAuditSummary: renders without narrative gracefully', () => {
  const r = ed.adAuditSummary({
    business: { business_name: 'X' },
    marketProfile: { primary_language: 'en', currency: 'USD', locale: 'en-US' },
    audit: { decision: 'keep', decision_reason: 'Stable.', audit_score: 70 },
  });
  assert.match(r.html, /keep/);
});

// ─── Escape safety ────────────────────────────────────────────────────────

test('scorecard: escapes business names with HTML special chars', () => {
  const r = ed.scorecard({
    business: { business_name: 'Tom & Jerry <Cafe>' },
    marketProfile: { primary_language: 'en', currency: 'USD', locale: 'en-US' },
    scorecardData: { week: { spend: 100, conversions: 5, roas: 2.0 }, deltas: {} },
  });
  assert.match(r.html, /Tom &amp; Jerry &lt;Cafe&gt;/);
  // Should NOT contain literal < or > from user input
  assert.ok(!/<Cafe>/.test(r.html));
});
