/*
 * services/wf5/index.js — Competitor Intelligence engine
 */

'use strict';

const { buildCompetitorAnalysisPrompt } = require('../prompts/workflow_5_competitors.js');
const { buildBrandContext } = require('../wf1/brandContext.js');

function createWf5(deps) {
  const { sbGet, sbPost, callClaude, extractJSON, serpSearch, logger } = deps;

  async function resolveBrandContext(businessId) {
    const [b, p] = await Promise.all([
      sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
    ]);
    if (!b[0]) throw new Error('Business not found');
    return buildBrandContext({ business: b[0], profile: p[0] || {} });
  }

  async function gatherBundle(businessId) {
    const insights = await sbGet(
      'competitor_insights',
      `business_id=eq.${businessId}&order=recorded_at.desc&limit=15&select=*`
    ).catch(() => []);

    const competitors = {};
    for (const row of insights) {
      const name = row.competitor_name || 'tracked';
      if (!competitors[name]) competitors[name] = { name, posts: [], ads: [], pricing: 'unchanged', sentiment: 'flat' };
      if (row.competitor_doing_well) competitors[name].posts.push({ title: row.competitor_doing_well, engagement: 0 });
    }

    // Optional SerpAPI news
    let newsCycle = [];
    try {
      if (serpSearch) {
        const hits = await serpSearch(`${Object.keys(competitors).slice(0, 3).join(' ')} marketing`, 3);
        newsCycle = hits.map(h => ({ headline: h.title, source: (() => { try { return new URL(h.link).hostname; } catch { return 'news'; } })() }));
      }
    } catch {}

    return {
      competitors: Object.values(competitors),
      newsCycle,
      ourPosts: 0,
      ourSpend: 0,
      ourPipeline: 'stable',
    };
  }

  async function runAnalysis({ businessId, force = false }) {
    const brandContext = await resolveBrandContext(businessId);
    const now = new Date();
    const dow = (now.getDay() + 6) % 7;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - dow);
    weekStart.setHours(0, 0, 0, 0);
    const weekStartStr = weekStart.toISOString().slice(0, 10);
    const weekEnd = new Date(weekStart.getTime() + 6 * 86400000).toISOString().slice(0, 10);

    const existing = await sbGet('competitor_briefs', `business_id=eq.${businessId}&week_start=eq.${weekStartStr}&select=id`).catch(() => []);
    if (existing[0] && !force) return { briefId: existing[0].id, reused: true };

    const bundle = await gatherBundle(businessId);
    const { system, user } = buildCompetitorAnalysisPrompt(brandContext, bundle);
    const raw = await callClaude(user, 'claude-opus-4-5', 3000, { system, businessId, returnRaw: true });
    const parsed = extractJSON(raw) || {};

    const row = await sbPost('competitor_briefs', {
      business_id: businessId,
      week_start: weekStartStr,
      week_end: weekEnd,
      summary: parsed.summary || '',
      competitors: parsed.competitors || [],
      market_shifts: parsed.market_shifts || [],
      white_space: parsed.white_space_opportunities || [],
      actions: parsed.recommended_actions || [],
      frameworks_cited: parsed.frameworks_cited || [],
      model_used: 'claude-opus-4-5',
    });

    await sbPost('events', {
      business_id: businessId,
      kind: 'wf5.brief.generated',
      workflow: '5_competitor_intelligence',
      payload: { brief_id: row.id, threat_count: (parsed.competitors || []).filter(c => c.threat_level === 'high' || c.threat_level === 'critical').length },
      severity: 'info',
    }).catch(() => {});

    return { briefId: row.id, ...parsed };
  }

  async function getLatest(businessId) {
    const rows = await sbGet('competitor_briefs', `business_id=eq.${businessId}&order=week_start.desc&limit=1&select=*`).catch(() => []);
    return rows[0] || null;
  }

  return { runAnalysis, getLatest, gatherBundle, resolveBrandContext };
}

module.exports = createWf5;
