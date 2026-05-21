'use strict';

/**
 * routes/analytics.js — daily snapshots, weekly reports, dashboard read.
 *
 * Carved from server.js as part of the 2026-05-13 audit P4 (server.js
 * carve-up). 3 endpoints:
 *
 *   POST /webhook/analytics-snapshot — pull today's metrics from every
 *                                       connected platform, upsert per (biz, date, platform).
 *   POST /webhook/analytics-report   — synthesize a weekly digest + email.
 *   GET  /webhook/analytics-get      — last 30 days of snapshots + latest report for dashboard.
 *
 * Exports sync runners for Inngest ops-maintenance (no fire-and-forget).
 */

async function runSnapshotForBusiness(business_id, { sbGet, sbUpsert, apiRequest, log, logError }) {
  const biz = (
    await sbGet(
      'businesses',
      `id=eq.${business_id}&select=business_name,email,facebook_page_id,meta_access_token,` +
        `linkedin_connected,linkedin_access_token,linkedin_organization_id,` +
        `twitter_connected,twitter_access_token,twitter_user_id,` +
        `tiktok_connected,tiktok_access_token`
    )
  )[0];
  if (!biz) return { ok: false, reason: 'business_not_found', saved: [] };

  const today = new Date().toISOString().slice(0, 10);
  const todayStart = `${today}T00:00:00.000Z`;
  const saved = [];

  if (biz.facebook_page_id && biz.meta_access_token) {
    try {
      const fbR = await apiRequest(
        'GET',
        `https://graph.facebook.com/v19.0/${biz.facebook_page_id}/insights` +
          `?metric=page_impressions,page_reach,page_engaged_users,page_fans_total` +
          `&period=day&access_token=${biz.meta_access_token}`,
        {}
      );
      if (fbR.status === 200) {
        const metricMap = {};
        (fbR.body.data || []).forEach((m) => {
          const v = m.values?.[m.values.length - 1]?.value || 0;
          metricMap[m.name] = typeof v === 'object' ? Object.values(v).reduce((a, b) => a + b, 0) : v;
        });
        const postsToday = (
          await sbGet('generated_content', `business_id=eq.${business_id}&published_at=gte.${todayStart}&select=id`)
        ).length;
        const snap = {
          business_id,
          snapshot_date: today,
          platform: 'facebook',
          impressions: metricMap.page_impressions || 0,
          reach: metricMap.page_reach || 0,
          engagement: metricMap.page_engaged_users || 0,
          followers_gained: metricMap.page_fans_total || 0,
          posts_published: postsToday,
        };
        await sbUpsert('analytics_snapshots', snap, 'business_id,snapshot_date,platform');
        saved.push({ platform: 'facebook', impressions: snap.impressions, reach: snap.reach });
      }
    } catch (e) {
      log('/webhook/analytics-snapshot', `Facebook failed: ${e.message}`);
      await logError(business_id, 'analytics-snapshot-facebook', e.message, {});
    }
  }

  if (biz.linkedin_connected && biz.linkedin_access_token && biz.linkedin_organization_id) {
    try {
      const orgUrn = encodeURIComponent(`urn:li:organization:${biz.linkedin_organization_id}`);
      const now = Date.now();
      const liR = await apiRequest(
        'GET',
        `https://api.linkedin.com/v2/organizationalEntityShareStatistics?q=organizationalEntity` +
          `&organizationalEntity=${orgUrn}` +
          `&timeIntervals.timeGranularityType=DAY` +
          `&timeIntervals.timeRange.start=${now - 86400000}` +
          `&timeIntervals.timeRange.end=${now}`,
        { Authorization: `Bearer ${biz.linkedin_access_token}`, 'LinkedIn-Version': '202401' }
      );
      if (liR.status === 200) {
        const el = liR.body?.elements?.[0]?.totalShareStatistics || {};
        const snap = {
          business_id,
          snapshot_date: today,
          platform: 'linkedin',
          impressions: el.impressionCount || 0,
          clicks: el.clickCount || 0,
          engagement: (el.likeCount || 0) + (el.commentCount || 0) + (el.shareCount || 0),
        };
        await sbUpsert('analytics_snapshots', snap, 'business_id,snapshot_date,platform');
        saved.push({ platform: 'linkedin', impressions: snap.impressions });
      }
    } catch (e) {
      log('/webhook/analytics-snapshot', `LinkedIn failed: ${e.message}`);
      await logError(business_id, 'analytics-snapshot-linkedin', e.message, {});
    }
  }

  if (biz.twitter_connected && biz.twitter_access_token && biz.twitter_user_id) {
    try {
      const twR = await apiRequest(
        'GET',
        `https://api.twitter.com/2/users/${biz.twitter_user_id}/tweets` +
          `?start_time=${todayStart}&tweet.fields=public_metrics&max_results=100`,
        { Authorization: `Bearer ${biz.twitter_access_token}` }
      );
      if (twR.status === 200) {
        const tweets = twR.body?.data || [];
        const snap = {
          business_id,
          snapshot_date: today,
          platform: 'twitter',
          impressions: tweets.reduce((a, t) => a + (t.public_metrics?.impression_count || 0), 0),
          engagement: tweets.reduce(
            (a, t) =>
              a +
              (t.public_metrics?.like_count || 0) +
              (t.public_metrics?.reply_count || 0) +
              (t.public_metrics?.retweet_count || 0),
            0
          ),
          clicks: tweets.reduce((a, t) => a + (t.public_metrics?.url_link_clicks || 0), 0),
          posts_published: tweets.length,
        };
        await sbUpsert('analytics_snapshots', snap, 'business_id,snapshot_date,platform');
        saved.push({ platform: 'twitter', impressions: snap.impressions });
      }
    } catch (e) {
      log('/webhook/analytics-snapshot', `Twitter failed: ${e.message}`);
      await logError(business_id, 'analytics-snapshot-twitter', e.message, {});
    }
  }

  if (biz.tiktok_connected && biz.tiktok_access_token) {
    try {
      const ttR = await apiRequest(
        'GET',
        `https://business-api.tiktok.com/open_api/v1.3/business/get/?business_id=${business_id}`,
        { 'Access-Token': biz.tiktok_access_token }
      );
      if (ttR.status === 200 && ttR.body?.data) {
        const m = ttR.body.data;
        const snap = {
          business_id,
          snapshot_date: today,
          platform: 'tiktok',
          impressions: m.profile_views || 0,
          followers_gained: m.follower_count || 0,
          engagement: m.likes_count || 0,
        };
        await sbUpsert('analytics_snapshots', snap, 'business_id,snapshot_date,platform');
        saved.push({ platform: 'tiktok', impressions: snap.impressions });
      }
    } catch (e) {
      log('/webhook/analytics-snapshot', `TikTok failed: ${e.message}`);
      await logError(business_id, 'analytics-snapshot-tiktok', e.message, {});
    }
  }

  try {
    const emailsToday = (
      await sbGet('retention_logs', `business_id=eq.${business_id}&sent_at=gte.${todayStart}&select=id`)
    ).length;
    if (emailsToday > 0) {
      const snap = { business_id, snapshot_date: today, platform: 'email', email_sent: emailsToday };
      await sbUpsert('analytics_snapshots', snap, 'business_id,snapshot_date,platform');
      saved.push({ platform: 'email', email_sent: emailsToday });
    }
  } catch {
    /* retention_logs may be empty */
  }

  log('/webhook/analytics-snapshot', `✅ ${saved.length} snapshots for ${business_id}`);
  return { ok: true, saved };
}

async function runReportForBusiness(business_id, { sbGet, sbPost, callClaude, sendEmail, log, logError }) {
  const biz = (await sbGet('businesses', `id=eq.${business_id}&select=business_name,email,industry,first_name`))[0];
  if (!biz?.email) return { ok: false, reason: 'business_or_email_missing' };

  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const snapshots = await sbGet(
    'analytics_snapshots',
    `business_id=eq.${business_id}&snapshot_date=gte.${weekAgo}&order=snapshot_date.desc`
  );

  const totals = {
    impressions: 0,
    reach: 0,
    engagement: 0,
    clicks: 0,
    posts_published: 0,
    email_sent: 0,
    email_opens: 0,
    email_clicks: 0,
    followers_gained: 0,
  };
  const byPlatform = {};
  for (const s of snapshots) {
    for (const k of Object.keys(totals)) totals[k] += s[k] || 0;
    if (!byPlatform[s.platform]) byPlatform[s.platform] = {};
    for (const k of Object.keys(totals)) byPlatform[s.platform][k] = (byPlatform[s.platform][k] || 0) + (s[k] || 0);
  }

  const contentThisWeek = (
    await sbGet(
      'generated_content',
      `business_id=eq.${business_id}&created_at=gte.${weekAgo}T00:00:00.000Z&select=id`
    )
  ).length;
  const campaigns = await sbGet('ad_campaigns', `business_id=eq.${business_id}&select=status`);
  const activeCampaigns = campaigns.filter((c) => c.status === 'ACTIVE' || c.status === 'active').length;
  const aggData = {
    ...totals,
    content_pieces_created: contentThisWeek,
    active_campaigns: activeCampaigns,
    by_platform: byPlatform,
  };

  const makePrompt = (strict = false) =>
    strict
      ? `Return a raw JSON object ONLY. Keys: headline, wins (3 strings), concerns (1-2), recommendations (3), overall_score (1-10). Business: ${biz.business_name}. Data: ${JSON.stringify(aggData)}`
      : `Marketing analyst weekly report for ${biz.business_name} (${biz.industry}). Data: ${JSON.stringify(aggData, null, 2)}
Return ONLY JSON: { "headline": "...", "wins": ["..."], "concerns": ["..."], "recommendations": ["..."], "overall_score": 7 }`;

  let report = await callClaude(makePrompt(false), 'monthly_review', 1000);
  if (report._raw) report = await callClaude(makePrompt(true), 'monthly_review', 800);

  const dbReport = await sbPost('analytics_reports', {
    business_id,
    week_start: weekAgo,
    headline: report.headline || 'Weekly marketing performance complete',
    wins: report.wins || [],
    concerns: report.concerns || [],
    recommendations: report.recommendations || [],
    overall_score: report.overall_score || null,
    raw_data: aggData,
  });

  const scoreColor =
    (report.overall_score || 5) >= 7 ? '#22c55e' : (report.overall_score || 5) >= 4 ? '#f59e0b' : '#ef4444';
  const emailHtml = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
  <h2 style="color:#667eea">📊 Weekly Marketing Report</h2>
  <p style="color:#64748b">${biz.business_name}</p>
  <p style="font-size:17px;border-left:4px solid #667eea;padding-left:12px">${report.headline || ''}</p>
  <div style="background:#f8fafc;border-radius:12px;padding:24px;text-align:center">
    <div style="font-size:64px;font-weight:bold;color:${scoreColor}">${report.overall_score ?? '—'}</div>
    <div style="color:#94a3b8">/ 10 overall score</div>
  </div>
  <h3 style="color:#22c55e">🏆 Wins</h3>
  <ul>${(report.wins || []).map((w) => `<li>${w}</li>`).join('')}</ul>
  <h3 style="color:#f59e0b">⚠️ Watch</h3>
  <ul>${(report.concerns || []).map((c) => `<li>${c}</li>`).join('')}</ul>
  <h3 style="color:#667eea">🎯 Next week</h3>
  <ul>${(report.recommendations || []).map((r) => `<li>${r}</li>`).join('')}</ul>
</div>`;

  await sendEmail(biz.email, `Your weekly marketing report — ${biz.business_name}`, emailHtml);
  log('/webhook/analytics-report', `✅ Report ${dbReport?.id} — score ${report.overall_score}`);
  return { ok: true, report_id: dbReport?.id, overall_score: report.overall_score };
}

function register({
  app,
  sbGet,
  sbPost,
  sbUpsert,
  callClaude,
  apiRequest,
  sendEmail,
  log,
  logError,
}) {
  const deps = { sbGet, sbPost, sbUpsert, callClaude, apiRequest, sendEmail, log, logError };

  app.post('/webhook/analytics-snapshot', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    try {
      const r = await runSnapshotForBusiness(business_id, deps);
      res.json(r);
    } catch (err) {
      await logError(business_id, 'analytics-snapshot', err.message, req.body);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/webhook/analytics-report', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    try {
      const r = await runReportForBusiness(business_id, deps);
      res.json(r);
    } catch (err) {
      await logError(business_id, 'analytics-report', err.message, req.body);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/webhook/analytics-get', async (req, res) => {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const [snapshots, reports] = await Promise.all([
        sbGet(
          'analytics_snapshots',
          `business_id=eq.${business_id}&snapshot_date=gte.${thirtyDaysAgo}&order=snapshot_date.asc`
        ),
        sbGet('analytics_reports', `business_id=eq.${business_id}&order=created_at.desc&limit=1`),
      ]);
      const totals = snapshots.reduce(
        (acc, s) => {
          acc.impressions += s.impressions || 0;
          acc.reach += s.reach || 0;
          acc.engagement += s.engagement || 0;
          acc.posts_published += s.posts_published || 0;
          return acc;
        },
        { impressions: 0, reach: 0, engagement: 0, posts_published: 0 }
      );
      res.json({ snapshots, latest_report: reports[0] || null, totals, days: 30 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { register, runSnapshotForBusiness, runReportForBusiness };
