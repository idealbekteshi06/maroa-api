/*
 * services/wf1/contextBundle.js
 * ----------------------------------------------------------------------------
 * Phase 1 of the Daily Content Engine: assemble the full DailyContextBundle
 * shape the strategic prompt expects. Pulls from 6 sources:
 *
 *   1. brand memory   → learning_patterns table + businesses.brand_tone
 *   2. performance    → content_performance + content_posts + daily_stats
 *   3. cultural       → countryIntelligence + SerpAPI trending topics
 *   4. competitive    → competitor_insights (existing) + last 24h competitor ads
 *   5. audience       → contacts + generated_content comments rollup
 *   6. business       → ad_campaigns + businesses.marketing_goal + upcoming launches
 *
 * This file is the seam between the messy existing data model and the clean
 * strategic framework. Every field the prompt asks for has a fallback so we
 * never ship an empty bundle — weak context is still better than missing
 * fields (which would make the LLM hallucinate).
 *
 * Dependency injection pattern: matches services/higgsfield.js.
 * ----------------------------------------------------------------------------
 */

'use strict';

function createContextBundleBuilder({ sbGet, serpSearch, countryIntelligence, logger }) {
  // ── 1. BRAND MEMORY ────────────────────────────────────────────────────
  async function gatherBrandMemory(businessId) {
    const [winners, antis, pillarRows, brandMemoryRows] = await Promise.all([
      sbGet(
        'learning_patterns',
        `business_id=eq.${businessId}&pattern_type=eq.winning&order=lift.desc&limit=8&select=trait,lift,sample_size,metadata`
      ).catch(() => []),
      sbGet(
        'learning_patterns',
        `business_id=eq.${businessId}&pattern_type=eq.anti&order=drag.desc&limit=5&select=trait,drag,sample_size,metadata`
      ).catch(() => []),
      sbGet(
        'learning_patterns',
        `business_id=eq.${businessId}&pattern_type=eq.pillar_mix&limit=10&select=trait,metadata`
      ).catch(() => []),
      sbGet(
        'businesses',
        `id=eq.${businessId}&select=brand_tone,brand_voice_profile,content_pillars`
      ).catch(() => []),
    ]);

    const biz = brandMemoryRows[0] || {};
    const voiceProfile =
      biz.brand_voice_profile ||
      biz.brand_tone ||
      'Warm, confident, specific. Avoid jargon. Never overclaim.';

    const historicalWinners = (winners || []).map(w => {
      const meta = w.metadata || {};
      return {
        hook: meta.hook || meta.example || w.trait,
        format: meta.format || 'post',
        trait: w.trait,
        engagementLift: Number(w.lift || 0) - 1, // lift = 1.5 means +50%, so -1
      };
    });

    const antiPatterns = (antis || []).map(a => {
      const meta = a.metadata || {};
      return {
        reason: a.trait,
        example: meta.example || meta.hook || 'n/a',
      };
    });

    // Pillar mix: prefer explicit learning pattern rows, fall back to JSON on businesses.
    let pillarMixStatus = [];
    if ((pillarRows || []).length) {
      pillarMixStatus = pillarRows.map(p => {
        const meta = p.metadata || {};
        return {
          pillar: p.trait,
          target: Number(meta.target || 25),
          actual30d: Number(meta.actual30d || 0),
        };
      });
    } else if (biz.content_pillars) {
      try {
        const parsed = typeof biz.content_pillars === 'string' ? JSON.parse(biz.content_pillars) : biz.content_pillars;
        if (Array.isArray(parsed)) {
          pillarMixStatus = parsed.map(p => ({
            pillar: p.name || p.pillar,
            target: Number(p.allocation || p.target || 25),
            actual30d: 0, // unknown without historical tracking
          }));
        }
      } catch {}
    }

    return { voiceProfile, historicalWinners, antiPatterns, pillarMixStatus };
  }

  // ── 2. PERFORMANCE ─────────────────────────────────────────────────────
  async function gatherPerformance(businessId) {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const [perfRows, postRows, statsRows] = await Promise.all([
      sbGet(
        'content_performance',
        `business_id=eq.${businessId}&measured_at=gte.${encodeURIComponent(since)}&select=platform,engagement_rate,vs_account_baseline,vs_industry_benchmark`
      ).catch(() => []),
      sbGet(
        'content_posts',
        `business_id=eq.${businessId}&posted_at=gte.${encodeURIComponent(since)}&select=platform,posted_at`
      ).catch(() => []),
      sbGet(
        'daily_stats',
        `business_id=eq.${businessId}&recorded_at=gte.${encodeURIComponent(since)}&order=recorded_at.desc&limit=30&select=recorded_at,total_reach,ig_followers,fb_fan_adds`
      ).catch(() => []),
    ]);

    // Per-platform rollup over 30d
    const byPlatform = new Map();
    for (const p of postRows) {
      const rec = byPlatform.get(p.platform) || { posts: 0, sumEng: 0, sumBench: 0, n: 0 };
      rec.posts++;
      byPlatform.set(p.platform, rec);
    }
    for (const r of perfRows) {
      const rec = byPlatform.get(r.platform) || { posts: 0, sumEng: 0, sumBench: 0, n: 0 };
      rec.sumEng += Number(r.engagement_rate || 0);
      rec.sumBench += Number(r.vs_industry_benchmark || 0);
      rec.n++;
      byPlatform.set(r.platform, rec);
    }
    const last30d = [];
    for (const [platform, rec] of byPlatform.entries()) {
      last30d.push({
        platform,
        posts: rec.posts,
        avgEngagement: rec.n ? rec.sumEng / rec.n : 0,
        vsBenchmark: rec.n ? rec.sumBench / rec.n - 1 : 0,
      });
    }

    // Follower delta + engagement trend
    const stats = statsRows || [];
    const latestFollowers = stats[0]?.ig_followers || 0;
    const oldestFollowers = stats[stats.length - 1]?.ig_followers || latestFollowers;
    const followerDelta30d = latestFollowers - oldestFollowers;

    let engagementTrend = 'flat';
    if (perfRows.length >= 6) {
      const sorted = [...perfRows].sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));
      const half = Math.floor(sorted.length / 2);
      const firstAvg = sorted.slice(0, half).reduce((s, r) => s + Number(r.engagement_rate || 0), 0) / half;
      const secondAvg = sorted.slice(half).reduce((s, r) => s + Number(r.engagement_rate || 0), 0) / (sorted.length - half);
      if (secondAvg > firstAvg * 1.1) engagementTrend = 'up';
      else if (secondAvg < firstAvg * 0.9) engagementTrend = 'down';
    }

    // Saturation/fatigue: posts-per-week trending up + engagement trending down
    const postsPerWeek = postRows.length / 4.3; // 30d ≈ 4.3 weeks
    const saturationFatigueScore = Math.min(
      100,
      Math.round(
        postsPerWeek * 5 +
          (engagementTrend === 'down' ? 40 : engagementTrend === 'flat' ? 15 : 0)
      )
    );

    return {
      last30d,
      growthTrajectory: { followerDelta30d, engagementTrend },
      saturationFatigueScore,
    };
  }

  // ── 3. CULTURAL ────────────────────────────────────────────────────────
  async function gatherCultural(businessId, brandCtx, todayLocalDate) {
    // Holidays from countryIntelligence service if available
    let upcomingHolidays = [];
    let seasonalMoment;
    try {
      if (countryIntelligence && typeof countryIntelligence.getUpcomingHolidays === 'function') {
        const country = (brandCtx.primaryMarkets && brandCtx.primaryMarkets[0]) || 'XK';
        const raw = countryIntelligence.getUpcomingHolidays(country, 14) || [];
        upcomingHolidays = raw.map(h => ({
          name: h.name || h.title || 'Holiday',
          date: h.date || h.iso_date || todayLocalDate,
          type: h.type || 'cultural',
        }));
      }
      if (countryIntelligence && typeof countryIntelligence.getSeason === 'function') {
        seasonalMoment = countryIntelligence.getSeason(new Date(todayLocalDate));
      }
    } catch (e) {
      logger?.warn('/wf1/contextBundle', businessId, 'countryIntelligence unavailable', { error: e.message });
    }

    // Trending topics: SerpAPI search "<industry> trending 2026 <platform>"
    const trendingTopics = [];
    const newsCycle = [];
    try {
      const q = `${brandCtx.industry} trending ${new Date().getFullYear()} viral`;
      const hits = await serpSearch(q, 5);
      for (const hit of hits) {
        trendingTopics.push({
          platform: 'instagram_feed', // SerpAPI doesn't tell us per-platform; tag generic
          topic: hit.title,
          velocity: 5,
          relevance: 6,
        });
      }
    } catch {}

    try {
      const nq = `${brandCtx.industry} news ${brandCtx.primaryMarkets?.[0] || ''}`;
      const hits = await serpSearch(nq, 3);
      for (const h of hits) {
        newsCycle.push({
          headline: h.title,
          source: (() => { try { return new URL(h.link).hostname; } catch { return 'news'; } })(),
          relevance: 5,
        });
      }
    } catch {}

    return {
      todayLocalDate,
      upcomingHolidays,
      seasonalMoment,
      trendingTopics,
      newsCycle,
    };
  }

  // ── 4. COMPETITIVE ─────────────────────────────────────────────────────
  async function gatherCompetitive(businessId) {
    const since24h = new Date(Date.now() - 24 * 3600000).toISOString();
    const rows = await sbGet(
      'competitor_insights',
      `business_id=eq.${businessId}&recorded_at=gte.${encodeURIComponent(since24h)}&order=recorded_at.desc&limit=20&select=competitor_doing_well,gap_opportunity,content_to_steal,positioning_tip,recorded_at`
    ).catch(() => []);

    const last24h = rows.map(r => ({
      competitor: 'tracked',
      platform: 'instagram_feed',
      topic: (r.competitor_doing_well || '').slice(0, 140),
      format: 'post',
      estimatedEngagement: 0.04,
    }));
    const gapOpportunities = rows
      .map(r => r.gap_opportunity)
      .filter(Boolean)
      .slice(0, 5);
    const whiteSpace = rows
      .map(r => r.positioning_tip)
      .filter(Boolean)
      .slice(0, 5);

    return { last24h, gapOpportunities, whiteSpace };
  }

  // ── 5. AUDIENCE ────────────────────────────────────────────────────────
  async function gatherAudience(businessId) {
    const since = new Date(Date.now() - 48 * 3600000).toISOString();
    const [recentContacts, recentContent] = await Promise.all([
      sbGet(
        'contacts',
        `business_id=eq.${businessId}&created_at=gte.${encodeURIComponent(since)}&select=tags,source&limit=50`
      ).catch(() => []),
      sbGet(
        'generated_content',
        `business_id=eq.${businessId}&created_at=gte.${encodeURIComponent(since)}&select=content_theme,platform,performance_score&limit=20`
      ).catch(() => []),
    ]);

    const topComments48h = [];
    // We don't store social comments yet, so derive faint signals from recent content performance
    const themeStats = new Map();
    for (const c of recentContent) {
      if (!c.content_theme) continue;
      const stat = themeStats.get(c.content_theme) || { count: 0, sumScore: 0 };
      stat.count++;
      stat.sumScore += Number(c.performance_score || 0);
      themeStats.set(c.content_theme, stat);
    }
    for (const [topic, stat] of themeStats.entries()) {
      topComments48h.push({
        platform: 'instagram_feed',
        sentiment: stat.sumScore / stat.count / 100,
        topic,
        volume: stat.count,
      });
    }

    const dropOffSignals = [];
    if (recentContacts.length === 0) {
      dropOffSignals.push('no new contacts in 48h');
    }

    return {
      topComments48h,
      demographicShifts: undefined,
      dropOffSignals,
    };
  }

  // ── 6. BUSINESS ────────────────────────────────────────────────────────
  async function gatherBusiness(businessId) {
    const [activeCamps, bizRow] = await Promise.all([
      sbGet(
        'ad_campaigns',
        `business_id=eq.${businessId}&status=eq.active&limit=10&select=campaign_name,funnel_stage,created_at,end_date,daily_budget`
      ).catch(() => []),
      sbGet(
        'businesses',
        `id=eq.${businessId}&select=marketing_goal,sales_priorities,inventory_notes,launch_pipeline`
      ).catch(() => []),
    ]);

    const activeCampaigns = (activeCamps || []).map(c => ({
      name: c.campaign_name || 'campaign',
      funnelStage: c.funnel_stage || 'mofu',
      endsAt: c.end_date || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
    }));

    const biz = (bizRow && bizRow[0]) || {};
    let launchPipeline;
    try {
      const parsed = typeof biz.launch_pipeline === 'string' ? JSON.parse(biz.launch_pipeline) : biz.launch_pipeline;
      if (Array.isArray(parsed)) {
        launchPipeline = parsed.map(l => ({
          name: l.name || 'Upcoming',
          daysUntil: Math.max(0, Math.round((new Date(l.date).getTime() - Date.now()) / 86400000)),
        }));
      }
    } catch {}

    return {
      activeCampaigns,
      inventoryOrPromoCalendar: biz.inventory_notes || undefined,
      salesPriorities: biz.sales_priorities ? String(biz.sales_priorities).split(/[;,\n]/).map(s => s.trim()).filter(Boolean) : undefined,
      launchPipeline,
    };
  }

  /**
   * Top-level: gather everything in parallel.
   * @param {{ businessId: string, brandContext: object, todayLocalDate: string }} args
   */
  async function gatherBundle({ businessId, brandContext, todayLocalDate }) {
    const [brandMemory, performance, cultural, competitive, audience, business] = await Promise.all([
      gatherBrandMemory(businessId).catch(e => {
        logger?.warn('/wf1/contextBundle', businessId, 'brandMemory failed', { error: e.message });
        return { voiceProfile: '', historicalWinners: [], antiPatterns: [], pillarMixStatus: [] };
      }),
      gatherPerformance(businessId).catch(e => {
        logger?.warn('/wf1/contextBundle', businessId, 'performance failed', { error: e.message });
        return { last30d: [], growthTrajectory: { followerDelta30d: 0, engagementTrend: 'flat' }, saturationFatigueScore: 0 };
      }),
      gatherCultural(businessId, brandContext, todayLocalDate).catch(e => {
        logger?.warn('/wf1/contextBundle', businessId, 'cultural failed', { error: e.message });
        return { todayLocalDate, upcomingHolidays: [], trendingTopics: [], newsCycle: [] };
      }),
      gatherCompetitive(businessId).catch(e => {
        logger?.warn('/wf1/contextBundle', businessId, 'competitive failed', { error: e.message });
        return { last24h: [], gapOpportunities: [], whiteSpace: [] };
      }),
      gatherAudience(businessId).catch(e => {
        logger?.warn('/wf1/contextBundle', businessId, 'audience failed', { error: e.message });
        return { topComments48h: [], dropOffSignals: [] };
      }),
      gatherBusiness(businessId).catch(e => {
        logger?.warn('/wf1/contextBundle', businessId, 'business failed', { error: e.message });
        return { activeCampaigns: [] };
      }),
    ]);

    return { brandMemory, performance, cultural, competitive, audience, business };
  }

  return {
    gatherBundle,
    gatherBrandMemory,
    gatherPerformance,
    gatherCultural,
    gatherCompetitive,
    gatherAudience,
    gatherBusiness,
  };
}

module.exports = createContextBundleBuilder;
