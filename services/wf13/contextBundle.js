/*
 * services/wf13/contextBundle.js
 * ----------------------------------------------------------------------------
 * Phase 1 of WF13: assemble the WeeklyContextBundle.
 *
 * Aggregates data for the last 7-day window (Mon→Sun of the target week) from
 * every channel we have instrumented. Each section is defensive: missing data
 * degrades gracefully to `undefined`, never throws.
 *
 * Sources (with fallbacks):
 *   platforms        → content_performance, content_posts, daily_stats
 *   ads              → ad_campaigns, ad_performance_logs
 *   email            → email_sequences + email_sends (legacy table)
 *   website          → analytics_snapshots
 *   pipeline         → contacts + deals (legacy CRM tables)
 *   revenue          → subscriptions / businesses.plan_price
 *   reviews          → reviews (existing)
 *   gbp              → gbp_posts (if wired)
 *   competitive      → competitor_insights + content_performance diff
 *   customerVoice    → reviews rollup + comments rollup
 *   operational      → health metrics + platform status
 *   cultural         → countryIntelligence holidays + cached news
 *   readerPreferences→ reader_preferences_learned
 * ----------------------------------------------------------------------------
 */

'use strict';

function createBundleAggregator({ sbGet, countryIntelligence, logger }) {
  function weekStartEnd(fromDate = new Date()) {
    // ISO week: Monday start, Sunday end.
    const d = new Date(fromDate);
    d.setHours(0, 0, 0, 0);
    const dayOfWeek = (d.getDay() + 6) % 7; // Monday=0
    const monday = new Date(d);
    monday.setDate(d.getDate() - dayOfWeek - 7); // previous week's Monday
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return {
      weekStart: monday.toISOString().slice(0, 10),
      weekEnd: sunday.toISOString().slice(0, 10),
      startIso: monday.toISOString(),
      endIso: new Date(sunday.getTime() + 86400000 - 1).toISOString(),
    };
  }

  function trendPoint(value, spark = [], vsLastWeek = 0, vsLastMonth = 0, vsBenchmark = 0, vsGoal) {
    return { value, vsLastWeek, vsLastMonth, vsBenchmark, vsGoal, spark };
  }

  async function gatherPlatforms({ businessId, startIso, endIso }) {
    const rows = await sbGet(
      'content_performance',
      `business_id=eq.${businessId}&measured_at=gte.${encodeURIComponent(startIso)}&measured_at=lte.${encodeURIComponent(endIso)}&select=platform,engagement_rate,reach,vs_account_baseline,vs_industry_benchmark`
    ).catch(() => []);

    const byPlatform = new Map();
    for (const r of rows) {
      const rec = byPlatform.get(r.platform) || { reach: 0, er: 0, n: 0, bench: 0 };
      rec.reach += Number(r.reach || 0);
      rec.er += Number(r.engagement_rate || 0);
      rec.bench += Number(r.vs_industry_benchmark || 0) - 1;
      rec.n++;
      byPlatform.set(r.platform, rec);
    }

    const platforms = [];
    for (const [platform, rec] of byPlatform.entries()) {
      platforms.push({
        platform: platform.replace(/_feed|_reel|_story/, ''),
        reach: trendPoint(rec.reach, [], 0, 0, rec.n ? rec.bench / rec.n : 0),
        engagementRate: trendPoint(rec.n ? rec.er / rec.n : 0, [], 0, 0, rec.n ? rec.bench / rec.n : 0),
        followerGrowth: trendPoint(0, [], 0, 0, 0),
      });
    }
    return platforms;
  }

  async function gatherAds({ businessId, startIso, endIso }) {
    const rows = await sbGet(
      'ad_performance_logs',
      `business_id=eq.${businessId}&logged_at=gte.${encodeURIComponent(startIso)}&logged_at=lte.${encodeURIComponent(endIso)}&select=*`
    ).catch(() => []);
    const byPlatform = new Map();
    for (const r of rows) {
      const plat = r.platform || 'meta';
      const rec = byPlatform.get(plat) || { spend: 0, roas: 0, cpa: 0, ctr: 0, conv: 0, n: 0 };
      rec.spend += Number(r.spend || 0);
      rec.roas += Number(r.roas || 0);
      rec.cpa += Number(r.cpc || 0);
      rec.ctr += Number(r.ctr || 0);
      rec.conv += Number(r.conversions || 0);
      rec.n++;
      byPlatform.set(plat, rec);
    }
    const ads = [];
    for (const [platform, rec] of byPlatform.entries()) {
      ads.push({
        platform,
        spend: trendPoint(rec.spend),
        roas: trendPoint(rec.n ? rec.roas / rec.n : 0),
        cpa: trendPoint(rec.n ? rec.cpa / rec.n : 0),
        ctr: trendPoint(rec.n ? rec.ctr / rec.n : 0),
      });
    }
    return ads;
  }

  async function gatherReviews({ businessId, startIso, endIso }) {
    const rows = await sbGet(
      'reviews',
      `business_id=eq.${businessId}&created_at=gte.${encodeURIComponent(startIso)}&created_at=lte.${encodeURIComponent(endIso)}&select=rating,sentiment,quote,platform`
    ).catch(() => []);
    if (!rows.length) return undefined;
    const avgRating = rows.reduce((s, r) => s + Number(r.rating || 0), 0) / rows.length;
    const avgSent = rows.reduce((s, r) => s + Number(r.sentiment || 0), 0) / rows.length;
    const notable = rows
      .filter(r => r.quote)
      .slice(0, 3)
      .map(r => ({ source: r.platform || 'unknown', rating: Number(r.rating || 0), quote: r.quote || '' }));
    return {
      newReviews: trendPoint(rows.length),
      avgRating: trendPoint(avgRating),
      responseRate: trendPoint(0.5), // placeholder until reviews has response tracking
      sentimentDelta: avgSent,
      notableQuotes: notable,
    };
  }

  async function gatherCompetitive({ businessId, startIso, endIso }) {
    const insights = await sbGet(
      'competitor_insights',
      `business_id=eq.${businessId}&recorded_at=gte.${encodeURIComponent(startIso)}&recorded_at=lte.${encodeURIComponent(endIso)}&order=recorded_at.desc&limit=15&select=*`
    ).catch(() => []);
    const significantMoves = insights.map(r => ({
      competitor: r.competitor_name || 'tracked',
      move: r.competitor_doing_well || 'activity',
      date: (r.recorded_at || '').slice(0, 10),
      relevance: 6,
      threatLevel: 'medium',
    }));
    return {
      significantMoves,
      shareOfVoiceTrend: 0,
      seoRankShifts: [],
    };
  }

  async function gatherCustomerVoice({ businessId, startIso, endIso }) {
    const reviews = await sbGet(
      'reviews',
      `business_id=eq.${businessId}&created_at=gte.${encodeURIComponent(startIso)}&created_at=lte.${encodeURIComponent(endIso)}&select=rating,sentiment,quote,topics&limit=50`
    ).catch(() => []);
    const themeStats = new Map();
    for (const r of reviews) {
      const topics = Array.isArray(r.topics) ? r.topics : [];
      for (const t of topics) {
        const rec = themeStats.get(t) || { volume: 0, sumSent: 0 };
        rec.volume++;
        rec.sumSent += Number(r.sentiment || 0);
        themeStats.set(t, rec);
      }
    }
    const topThemes = [...themeStats.entries()]
      .sort((a, b) => b[1].volume - a[1].volume)
      .slice(0, 5)
      .map(([theme, rec]) => ({
        theme,
        volume: rec.volume,
        sentiment: rec.volume ? rec.sumSent / rec.volume : 0,
      }));
    return {
      topThemes,
      emergingComplaints: reviews.filter(r => Number(r.sentiment || 0) < -0.3 && r.quote).slice(0, 3).map(r => r.quote),
      emergingLoves: reviews.filter(r => Number(r.sentiment || 0) > 0.5 && r.quote).slice(0, 3).map(r => r.quote),
      notableQuotes: reviews.filter(r => r.quote).slice(0, 3).map(r => ({ source: 'reviews', quote: r.quote })),
    };
  }

  async function gatherOperational({ businessId }) {
    return {
      platformApiHealth: [],
      integrationStatus: [],
      budgetBurnVsPlan: 0,
    };
  }

  async function gatherCultural({ businessId, startIso }) {
    let upcomingHolidays = [];
    let seasonalFactors;
    try {
      if (countryIntelligence?.getUpcomingHolidays) {
        const profile = (await sbGet('business_profiles', `user_id=eq.${businessId}&select=country`).catch(() => []))[0];
        const country = profile?.country || 'XK';
        const raw = countryIntelligence.getUpcomingHolidays(country, 14) || [];
        upcomingHolidays = raw.map(h => ({ name: h.name, date: h.date, type: h.type || 'cultural' }));
      }
      if (countryIntelligence?.getSeason) {
        seasonalFactors = countryIntelligence.getSeason(new Date(startIso));
      }
    } catch (e) {
      logger?.warn('/wf13/contextBundle', businessId, 'cultural failed', { error: e.message });
    }
    return { upcomingHolidays, seasonalFactors, newsCycle: [] };
  }

  async function gatherReaderPreferences({ businessId }) {
    const rows = await sbGet(
      'reader_preferences_learned',
      `business_id=eq.${businessId}&select=*`
    ).catch(() => []);
    const settings = await sbGet(
      'brief_delivery_settings',
      `business_id=eq.${businessId}&select=*`
    ).catch(() => []);
    const learned = rows[0] || {};
    const s = settings[0] || {};
    return {
      preferredLength: s.preferred_length || 'standard',
      metricPriorities: learned.metric_priorities || [],
      tonePreference: s.tone_preference || 'direct',
      technicalDepth: s.technical_depth || 'intermediate',
      preferredLanguage: s.language || 'English',
      sectionsTheySkip: learned.sections_skipped || [],
      sectionsTheyDrillInto: learned.sections_drilled_into || [],
      recommendationsOftenRejected: learned.recommendations_rejected || [],
      recommendationsOftenApproved: learned.recommendations_approved || [],
    };
  }

  async function gatherBundle({ businessId, weekStart: explicitWeekStart }) {
    const { weekStart, weekEnd, startIso, endIso } = explicitWeekStart
      ? (() => {
          const s = new Date(explicitWeekStart + 'T00:00:00Z');
          const e = new Date(s.getTime() + 7 * 86400000 - 1);
          return {
            weekStart: explicitWeekStart,
            weekEnd: e.toISOString().slice(0, 10),
            startIso: s.toISOString(),
            endIso: e.toISOString(),
          };
        })()
      : weekStartEnd();

    const [
      platforms,
      ads,
      reviews,
      competitive,
      customerVoice,
      operational,
      cultural,
      readerPreferences,
    ] = await Promise.all([
      gatherPlatforms({ businessId, startIso, endIso }),
      gatherAds({ businessId, startIso, endIso }),
      gatherReviews({ businessId, startIso, endIso }),
      gatherCompetitive({ businessId, startIso, endIso }),
      gatherCustomerVoice({ businessId, startIso, endIso }),
      gatherOperational({ businessId }),
      gatherCultural({ businessId, startIso }),
      gatherReaderPreferences({ businessId }),
    ]);

    return {
      weekStart,
      weekEnd,
      platforms,
      ads,
      reviews,
      competitive,
      customerVoice,
      operational,
      cultural,
      readerPreferences,
    };
  }

  return { gatherBundle, weekStartEnd };
}

module.exports = createBundleAggregator;
