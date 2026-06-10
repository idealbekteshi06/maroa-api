'use strict';

/**
 * services/ops-maintenance/index.js
 * ---------------------------------------------------------------------------
 * Curated legacy-ops layer — replaces scattered n8n crons with a small set
 * of durable Inngest schedules. One fan-out per cadence, plan-gated, sync
 * (returns real counts for observability).
 *
 * Schedules (Inngest):
 *   06:00 UTC daily  — analytics snapshots (growth+)
 *   07:30 UTC daily  — crisis health sweep (all paid active)
 *   05:30 UTC Sun    — brand memory + weekly strategy (growth+)
 *   08:00 UTC 1st    — monthly analytics report email (growth+)
 *   09:00 UTC Mon    — growth-engine lever pick (growth+)
 *
 * Manual webhooks still exist on server.js for one-off triggers; Inngest uses
 * /webhook/ops-*-all via internalDispatcher.
 * ---------------------------------------------------------------------------
 */

const PAID_PLANS = new Set(['starter', 'growth', 'agency']);
const GROWTH_PLUS_PLANS = new Set(['growth', 'agency']);

function normalizePlan(plan) {
  const p = String(plan || 'starter').toLowerCase();
  if (p === 'free' || p === 'trial') return 'starter';
  return p;
}

function isPaidActive(biz) {
  if (!biz?.id || biz.is_active === false) return false;
  return PAID_PLANS.has(normalizePlan(biz.plan));
}

function isGrowthPlus(biz) {
  return isPaidActive(biz) && GROWTH_PLUS_PLANS.has(normalizePlan(biz.plan));
}

/** Deterministic crisis signals — unit-testable, no LLM. */
function detectCrisisSignals({ thisWeekSnaps, lastWeekSnaps, campaigns, errors, reviews }) {
  const { sumAudienceMetric } = require('../../lib/metaMetrics');
  const thisReach = sumAudienceMetric(thisWeekSnaps, 'reach');
  const lastReach = sumAudienceMetric(lastWeekSnaps, 'reach');
  const reachDrop = lastReach > 0 ? ((thisReach - lastReach) / lastReach) * 100 : 0;
  const negativeReviews = (reviews || []).filter((r) => (r.rating || 5) <= 2).length;
  const wastedSpend = (campaigns || []).filter((c) => (c.total_spend || 0) > 20 && (c.conversions || 0) === 0);

  const signals = [];
  if (reachDrop < -50)
    signals.push({ type: 'audience_collapse', detail: `Audience dropped ${reachDrop.toFixed(0)}% vs last week` });
  if (negativeReviews >= 3)
    signals.push({ type: 'negative_sentiment', detail: `${negativeReviews} negative reviews recently` });
  if ((errors || []).length >= 5)
    signals.push({ type: 'high_error_rate', detail: `${errors.length} unresolved system errors` });
  if (wastedSpend.length > 0)
    signals.push({
      type: 'wasted_spend',
      detail: `${wastedSpend.length} campaigns spending with 0 conversions`,
    });

  return { signals, thisReach, lastReach, reachDrop, wastedSpend, audience_metric: 'viewers_or_reach' };
}

async function runCrisisCheckForBusiness({ businessId, deps }) {
  const { sbGet, sbPatch, callClaude, sendEmail, log, logError, apiRequest, selfBaseUrl } = deps;

  const [bizArr, thisWeekSnaps, lastWeekSnaps, campaigns, errors, reviews] = await Promise.all([
    sbGet('businesses', `id=eq.${businessId}&select=business_name,email,crisis_status`),
    sbGet('analytics_snapshots', `business_id=eq.${businessId}&order=snapshot_date.desc&limit=7`),
    sbGet('analytics_snapshots', `business_id=eq.${businessId}&order=snapshot_date.desc&offset=7&limit=7`),
    sbGet('ad_campaigns', `business_id=eq.${businessId}&status=eq.active`),
    sbGet('errors', `business_id=eq.${businessId}&resolved=eq.false`).catch(() => []),
    sbGet('reviews', `business_id=eq.${businessId}&order=created_at.desc&limit=10`).catch(() => []),
  ]);
  const biz = bizArr?.[0];
  if (!biz) return { ok: false, reason: 'business_not_found' };

  const { signals, thisReach, lastReach, reachDrop, wastedSpend } = detectCrisisSignals({
    thisWeekSnaps,
    lastWeekSnaps,
    campaigns,
    errors,
    reviews,
  });

  if (!signals.length) {
    await sbPatch('businesses', `id=eq.${businessId}`, { crisis_status: 'healthy' });
    return { ok: true, crisis: false, status: 'healthy' };
  }

  const prompt = `CRISIS DETECTED for ${biz.business_name}.

SIGNALS:
${signals.map((s) => `- [${s.type}] ${s.detail}`).join('\n')}

CURRENT STATE:
- This week reach: ${thisReach} | Last week: ${lastReach} (${reachDrop.toFixed(0)}% change)
- Active campaigns: ${campaigns.length} | Wasted spend campaigns: ${wastedSpend.length}
- System errors: ${errors.length} | Negative reviews: ${reviews.filter((r) => (r.rating || 5) <= 2).length}

Diagnose the crisis and create an immediate response plan.
Return ONLY valid JSON:
{
  "crisis_level": "warning" | "critical" | "emergency",
  "diagnosis": "what happened and why",
  "immediate_action": "what to do RIGHT NOW",
  "recovery_plan": [{ "timeframe": "0-6h/6-24h/24-48h", "action": "string" }],
  "campaigns_to_pause": [],
  "emergency_content_needed": true/false,
  "alert_message": "message for business owner"
}`;

  const response = await callClaude(prompt, 'strategy', 1500);
  const level = response.crisis_level || 'warning';
  await sbPatch('businesses', `id=eq.${businessId}`, { crisis_status: level });

  for (const wc of wastedSpend) {
    await sbPatch('ad_campaigns', `id=eq.${wc.id}`, {
      status: 'paused',
      paused_reason: 'Crisis auto-pause: wasted spend',
    }).catch(() => {});
  }

  if (biz.email) {
    const html = `<h2>⚠️ Marketing Crisis Detected — ${biz.business_name}</h2>
<p><strong>Level:</strong> ${level.toUpperCase()}</p>
<p><strong>Diagnosis:</strong> ${response.diagnosis || ''}</p>
<p><strong>Immediate action:</strong> ${response.immediate_action || ''}</p>
<h3>Recovery Plan:</h3>
<ul>${(response.recovery_plan || []).map((s) => `<li><strong>${s.timeframe}:</strong> ${s.action}</li>`).join('')}</ul>
<p><a href="https://maroa.ai/dashboard" style="background:#e53e3e;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">View Dashboard</a></p>`;
    await sendEmail(biz.email, `⚠️ CRISIS: ${level} — ${biz.business_name}`, html).catch(() => {});
  }

  if (response.emergency_content_needed && selfBaseUrl) {
    apiRequest(
      'POST',
      `${selfBaseUrl}/webhook/instant-content`,
      { 'Content-Type': 'application/json' },
      {
        business_id: businessId,
      }
    ).catch(() => {});
  }

  log?.('ops-maintenance/crisis', `⚠️ ${level} for ${biz.business_name}: ${response.diagnosis}`);
  return { ok: true, crisis: true, status: level, signals: signals.length };
}

async function runWeeklyStrategyForBusiness({ businessId, deps }) {
  const { sbGet, sbPatch, sbPost, callClaude, log, logError, storeInsight } = deps;

  const [bizArr, snapshots, contentArr, compArr] = await Promise.all([
    sbGet('businesses', `id=eq.${businessId}&select=*`),
    sbGet('analytics_snapshots', `business_id=eq.${businessId}&order=snapshot_date.desc&limit=14`),
    sbGet(
      'generated_content',
      `business_id=eq.${businessId}&order=created_at.desc&limit=20&select=content_theme,status,performance_score`
    ),
    sbGet('competitor_reports', `business_id=eq.${businessId}&order=created_at.desc&limit=1`),
  ]);
  const biz = bizArr?.[0];
  if (!biz) return { ok: false, reason: 'business_not_found' };

  const week1 = snapshots.slice(0, 7);
  const week2 = snapshots.slice(7, 14);
  const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
  const thisWeek = { reach: sum(week1, 'reach'), clicks: sum(week1, 'clicks'), engagement: sum(week1, 'engagement') };
  const lastWeek = { reach: sum(week2, 'reach'), clicks: sum(week2, 'clicks'), engagement: sum(week2, 'engagement') };

  const topContent = contentArr
    .filter((c) => (c.performance_score || 0) >= 7)
    .map((c) => c.content_theme)
    .filter(Boolean);
  const lowContent = contentArr
    .filter((c) => (c.performance_score || 0) > 0 && (c.performance_score || 0) < 4)
    .map((c) => c.content_theme)
    .filter(Boolean);

  const prompt = `You are the chief marketing strategist AI for ${biz.business_name} (${biz.industry || 'general'}).

CURRENT STRATEGY: ${biz.marketing_strategy || 'No strategy set yet'}
CURRENT BEST THEMES: ${biz.best_performing_themes || '[]'}
CURRENT WORST THEMES: ${biz.worst_performing_themes || '[]'}

THIS WEEK: reach ${thisWeek.reach}, clicks ${thisWeek.clicks}, engagement ${thisWeek.engagement}
LAST WEEK: reach ${lastWeek.reach}, clicks ${lastWeek.clicks}, engagement ${lastWeek.engagement}
HIGH THEMES: ${topContent.join(', ') || 'none'}
LOW THEMES: ${lowContent.join(', ') || 'none'}
COMPETITOR: ${compArr[0]?.recommendation || 'No data'}

Return ONLY valid JSON:
{
  "marketing_strategy": "full evolved strategy paragraph",
  "best_performing_themes": ["theme1"],
  "worst_performing_themes": ["theme1"],
  "audience_insights": "string",
  "weekly_forecast": { "expected_reach_change": "+15%", "content_focus": "string", "risk_level": "low" },
  "key_changes": ["change 1"]
}`;

  const result = await callClaude(prompt, 'strategy', 2000);
  const updates = { strategy_updated_at: new Date().toISOString() };
  if (result.marketing_strategy) updates.marketing_strategy = result.marketing_strategy;
  if (result.best_performing_themes) updates.best_performing_themes = JSON.stringify(result.best_performing_themes);
  if (result.worst_performing_themes) updates.worst_performing_themes = JSON.stringify(result.worst_performing_themes);
  if (result.weekly_forecast) updates.weekly_forecast = JSON.stringify(result.weekly_forecast);
  await sbPatch('businesses', `id=eq.${businessId}`, updates);

  await sbPost('learning_logs', {
    business_id: businessId,
    decision_date: new Date().toISOString(),
    decision_data: JSON.stringify(result),
    actions_taken: JSON.stringify(result.key_changes || []),
    performance_before: JSON.stringify({ thisWeek, lastWeek }),
  }).catch(() => {});

  if (storeInsight) {
    try {
      storeInsight(
        businessId,
        'strategy',
        'content_strategy',
        'content_themes',
        (result.best_performing_themes || []).join(', ')
      );
    } catch {
      /* soft-fail */
    }
  }

  log?.('ops-maintenance/weekly-strategy', `✅ Strategy evolved for ${biz.business_name}`);
  return { ok: true, evolved: true };
}

async function runGrowthEngineForBusiness({ businessId, deps }) {
  const { sbGet, sbPatch, callClaude, log } = deps;

  const [bizArr, snapshots, campaigns, contacts, revenue, content] = await Promise.all([
    sbGet('businesses', `id=eq.${businessId}&select=*`),
    sbGet('analytics_snapshots', `business_id=eq.${businessId}&order=snapshot_date.desc&limit=30`),
    sbGet('ad_campaigns', `business_id=eq.${businessId}&select=status,daily_budget,roas,total_spend`),
    sbGet('contacts', `business_id=eq.${businessId}&select=id,lead_score,intent_level`),
    sbGet('revenue_attribution', `business_id=eq.${businessId}&select=amount,source`).catch(() => []),
    sbGet(
      'generated_content',
      `business_id=eq.${businessId}&order=created_at.desc&limit=10&select=status,performance_score`
    ),
  ]);
  const biz = bizArr?.[0];
  if (!biz) return { ok: false, reason: 'business_not_found' };

  const totalReach = snapshots.reduce((s, r) => s + (r.reach || 0), 0);
  const totalRevenue = revenue.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const activeCamps = campaigns.filter((c) => c.status === 'active').length;
  const hotLeads = contacts.filter((c) => c.intent_level === 'hot' || c.intent_level === 'ready_to_buy').length;
  const avgContent =
    content.length > 0
      ? (content.reduce((s, c) => s + (c.performance_score || 0), 0) / content.length).toFixed(1)
      : '0';

  const prompt = `Growth strategist for ${biz.business_name} (${biz.industry || 'business'}).
Plan: ${biz.plan || 'starter'} | Goal: ${biz.marketing_goal || 'grow'}
30d reach: ${totalReach} | Revenue: $${totalRevenue.toFixed(2)} | Active campaigns: ${activeCamps}
Hot leads: ${hotLeads} | Contacts: ${contacts.length} | Avg content score: ${avgContent}/10

Pick THE SINGLE HIGHEST LEVERAGE action. Return ONLY valid JSON:
{
  "growth_levers": [{ "lever": "string", "impact_score": 1, "feasibility": 1, "cost": 1, "final_score": 0, "why": "string" }],
  "recommended_action": { "lever": "string", "specific_plan": "string", "expected_outcome": "string", "kpi_to_track": "string", "timeline": "string" },
  "growth_trajectory": "string",
  "bottleneck": "string"
}`;

  const result = await callClaude(prompt, 'strategy', 2000);
  let prior = {};
  try {
    prior = JSON.parse(biz.ai_brain_decisions || '{}');
  } catch {
    prior = {};
  }
  await sbPatch('businesses', `id=eq.${businessId}`, {
    growth_engine_recommendation: JSON.stringify(result),
    ai_brain_decisions: JSON.stringify({ ...prior, growth_engine: result, updated_at: new Date().toISOString() }),
  });

  log?.(
    'ops-maintenance/growth-engine',
    `✅ Lever for ${biz.business_name}: ${result.recommended_action?.lever || 'n/a'}`
  );
  return { ok: true, lever: result.recommended_action?.lever || null };
}

async function runBrandMemoryTrainForBusiness({ businessId, deps }) {
  const { sbGet, getEmbedding, pineconeUpsert, openaiConfigured, pineconeConfigured } = deps;

  if (!openaiConfigured || !pineconeConfigured) {
    return { ok: true, trained_on: 0, stored: 0, skipped: true, reason: 'brand_memory_not_configured' };
  }

  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const pieces = await sbGet(
    'generated_content',
    `business_id=eq.${businessId}&status=eq.published&published_at=gte.${since}&select=id,instagram_caption,facebook_post,email_body,blog_title,content_theme,performance_score`
  );

  if (!pieces.length) return { ok: true, trained_on: 0, stored: 0, reason: 'no_published_content' };

  let stored = 0;
  for (const p of pieces) {
    const score = Math.min(10, Math.max(0, Number(p.performance_score) || 0));
    if (score < 7) continue;

    const candidates = [
      { type: 'social_post', text: p.instagram_caption || p.facebook_post },
      { type: 'email', text: p.email_body },
      { type: 'blog', text: p.blog_title },
    ].filter((c) => c.text && c.text.length > 20);

    for (const c of candidates) {
      try {
        const vector = await getEmbedding(c.text);
        await pineconeUpsert([
          {
            id: `${businessId}-${p.id}-${c.type}`,
            values: vector,
            metadata: {
              businessId,
              contentType: c.type,
              performance_score: score,
              text: c.text.slice(0, 500),
              theme: p.content_theme || '',
            },
          },
        ]);
        stored += 1;
      } catch {
        /* per-vector soft-fail */
      }
    }
  }

  return { ok: true, trained_on: pieces.length, stored };
}

async function listActiveBusinesses(sbGet, { growthPlusOnly = false } = {}) {
  const rows = await sbGet('businesses', 'is_active=eq.true&select=id,plan&limit=1000').catch(() => []);
  return rows.filter((b) => (growthPlusOnly ? isGrowthPlus(b) : isPaidActive(b)));
}

async function fanOut({ sbGet, logger, label, growthPlusOnly, perBusiness }) {
  const businesses = await listActiveBusinesses(sbGet, { growthPlusOnly });
  let processed = 0;
  let ok = 0;
  let crises = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  for (const b of businesses) {
    processed += 1;
    try {
      const r = await perBusiness(b.id);
      if (r?.ok) {
        ok += 1;
        if (r.crisis) crises += 1;
        if (r.skipped) skipped += 1;
      } else {
        // Per-business soft failure (returned ok:false rather than throwing).
        failed += 1;
        if (r?.reason) errors.push({ business_id: b.id, error: r.reason });
      }
    } catch (e) {
      failed += 1;
      errors.push({ business_id: b.id, error: e.message });
      logger?.warn?.(`ops-maintenance/${label}`, b.id, e.message);
    }
  }

  // G-9: a fan-out where EVERY business failed is a systemic outage (rotated
  // key, schema drift) — surface it as ok:false so the Inngest cron retries,
  // hits the DLQ, and fires the Slack alert. A partial failure (some succeed)
  // stays ok:true; per-business errors are already isolated above.
  return {
    ok: !(failed === processed && processed > 0),
    businesses: businesses.length,
    processed,
    succeeded: ok,
    failed,
    total: processed,
    crises,
    skipped,
    errors: errors.slice(0, 20),
  };
}

async function runDailyHealthAll(deps) {
  return fanOut({
    sbGet: deps.sbGet,
    logger: deps.logger,
    label: 'daily-health',
    growthPlusOnly: false,
    perBusiness: (id) => runCrisisCheckForBusiness({ businessId: id, deps }),
  });
}

async function runWeeklyMaintenanceAll(deps) {
  const base = await fanOut({
    sbGet: deps.sbGet,
    logger: deps.logger,
    label: 'weekly-maintenance',
    growthPlusOnly: true,
    perBusiness: async (id) => {
      const brand = await runBrandMemoryTrainForBusiness({ businessId: id, deps });
      const strategy = await runWeeklyStrategyForBusiness({ businessId: id, deps });
      return {
        ok: brand.ok && strategy.ok,
        brand_stored: brand.stored,
        strategy_evolved: strategy.evolved,
      };
    },
  });
  return { ...base, bundle: 'weekly-maintenance' };
}

async function runGrowthEngineAll(deps) {
  return fanOut({
    sbGet: deps.sbGet,
    logger: deps.logger,
    label: 'growth-engine',
    growthPlusOnly: true,
    perBusiness: (id) => runGrowthEngineForBusiness({ businessId: id, deps }),
  });
}

async function runAnalyticsSnapshotsAll(deps) {
  const { runSnapshotForBusiness, sbGet } = deps;
  if (!runSnapshotForBusiness) return { ok: false, reason: 'analytics_runner_missing' };

  const { loadBusiness, checkPlatform } = require('../../lib/integrationGate');

  return fanOut({
    sbGet: deps.sbGet,
    logger: deps.logger,
    label: 'analytics-snapshots',
    growthPlusOnly: true,
    perBusiness: async (id) => {
      const biz = await loadBusiness(id, sbGet);
      if (!checkPlatform(biz, 'analytics_social')) {
        return { ok: true, skipped: true, reason: 'no_social_integration' };
      }
      const r = await runSnapshotForBusiness(id, deps);
      return { ok: true, platforms_saved: r?.saved?.length ?? 0 };
    },
  });
}

async function runMonthlyReportsAll(deps) {
  const { runReportForBusiness } = deps;
  if (!runReportForBusiness) return { ok: false, reason: 'analytics_runner_missing' };

  return fanOut({
    sbGet: deps.sbGet,
    logger: deps.logger,
    label: 'monthly-reports',
    growthPlusOnly: true,
    perBusiness: async (id) => {
      const r = await runReportForBusiness(id, deps);
      return { ok: !!r?.ok, report_id: r?.report_id };
    },
  });
}

module.exports = {
  PAID_PLANS,
  GROWTH_PLUS_PLANS,
  normalizePlan,
  isPaidActive,
  isGrowthPlus,
  detectCrisisSignals,
  runCrisisCheckForBusiness,
  runWeeklyStrategyForBusiness,
  runGrowthEngineForBusiness,
  runBrandMemoryTrainForBusiness,
  runDailyHealthAll,
  runWeeklyMaintenanceAll,
  runGrowthEngineAll,
  runAnalyticsSnapshotsAll,
  runMonthlyReportsAll,
};
