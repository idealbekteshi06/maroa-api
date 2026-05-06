'use strict';

/**
 * services/prompts/forecasting/index.js
 * ----------------------------------------------------------------------------
 * Public entry — forecastForBusiness({ business, history, orders, plan, ... })
 *
 * Pattern: deterministic numbers (regression.js) + LLM narrative on top.
 *   1. Compute forecasts deterministically (no LLM)
 *   2. If plan ≥ growth, ask Opus 4.7 / Sonnet 4.5 to narrate
 *   3. Validate output schema
 *   4. Return merged result
 *
 * Honest design: refuses to forecast when data is too thin. Reader gets a clear
 * "insufficient data — wait N more days" message rather than a fake number.
 * ----------------------------------------------------------------------------
 */

const reg = require('./regression');
const adI18n = require('../ad-optimizer/i18n-market');
const advisor = require('../advisor-tool');

// ─── Schema validator ──────────────────────────────────────────────────────

function validateForecastOutput(raw) {
  if (!raw || typeof raw !== 'object') return { valid: false, errors: ['response not object'] };
  const errors = [];
  if (raw.narrative != null && typeof raw.narrative !== 'string') errors.push('narrative must be string');
  if (raw.caveats != null && !Array.isArray(raw.caveats)) errors.push('caveats must be array');
  if (errors.length) return { valid: false, errors };
  return {
    valid: true,
    errors: [],
    normalized: {
      narrative: raw.narrative || '',
      caveats: Array.isArray(raw.caveats) ? raw.caveats : [],
    },
  };
}

// ─── System prompts ────────────────────────────────────────────────────────

function buildNarrativeSystemPrompt() {
  return `# ROLE

You are Maroa's forecasting commentator. Given a deterministic forecast (numbers already computed by regression — DO NOT INVENT NUMBERS), you write a 3-5 sentence narrative interpretation in the business owner's primary_language.

# HARD RULES

## 1. Quote the numbers, never invent
Every dollar amount, percentage, and date you cite MUST appear in the deterministic snapshot. If you can't quote it, you can't say it.

## 2. Honest about confidence
- low confidence → say "this is a rough estimate" or equivalent
- high confidence → still use ranges, never single-point claims
- never write "you'll definitely hit X" or "guaranteed"

## 3. Action-oriented
End with ONE sentence about what to do next. No vague platitudes ("keep going!").

## 4. Currency + locale
Use the provided currency_symbol + format. Decimal places per locale (JPY/IDR have 0).

## 5. Plan-tier behavior
- Growth → 3-sentence narrative
- Agency → 5-sentence narrative + 1-line action

# OUTPUT (JSON ONLY)

\`\`\`json
{
  "narrative": "<3-5 sentences in primary_language>",
  "caveats": ["<each caveat ≤120 chars>"]
}
\`\`\`

Return ONLY the JSON.`;
}

function buildNarrativeUserMessage({ business, marketProfile, forecast, plan }) {
  return [
    `# FORECAST NARRATIVE REQUEST`,
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
    `## Forecast (deterministic — quote these, never invent)`,
    '```json',
    JSON.stringify(forecast, null, 2),
    '```',
    ``,
    `Produce the JSON in language="${marketProfile?.primary_language || 'en'}". Return ONLY the JSON.`,
  ].join('\n');
}

// ─── Public entry ──────────────────────────────────────────────────────────

/**
 * Forecast for a single business.
 *
 * Inputs:
 *   business        — businesses + business_profiles row (merged)
 *   history         — last 60 days of ad_performance_logs (oldest first)
 *   channelHistory  — { meta: [...], google: [...], ... } per-channel optional
 *   orders          — list of orders for LTV calc, optional
 *   plan            — 'free' | 'growth' | 'agency'
 *   horizonDays     — 30 | 60 | 90
 *   callClaude      — injected
 *   extractJSON     — injected
 *   logger          — injected (optional)
 */
async function forecastForBusiness(opts) {
  const {
    business,
    history = [],
    channelHistory,
    orders,
    plan = 'free',
    horizonDays,
    callClaude,
    extractJSON,
    logger,
  } = opts || {};

  if (typeof callClaude !== 'function') throw new Error('forecastForBusiness: callClaude required');
  if (typeof extractJSON !== 'function') throw new Error('forecastForBusiness: extractJSON required');

  const planTier = String(plan || 'free').toLowerCase();
  const horizon = horizonDays
    || (planTier === 'agency' ? 90 : planTier === 'growth' ? 60 : 30);

  const marketProfile = adI18n.buildMarketProfile(business);

  // ─── Deterministic forecasts ───────────────────────────────────────────
  const sampleDays = history.length;
  const dataQuality = sampleDays >= 30 ? 'good' : sampleDays >= 14 ? 'limited' : 'insufficient';

  // Refuses to forecast on insufficient data
  if (dataQuality === 'insufficient') {
    return _shortCircuit({
      reason: `Need ≥14 days of performance history to forecast; have ${sampleDays}`,
      sampleDays,
      dataQuality,
      marketProfile,
      horizon,
    });
  }

  const roasSeries  = history.map(r => Number(r?.roas)).filter(Number.isFinite);
  const spendSeries = history.map(r => Number(r?.spend)).filter(Number.isFinite);

  const roasForecast  = reg.linearForecast(roasSeries, horizon);
  const spendForecast = reg.linearForecast(spendSeries, horizon);

  // Revenue = spend × ROAS, projected
  let revenueForecast = null;
  if (roasForecast && spendForecast) {
    revenueForecast = {
      low:  spendForecast.low  * roasForecast.low,
      mid:  spendForecast.mid  * roasForecast.mid,
      high: spendForecast.high * roasForecast.high,
    };
  }

  // Variance check — wide CV → flag caveat
  const variance = reg.varianceClass(roasSeries);

  // Budget allocation (multi-channel)
  let budgetAllocation = null;
  if (channelHistory && typeof channelHistory === 'object') {
    const channels = Object.entries(channelHistory).map(([name, rows]) => {
      const spend = (rows || []).map(r => Number(r?.spend) || 0).reduce((a, b) => a + b, 0);
      const roas = reg.mean((rows || []).map(r => Number(r?.roas)).filter(Number.isFinite));
      return { name, spend, roas };
    });
    budgetAllocation = reg.recommendBudgetAllocation(channels);
  }

  // LTV (only if orders provided)
  const ltv = orders && Array.isArray(orders) ? reg.cohortLtv(orders) : null;

  // Build deterministic forecast object
  const forecast = {
    horizon_days: horizon,
    roas_forecast: roasForecast ? {
      low: Number(roasForecast.low.toFixed(2)),
      mid: Number(roasForecast.mid.toFixed(2)),
      high: Number(roasForecast.high.toFixed(2)),
      confidence: roasForecast.confidence,
      r2: Number(roasForecast.r2.toFixed(3)),
    } : null,
    spend_forecast: spendForecast ? {
      low: Number(spendForecast.low.toFixed(2)),
      mid: Number(spendForecast.mid.toFixed(2)),
      high: Number(spendForecast.high.toFixed(2)),
    } : null,
    revenue_forecast: revenueForecast ? {
      low: Number(revenueForecast.low.toFixed(2)),
      mid: Number(revenueForecast.mid.toFixed(2)),
      high: Number(revenueForecast.high.toFixed(2)),
    } : null,
    ltv_forecast: ltv ? {
      value: Number(ltv.value.toFixed(2)),
      currency: marketProfile.currency,
      repeat_rate: Number(ltv.repeat_rate.toFixed(3)),
      confidence: ltv.confidence,
      sample_size: ltv.sample_size,
    } : null,
    budget_allocation_recommendation: budgetAllocation,
    data_quality: dataQuality,
    sample_size_days: sampleDays,
    variance_class: variance,
    currency: marketProfile.currency,
    primary_language: marketProfile.primary_language,
    country: marketProfile.country,
  };

  // Build caveats
  const caveats = [];
  if (variance === 'high') caveats.push('High variance in historical data — confidence band is wide.');
  if (sampleDays < 30) caveats.push(`Only ${sampleDays} days of data — narrow confidence will widen with more history.`);
  if (roasForecast && roasForecast.confidence === 'low') caveats.push('R² is low — trend may not be a reliable predictor here.');
  forecast.caveats = caveats;

  // ─── LLM narrative (skip on free tier — they get raw numbers) ──────────
  if (planTier === 'free') {
    return {
      ...forecast,
      narrative: '',
      narrative_generated: false,
      short_circuited: false,
    };
  }

  let narrative = '';
  try {
    const raw = await advisor.callWithAdvisor({
      callClaude,
      system: buildNarrativeSystemPrompt(),
      user: buildNarrativeUserMessage({ business, marketProfile, forecast, plan: planTier }),
      executor: 'claude-sonnet-4-5',
      advisor: 'claude-opus-4-7',
      task: 'forecast',
      planTier,
      max_tokens: planTier === 'agency' ? 1200 : 800,
      extra: { cacheSystem: true },
      temperature: 0.3,
    });
    const parsed = extractJSON(raw);
    const v = parsed ? validateForecastOutput(parsed) : { valid: false };
    if (v.valid) {
      narrative = v.normalized.narrative || '';
      // Merge caveats from LLM (often catches things deterministic logic missed)
      for (const c of (v.normalized.caveats || [])) {
        if (!forecast.caveats.includes(c)) forecast.caveats.push(c);
      }
    }
  } catch (e) {
    logger?.warn?.('forecasting', null, 'LLM narrative failed — returning numbers only', e?.message);
  }

  return {
    ...forecast,
    narrative,
    narrative_generated: !!narrative,
    short_circuited: false,
  };
}

// ─── Internal ─────────────────────────────────────────────────────────────

function _shortCircuit({ reason, sampleDays, dataQuality, marketProfile, horizon }) {
  return {
    horizon_days: horizon,
    roas_forecast: null,
    spend_forecast: null,
    revenue_forecast: null,
    ltv_forecast: null,
    budget_allocation_recommendation: null,
    data_quality: dataQuality,
    sample_size_days: sampleDays,
    variance_class: null,
    currency: marketProfile?.currency || 'USD',
    primary_language: marketProfile?.primary_language || 'en',
    country: marketProfile?.country || null,
    narrative: '',
    narrative_generated: false,
    caveats: [reason],
    short_circuited: true,
    short_circuit_reason: reason,
  };
}

module.exports = {
  forecastForBusiness,
  validateForecastOutput,
  buildNarrativeSystemPrompt,
  regression: reg,
};
