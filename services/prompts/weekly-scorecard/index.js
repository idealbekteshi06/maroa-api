'use strict';

/**
 * services/prompts/weekly-scorecard/index.js
 * ----------------------------------------------------------------------------
 * Weekly Scorecard generator. Upgrades WF17 (monthly report) into a richer
 * weekly digest with deterministic metric computation + LLM commentary.
 *
 * Sections:
 *   - Top-line numbers (this week vs last)
 *   - Best campaign (the standout positive)
 *   - Worst campaign (the standout negative)
 *   - Trend interpretation (LLM)
 *   - Top 3 actions for next week (LLM, calibrated to plan tier)
 *
 * Output is HTML email body + structured JSON (for dashboard widget).
 * ----------------------------------------------------------------------------
 */

const adI18n = require('../ad-optimizer/i18n-market');

function _sumAndAvg(rows, fields) {
  const out = {};
  if (!rows || !rows.length) return out;
  for (const f of fields.sum || []) {
    out[f] = rows.reduce((a, r) => a + Number(r?.[f] || 0), 0);
  }
  for (const f of fields.avg || []) {
    const vals = rows.map(r => Number(r?.[f])).filter(Number.isFinite);
    out[f] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  return out;
}

function _pctChange(now, prev) {
  if (!Number.isFinite(now) || !Number.isFinite(prev) || prev === 0) return null;
  return (now - prev) / prev;
}

/**
 * Build the deterministic numbers section. Always runs, no LLM.
 *
 * Inputs:
 *   thisWeekRows: ad_performance_logs from days 0-6 (sorted oldest→newest)
 *   prevWeekRows: ad_performance_logs from days 7-13
 *   campaigns:    array of {id, name, business_id} for naming
 */
function buildScorecardData({ thisWeekRows = [], prevWeekRows = [], campaigns = [] }) {
  const thisAgg = _sumAndAvg(thisWeekRows, {
    sum: ['spend', 'clicks', 'impressions', 'conversions', 'reach'],
    avg: ['roas', 'ctr', 'cpc', 'frequency', 'cpa'],
  });
  const prevAgg = _sumAndAvg(prevWeekRows, {
    sum: ['spend', 'clicks', 'impressions', 'conversions', 'reach'],
    avg: ['roas', 'ctr', 'cpc', 'frequency', 'cpa'],
  });

  // Per-campaign aggregates
  const byCampaign = new Map();
  for (const r of thisWeekRows) {
    const id = r.campaign_id;
    if (!byCampaign.has(id)) byCampaign.set(id, { campaign_id: id, spend: 0, clicks: 0, conversions: 0, roas_sum: 0, roas_n: 0 });
    const e = byCampaign.get(id);
    e.spend += Number(r.spend || 0);
    e.clicks += Number(r.clicks || 0);
    e.conversions += Number(r.conversions || 0);
    if (Number.isFinite(Number(r.roas))) { e.roas_sum += Number(r.roas); e.roas_n++; }
  }

  const campaignsRanked = [...byCampaign.values()]
    .map(c => ({
      ...c,
      roas_avg: c.roas_n ? c.roas_sum / c.roas_n : null,
      campaign_name: campaigns.find(x => x.id === c.campaign_id)?.business_name || 'Unknown',
    }))
    .sort((a, b) => (b.roas_avg || 0) - (a.roas_avg || 0));

  const best = campaignsRanked[0] || null;
  const worst = campaignsRanked[campaignsRanked.length - 1] || null;

  return {
    week: {
      spend: thisAgg.spend,
      clicks: thisAgg.clicks,
      impressions: thisAgg.impressions,
      conversions: thisAgg.conversions,
      reach: thisAgg.reach,
      roas: thisAgg.roas,
      ctr: thisAgg.ctr,
      cpc: thisAgg.cpc,
      cpa: thisAgg.cpa,
      frequency: thisAgg.frequency,
    },
    previous_week: prevAgg,
    deltas: {
      spend_pct: _pctChange(thisAgg.spend, prevAgg.spend),
      conversions_pct: _pctChange(thisAgg.conversions, prevAgg.conversions),
      roas_pct: _pctChange(thisAgg.roas, prevAgg.roas),
      ctr_pct: _pctChange(thisAgg.ctr, prevAgg.ctr),
    },
    best_campaign: best ? {
      campaign_id: best.campaign_id,
      campaign_name: best.campaign_name,
      spend: best.spend,
      conversions: best.conversions,
      roas: best.roas_avg,
    } : null,
    worst_campaign: worst && worst.campaign_id !== best?.campaign_id ? {
      campaign_id: worst.campaign_id,
      campaign_name: worst.campaign_name,
      spend: worst.spend,
      conversions: worst.conversions,
      roas: worst.roas_avg,
    } : null,
    campaigns_ranked: campaignsRanked,
    sample_quality: thisWeekRows.length >= 5 ? 'good' : thisWeekRows.length >= 2 ? 'limited' : 'insufficient',
  };
}

/**
 * Format money with locale awareness.
 */
function formatScorecardMoney(amount, currency, locale) {
  return adI18n.formatMoney(amount, currency, locale);
}

/**
 * System prompt for LLM commentary. Cacheable.
 */
function buildSystemPrompt() {
  return `# ROLE

You are Maroa.ai's weekly scorecard commentator. Given a deterministic numbers snapshot, you write 3 things:

1. **Trend interpretation** — 2-3 sentences in business primary_language. Explain what the numbers MEAN for the business owner. No jargon. No buzzwords.

2. **Top 3 actions for next week** — concrete, shippable in <2 hours each. Calibrated to plan tier:
   - Free: super basic ("post 3 times next week")
   - Growth: tactical ("scale Campaign X by 20%")
   - Agency: strategic ("test new audience for Campaign X, refresh creative for Campaign Y")

3. **Win** — one sentence celebrating the best thing that happened this week (or "Steady week — no major wins yet" if nothing).

# HARD RULES

- Numbers come pre-computed. NEVER make up numbers. Only quote ones in the deterministic snapshot.
- Output language MUST be business.primary_language.
- Currency display MUST use the provided currency_symbol + format.
- decision_reason / fix lines ≤ 280 chars each.

# OUTPUT SCHEMA (JSON ONLY)

\`\`\`json
{
  "trend_interpretation": "<2-3 sentences in primary_language>",
  "top_actions": [{"action":"<≤140 chars>","time_to_ship_minutes":N}],
  "win_of_the_week": "<≤140 chars>"
}
\`\`\`

Return JSON only.`;
}

function buildUserMessage({ business, marketProfile, scorecardData, plan }) {
  return [
    `# WEEKLY SCORECARD COMMENTARY REQUEST`,
    ``,
    `## Business`,
    '```json',
    JSON.stringify({
      name: business?.business_name,
      industry: business?.industry,
      plan,
      primary_language: marketProfile?.primary_language,
      currency: marketProfile?.currency,
      currency_symbol: marketProfile?.currency_symbol,
    }, null, 2),
    '```',
    ``,
    `## Numbers (deterministic — quote these, never invent)`,
    '```json',
    JSON.stringify(scorecardData, null, 2),
    '```',
    ``,
    `Produce the JSON in language="${marketProfile?.primary_language || 'en'}". ${plan === 'agency' ? '5' : '3'} top actions. Return ONLY the JSON.`,
  ].join('\n');
}

function modelForPlan(plan) {
  return String(plan || 'free').toLowerCase() === 'agency' ? 'claude-opus-4-7' : 'claude-sonnet-4-5';
}

function maxTokensForPlan(plan) {
  const p = String(plan || 'free').toLowerCase();
  if (p === 'agency') return 1500;
  if (p === 'growth') return 1000;
  return 600;
}

/**
 * Format a scorecard email body in HTML (deterministic template).
 */
function buildEmailHtml({ business, marketProfile, scorecardData, commentary }) {
  const sym = marketProfile?.currency_symbol || '';
  const fmt = (n) => {
    if (!Number.isFinite(n)) return '—';
    return `${sym}${Number(n).toFixed(2)}`;
  };
  const pct = (n) => {
    if (!Number.isFinite(n)) return '—';
    return `${(n * 100).toFixed(0)}%`;
  };
  const w = scorecardData.week;
  const d = scorecardData.deltas;

  return `
<div style="font-family:system-ui,-apple-system,sans-serif;max-width:600px;margin:auto;color:#222">
  <h1 style="font-size:20px;margin-bottom:8px">${business?.business_name || 'Your business'} — Weekly Scorecard</h1>
  <p style="color:#666;margin-top:0">Week of ${new Date().toISOString().slice(0,10)}</p>

  <h2 style="font-size:16px;margin-top:24px">Top numbers</h2>
  <table style="width:100%;border-collapse:collapse">
    <tr><td>Total spend</td><td style="text-align:right">${fmt(w.spend)} ${d.spend_pct != null ? `(${pct(d.spend_pct)})` : ''}</td></tr>
    <tr><td>Conversions</td><td style="text-align:right">${w.conversions || 0} ${d.conversions_pct != null ? `(${pct(d.conversions_pct)})` : ''}</td></tr>
    <tr><td>Average ROAS</td><td style="text-align:right">${w.roas != null ? Number(w.roas).toFixed(2) : '—'} ${d.roas_pct != null ? `(${pct(d.roas_pct)})` : ''}</td></tr>
  </table>

  ${commentary?.trend_interpretation ? `
  <h2 style="font-size:16px;margin-top:24px">What this means</h2>
  <p>${commentary.trend_interpretation}</p>` : ''}

  ${scorecardData.best_campaign ? `
  <h2 style="font-size:16px;margin-top:24px">Best campaign</h2>
  <p>${scorecardData.best_campaign.campaign_name} — ROAS ${Number(scorecardData.best_campaign.roas || 0).toFixed(2)}, ${scorecardData.best_campaign.conversions} conversions on ${fmt(scorecardData.best_campaign.spend)} spend.</p>` : ''}

  ${commentary?.top_actions?.length ? `
  <h2 style="font-size:16px;margin-top:24px">Top actions for next week</h2>
  <ol>${commentary.top_actions.map(a => `<li>${a.action} <span style="color:#999;font-size:12px">(~${a.time_to_ship_minutes}min)</span></li>`).join('')}</ol>` : ''}

  ${commentary?.win_of_the_week ? `
  <p style="margin-top:24px;padding:12px;background:#f0fdf4;border-radius:8px">${commentary.win_of_the_week}</p>` : ''}
</div>`.trim();
}

module.exports = {
  buildScorecardData,
  formatScorecardMoney,
  buildSystemPrompt,
  buildUserMessage,
  modelForPlan,
  maxTokensForPlan,
  buildEmailHtml,
  i18n: adI18n,
};
