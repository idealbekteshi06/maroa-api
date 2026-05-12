'use strict';

/**
 * tests/grounding-context.test.js
 *
 * Verifies lib/groundingContext.js — the grounding layer that injects
 * wins/losses/VoC/cohort/brand into every prompt.
 */

const test = require('node:test');
const assert = require('node:assert');

const gc = require('../lib/groundingContext');

// ─── Fake sbGet factory ─────────────────────────────────────────────────────

function makeSbGet(seeded = {}) {
  return async (table, query = '') => {
    const data = seeded[table] || [];
    const businessMatch = query.match(/business_id=eq\.([^&]+)/);
    const userMatch = query.match(/user_id=eq\.([^&]+)/);
    const industryMatch = query.match(/industry=eq\.([^&]+)/);
    // Match `id=eq.X` only when at start or preceded by `&`, not when inside
    // a longer column name like `business_id=eq.X`.
    const idMatch = query.match(/(?:^|&)id=eq\.([^&]+)/);
    let filtered = data;
    if (idMatch) filtered = filtered.filter((r) => r.id === idMatch[1]);
    if (businessMatch) filtered = filtered.filter((r) => r.business_id === businessMatch[1]);
    if (userMatch) filtered = filtered.filter((r) => r.user_id === userMatch[1]);
    if (industryMatch) filtered = filtered.filter((r) => r.industry === decodeURIComponent(industryMatch[1]));
    return filtered;
  };
}

// ─── buildGroundingContext ──────────────────────────────────────────────────

test('grounding: returns empty context when sbGet or businessId missing', async () => {
  const ctxA = await gc.buildGroundingContext({});
  assert.strictEqual(ctxA.isEmpty(), true);
  assert.strictEqual(ctxA.toPromptBlock(), '');
  const ctxB = await gc.buildGroundingContext({ sbGet: makeSbGet() });
  assert.strictEqual(ctxB.isEmpty(), true);
});

test('grounding: empty when business has no history', async () => {
  gc._resetCache();
  const sbGet = makeSbGet({});
  const ctx = await gc.buildGroundingContext({
    sbGet,
    businessId: 'biz1',
    surface: 'social_post',
  });
  assert.strictEqual(ctx.isEmpty(), true);
});

test('grounding: builds wins from recent published content', async () => {
  gc._resetCache();
  const now = new Date();
  const recent = new Date(now.getTime() - 1 * 86400000).toISOString();
  const sbGet = makeSbGet({
    businesses: [{ id: 'biz1', industry: 'cafe', daily_budget: 30 }],
    generated_content: Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      business_id: 'biz1',
      status: 'published',
      published_at: recent,
      instagram_caption: `Caption ${i}: great cafe vibes`,
      content_theme: 'morning_routine',
    })),
  });
  const ctx = await gc.buildGroundingContext({
    sbGet,
    businessId: 'biz1',
    surface: 'social_post',
    limit: 3,
  });
  assert.strictEqual(ctx.wins.length, 3);
  assert.match(ctx.wins[0].excerpt, /great cafe vibes/);
  assert.strictEqual(ctx.wins[0].theme, 'morning_routine');
});

test('grounding: ad_copy surface pulls from ad_performance_logs and ranks by ROAS', async () => {
  gc._resetCache();
  const recent = new Date(Date.now() - 86400000).toISOString();
  const sbGet = async (table, query) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', daily_budget: 30 }];
    if (table === 'generated_content') {
      return [
        { id: 'g1', business_id: 'biz1', status: 'published', published_at: recent, google_ad_headline: 'Buy now' },
      ];
    }
    if (table === 'ad_performance_logs') {
      return [
        { id: 'a1', roas: 4.5, ctr: 0.06, recommendation: 'Free coffee Tuesdays' },
        { id: 'a2', roas: 3.1, ctr: 0.04, recommendation: '20% off subscription' },
        { id: 'a3', roas: 0.8, ctr: 0.01, recommendation: 'Generic product photo' },
      ];
    }
    return [];
  };
  const ctx = await gc.buildGroundingContext({
    sbGet,
    businessId: 'biz1',
    surface: 'ad_copy',
    limit: 2,
  });
  assert.strictEqual(ctx.wins.length, 2);
  assert.strictEqual(ctx.wins[0].roas, 4.5);
  assert.match(ctx.wins[0].excerpt, /Free coffee/);
  // Losses bottom-2 in reversed order
  assert.strictEqual(ctx.losses.length, 2);
  assert.strictEqual(ctx.losses[0].roas, 0.8);
});

test('grounding: pulls VoC themes from customer_insights', async () => {
  gc._resetCache();
  const sbGet = async (table, query) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', daily_budget: 30 }];
    if (table === 'customer_insights' && query.includes('user_id=eq.biz1')) {
      return [
        { user_id: 'biz1', insight_type: 'pain_point', actionable_suggestion: 'Reviews say service is too slow' },
        { user_id: 'biz1', insight_type: 'trigger_event', actionable_suggestion: 'Pre-work morning rush' },
      ];
    }
    return [];
  };
  const ctx = await gc.buildGroundingContext({ sbGet, businessId: 'biz1', surface: 'social_post' });
  assert.strictEqual(ctx.voc.length, 2);
  assert.strictEqual(ctx.voc[0].type, 'pain_point');
  assert.match(ctx.voc[0].suggestion, /too slow/);
});

test('grounding: pulls cohort patterns for industry + budget tier', async () => {
  gc._resetCache();
  const sbGet = async (table, query) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', daily_budget: 30 }];
    if (table === 'cross_account_patterns' && query.includes('budget_tier=eq.20')) {
      return [
        {
          pattern_type: 'hook',
          pattern_signature: 'before_after_image+question',
          median_roas_lift: 1.6,
          confidence: 0.85,
        },
      ];
    }
    return [];
  };
  const ctx = await gc.buildGroundingContext({ sbGet, businessId: 'biz1', surface: 'ad_copy' });
  assert.strictEqual(ctx.cohort.length, 1);
  assert.strictEqual(ctx.cohort[0].type, 'hook');
  assert.strictEqual(ctx.cohort[0].roas_lift, 1.6);
});

test('grounding: pulls brand voice anchor', async () => {
  gc._resetCache();
  const sbGet = async (table, query) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', daily_budget: 30 }];
    if (table === 'brand_voice_anchors') {
      return [
        {
          anchor: {
            tone_descriptors: 'warm, direct',
            audience_summary: 'busy professionals 25-40',
            never_say: ['hustle', 'grind', 'leverage'],
          },
        },
      ];
    }
    return [];
  };
  const ctx = await gc.buildGroundingContext({ sbGet, businessId: 'biz1', surface: 'social_post' });
  assert.ok(ctx.brandVoice);
  assert.strictEqual(ctx.brandVoice.tone_descriptors, 'warm, direct');
  assert.ok(ctx.brandVoice.never_say.includes('hustle'));
});

// ─── toPromptBlock rendering ────────────────────────────────────────────────

test('grounding: toPromptBlock renders all sections with labels', async () => {
  gc._resetCache();
  const recent = new Date(Date.now() - 86400000).toISOString();
  const sbGet = async (table, query) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', daily_budget: 30 }];
    if (table === 'generated_content') {
      return Array.from({ length: 6 }, (_, i) => ({
        id: `c${i}`,
        business_id: 'biz1',
        status: 'published',
        published_at: recent,
        instagram_caption: `Post ${i}`,
        content_theme: 'morning',
      }));
    }
    if (table === 'customer_insights') {
      return [{ user_id: 'biz1', insight_type: 'pain_point', actionable_suggestion: 'too slow' }];
    }
    if (table === 'cross_account_patterns') {
      return [{ pattern_type: 'hook', pattern_signature: 'before_after', median_roas_lift: 1.5, confidence: 0.8 }];
    }
    if (table === 'brand_voice_anchors') {
      return [{ anchor: { tone_descriptors: 'warm', audience_summary: 'pros', never_say: ['hustle'] } }];
    }
    return [];
  };
  const ctx = await gc.buildGroundingContext({
    sbGet,
    businessId: 'biz1',
    surface: 'social_post',
    limit: 2,
  });
  const block = ctx.toPromptBlock();
  assert.match(block, /GROUNDING CONTEXT/);
  assert.match(block, /Past WINS/);
  assert.match(block, /Past LOSSES/);
  assert.match(block, /Active customer voice/);
  assert.match(block, /Cohort patterns/);
  assert.match(block, /Brand voice anchor/);
  assert.match(block, /NEVER say: hustle/);
  assert.match(block, /How to use this/);
});

test('grounding: toPromptBlock is empty string when context is empty', async () => {
  const ctx = await gc.buildGroundingContext({ sbGet: makeSbGet(), businessId: 'biz_missing', surface: 'social_post' });
  assert.strictEqual(ctx.toPromptBlock(), '');
});

// ─── Caching ────────────────────────────────────────────────────────────────

test('grounding: caches by (businessId, surface, intent) for 5 minutes', async () => {
  gc._resetCache();
  let calls = 0;
  const recent = new Date(Date.now() - 86400000).toISOString();
  const sbGet = async (table, query) => {
    calls++;
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', daily_budget: 30 }];
    return [];
  };
  await gc.buildGroundingContext({ sbGet, businessId: 'biz1', surface: 'social_post' });
  const callsAfterFirst = calls;
  // Second call with same key should hit cache
  await gc.buildGroundingContext({ sbGet, businessId: 'biz1', surface: 'social_post' });
  assert.strictEqual(calls, callsAfterFirst, 'cache hit should not re-query Supabase');
  // Different surface should miss cache
  await gc.buildGroundingContext({ sbGet, businessId: 'biz1', surface: 'ad_copy' });
  assert.ok(calls > callsAfterFirst, 'different surface should re-query');
});

test('grounding: skipCache forces re-fetch', async () => {
  gc._resetCache();
  let calls = 0;
  const sbGet = async () => {
    calls++;
    return [];
  };
  await gc.buildGroundingContext({ sbGet, businessId: 'biz1', surface: 'social_post' });
  const c1 = calls;
  await gc.buildGroundingContext({ sbGet, businessId: 'biz1', surface: 'social_post', skipCache: true });
  assert.ok(calls > c1);
});

// ─── Graceful degradation ───────────────────────────────────────────────────

test('grounding: failing sbGet does not throw — returns partial context', async () => {
  gc._resetCache();
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', daily_budget: 30 }];
    if (table === 'brand_voice_anchors') return [{ anchor: { tone_descriptors: 'warm' } }];
    // Everything else throws
    throw new Error('table not found');
  };
  const ctx = await gc.buildGroundingContext({ sbGet, businessId: 'biz1', surface: 'social_post' });
  // brandVoice survived, everything else degraded silently
  assert.ok(ctx.brandVoice);
  assert.strictEqual(ctx.wins.length, 0);
  assert.strictEqual(ctx.voc.length, 0);
  assert.strictEqual(ctx.cohort.length, 0);
});

test('grounding: budget tier bucketing is deterministic', async () => {
  gc._resetCache();
  // Just verify the cohort query uses the right tier — we test the bucket function
  // indirectly by snooping the query string
  const queries = [];
  const sbGet = async (table, query = '') => {
    queries.push({ table, query });
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', daily_budget: 75 }];
    return [];
  };
  await gc.buildGroundingContext({ sbGet, businessId: 'biz1', surface: 'ad_copy' });
  const cohortQuery = queries.find((q) => q.table === 'cross_account_patterns');
  assert.match(cohortQuery.query, /budget_tier=eq\.50/, 'daily_budget=75 should map to bucket 50');
});

// ─── Pure renderer tests ────────────────────────────────────────────────────

test('grounding: SURFACE_FIELDS includes the expected mappings', () => {
  assert.ok(gc.SURFACE_FIELDS.social_post.includes('instagram_caption'));
  assert.ok(gc.SURFACE_FIELDS.email.includes('email_subject'));
  assert.ok(gc.SURFACE_FIELDS.ad_copy.includes('google_ad_headline'));
});
