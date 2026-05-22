'use strict';

/**
 * services/monthly-report/index.js
 * Growth+ monthly analytics narrative using Anthropic Code Execution (20260120).
 * Claude analyzes Meta/Google performance CSV in-sandbox — charts + executive summary.
 */

const { callMarketingClaude } = require('../../lib/marketingClaude');

function buildDataBundle({ snapshots = [], campaigns = [], perfLogs = [] }) {
  const lines = ['date,reach,viewers,impressions,engagement,clicks'];
  for (const s of snapshots) {
    lines.push(
      [
        s.snapshot_date,
        s.reach || 0,
        s.viewers || '',
        s.impressions || 0,
        s.engagement || 0,
        s.clicks || 0,
      ].join(',')
    );
  }
  return {
    analytics_csv: lines.join('\n'),
    campaigns_json: JSON.stringify(
      (campaigns || []).slice(0, 30).map((c) => ({
        name: c.campaign_name,
        status: c.status,
        daily_budget: c.daily_budget,
        last_decision: c.last_decision,
      })),
      null,
      0
    ),
    perf_json: JSON.stringify((perfLogs || []).slice(0, 50), null, 0).slice(0, 8000),
  };
}

function createMonthlyReportService({ sbGet, callClaude, logger }) {
  async function generate({ businessId, month }) {
    const [bizRows, snaps, camps, perf] = await Promise.all([
      sbGet('businesses', `id=eq.${encodeURIComponent(businessId)}&select=*`).catch(() => []),
      sbGet(
        'analytics_snapshots',
        `business_id=eq.${encodeURIComponent(businessId)}&order=snapshot_date.desc&limit=90&select=*`
      ).catch(() => []),
      sbGet(
        'ad_campaigns',
        `business_id=eq.${encodeURIComponent(businessId)}&select=campaign_name,status,daily_budget,last_decision,last_decision_reason&limit=40`
      ).catch(() => []),
      sbGet(
        'ad_performance_logs',
        `business_id=eq.${encodeURIComponent(businessId)}&order=logged_at.desc&limit=60&select=campaign_id,spend,ctr,roas,conversions,logged_at`
      ).catch(() => []),
    ]);
    const business = bizRows[0];
    if (!business) return { ok: false, reason: 'business_not_found' };

    const plan = String(business.plan || 'starter').toLowerCase();
    if (!['growth', 'agency'].includes(plan)) {
      return { ok: false, reason: 'plan_upgrade_required' };
    }

    const bundle = buildDataBundle({ snapshots: snaps, campaigns: camps, perfLogs: perf });
    const system = [
      'You are Maroa.ai analytics lead. Use the code_execution tool to analyze the CSV,',
      'compute week-over-week trends, and describe 2 chart ideas (reach/viewers, ROAS).',
      'Return JSON: { executive_summary, chart_descriptions[], recommendations[], risks[] }.',
      'Never invent numbers not derivable from the data.',
    ].join(' ');

    const user = [
      `Monthly report for ${business.business_name} (${month || 'latest 90d'}).`,
      'ANALYTICS_CSV:',
      '```csv',
      bundle.analytics_csv,
      '```',
      'CAMPAIGNS:',
      bundle.campaigns_json,
      'PERF_SAMPLE:',
      bundle.perf_json,
    ].join('\n\n');

    const raw = await callMarketingClaude({
      callClaude,
      sbGet,
      logger,
      system,
      user,
      task: 'strategy',
      planTier: plan,
      businessId,
      skill: 'monthly_report_code_exec',
      max_tokens: plan === 'agency' ? 12000 : 6000,
      webSearch: false,
      cacheSystem: true,
      returnRaw: true,
      extra: {
        codeExecution: { version: 'code_execution_20260120' },
      },
    });

    return {
      ok: true,
      business_id: businessId,
      plan,
      month: month || new Date().toISOString().slice(0, 7),
      report: typeof raw === 'string' ? raw : raw,
      generated_at: new Date().toISOString(),
    };
  }

  return { generate, buildDataBundle };
}

module.exports = { createMonthlyReportService };
