/*
 * services/wf5/index.js — Competitor Intelligence engine (DEPRECATED)
 *
 * @deprecated Superseded by the canonical services/competitor-watch (firing
 * Inngest cron `competitor-watch-every-4h` + /webhook/competitor-watch-scan and
 * /webhook/competitor-watch-briefing). See CANONICAL_WORKFLOWS.md.
 * Marked-deprecated — do NOT build new features on it. The canonical engine
 * writes `competitor_signals`; wf5 writes the divergent `competitor_briefs`.
 */

'use strict';

const { buildCompetitorAnalysisPrompt } = require('../prompts/workflow_5_competitors.js');
const { buildBrandContext } = require('../wf1/brandContext.js');
const { callMarketingClaude } = require('../../lib/marketingClaude');

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
        newsCycle = hits.map((h) => ({
          headline: h.title,
          source: (() => {
            try {
              return new URL(h.link).hostname;
            } catch {
              return 'news';
            }
          })(),
        }));
      }
    } catch (e) {
      /* soft-fail — see ADR-0003 for empty-catch cleanup plan */
    }

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

    const existing = await sbGet(
      'competitor_briefs',
      `business_id=eq.${businessId}&week_start=eq.${weekStartStr}&select=id`
    ).catch(() => []);
    if (existing[0] && !force) return { briefId: existing[0].id, reused: true };

    const bundle = await gatherBundle(businessId);
    const { system, user } = buildCompetitorAnalysisPrompt(brandContext, bundle);
    const planRows = await sbGet('businesses', `id=eq.${businessId}&select=plan`).catch(() => []);
    const planTier = planRows[0]?.plan || 'starter';
    const raw = await callMarketingClaude({
      callClaude,
      sbGet,
      sbPost,
      logger,
      system,
      user,
      task: 'competitor',
      planTier,
      businessId,
      skill: 'wf5_competitor_brief',
      max_tokens: 3000,
      webSearch: 'auto',
      cacheSystem: true,
      returnRaw: true,
    });
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
      model_used: planTier === 'agency' ? 'claude-opus-4-7' : 'claude-sonnet-4-6+advisor',
    });

    await sbPost('events', {
      business_id: businessId,
      kind: 'wf5.brief.generated',
      workflow: '5_competitor_intelligence',
      payload: {
        brief_id: row.id,
        threat_count: (parsed.competitors || []).filter(
          (c) => c.threat_level === 'high' || c.threat_level === 'critical'
        ).length,
      },
      severity: 'info',
    }).catch(() => {});

    return { briefId: row.id, ...parsed };
  }

  async function getLatest(businessId) {
    const rows = await sbGet(
      'competitor_briefs',
      `business_id=eq.${businessId}&order=week_start.desc&limit=1&select=*`
    ).catch(() => []);
    return rows[0] || null;
  }

  function parseJsonField(val) {
    if (Array.isArray(val)) return val;
    if (val && typeof val === 'object') return val;
    if (typeof val === 'string') {
      try {
        return JSON.parse(val);
      } catch {
        return [];
      }
    }
    return [];
  }

  const AVATAR_COLORS = [
    'bg-primary text-primary-foreground',
    'bg-blue-500 text-white',
    'bg-emerald-500 text-white',
    'bg-violet-500 text-white',
    'bg-amber-500 text-white',
    'bg-rose-500 text-white',
  ];

  function initialsFor(name) {
    const parts = String(name || '?')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function threatToEngagement(level) {
    const map = { low: 2.5, medium: 4.2, high: 5.8, critical: 7.5 };
    return map[String(level || 'medium').toLowerCase()] ?? 4;
  }

  /** UI payload for Competitor Intelligence page — no demo rows. */
  async function getDashboard(businessId) {
    const [briefRow, bizRows, insights] = await Promise.all([
      getLatest(businessId),
      sbGet('businesses', `id=eq.${businessId}&select=business_name`).catch(() => []),
      sbGet(
        'competitor_insights',
        `business_id=eq.${businessId}&order=recorded_at.desc&limit=50&select=competitor_name,competitor_doing_well,recorded_at`
      ).catch(() => []),
    ]);
    const businessName = bizRows?.[0]?.business_name || 'Your brand';

    const briefCompetitors = briefRow ? parseJsonField(briefRow.competitors) : [];
    const whiteSpace = briefRow ? parseJsonField(briefRow.white_space) : [];

    const competitors = briefCompetitors.map((c, i) => {
      const name = c.name || `Competitor ${i + 1}`;
      const related = (insights || []).filter((r) => (r.competitor_name || '').toLowerCase() === name.toLowerCase());
      const trendUp = ['scaling', 'pivoting'].includes(String(c.posture_change || '').toLowerCase());
      const eng = threatToEngagement(c.threat_level);
      const sparkline = Array.from({ length: 12 }, (_, j) =>
        Math.max(1, eng + (trendUp ? j * 0.05 : -j * 0.03) + i * 0.1)
      );
      return {
        name,
        initials: initialsFor(name),
        color: AVATAR_COLORS[i % AVATAR_COLORS.length],
        platforms: ['website'],
        followers: '—',
        engagement: Number(eng.toFixed(1)),
        engagementTrend: trendUp ? 'up' : 'down',
        weeklyPosts: related.length || 0,
        topContent: c.key_move_this_week || c.posture_change || 'Tracked',
        sparkline,
        threat_level: c.threat_level || 'medium',
        is_you: false,
      };
    });

    const contentGaps = whiteSpace.map((w) => ({
      topic: w.opportunity || w.topic || 'Opportunity',
      description: w.why_now || w.description || '',
      competitors: briefCompetitors
        .filter((c) => c.threat_level === 'high' || c.threat_level === 'critical')
        .map((c) => c.name)
        .filter(Boolean)
        .slice(0, 3),
      opportunity: w.difficulty === 'easy' ? 'High' : w.difficulty === 'hard' ? 'Low' : 'Medium',
    }));

    return {
      has_data: competitors.length > 0,
      business_name: businessName,
      week_start: briefRow?.week_start || null,
      summary: briefRow?.summary || null,
      competitors,
      content_gaps: contentGaps,
      recommended_actions: briefRow ? parseJsonField(briefRow.actions) : [],
    };
  }

  return { runAnalysis, getLatest, getDashboard, gatherBundle, resolveBrandContext };
}

module.exports = createWf5;
