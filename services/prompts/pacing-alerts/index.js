'use strict';

/**
 * services/prompts/pacing-alerts/index.js
 * ----------------------------------------------------------------------------
 * Pacing Alert engine — fires BETWEEN daily ad audits when a campaign starts
 * trending bad mid-day. Rule-based (deterministic, no LLM call needed for
 * detection — saves cost and gives predictable behavior). LLM is only used to
 * humanize the alert message in business primary_language.
 *
 * Cadence: every 4 hours.
 *
 * Detection rules — at least one must fire to alert:
 *   P01  spend > 130% of daily_budget * (hours_elapsed / 24)
 *   P02  ROAS < 0.5 over last 6 hours, sample > 30 clicks
 *   P03  CPA > 3x target_cpa, sample > 10 conversions
 *   P04  Frequency rose by >25% over previous 24h
 *   P05  Click count zero for >12h on active campaign
 *   P06  Critical compliance flag (ad rejected mid-day)
 *
 * All thresholds calibrated to SMB (small budgets, low traffic).
 * ----------------------------------------------------------------------------
 */

const adI18n = require('../ad-optimizer/i18n-market');

const RULES = [
  {
    id: 'P01',
    title: 'Spend pacing over budget',
    severity: 'warning',
    check: ({ metrics, hours_elapsed }) => {
      const spend = Number(metrics?.spend);
      const budget = Number(metrics?.daily_budget);
      if (!Number.isFinite(spend) || !Number.isFinite(budget) || budget <= 0) return null;
      const expected = budget * Math.max(0, Math.min(1, hours_elapsed / 24));
      if (expected > 0 && spend > expected * 1.3) {
        return {
          message: `Spend ${spend.toFixed(2)} exceeds ${(expected * 1.3).toFixed(2)} (130% of expected at ${hours_elapsed}h).`,
          evidence: { spend, expected_at_hour: expected, hours_elapsed },
        };
      }
      return null;
    },
  },
  {
    id: 'P02',
    title: 'ROAS collapsed mid-day',
    severity: 'critical',
    check: ({ metrics, recent_window }) => {
      const r = Number(recent_window?.roas);
      const c = Number(recent_window?.clicks);
      if (!Number.isFinite(r) || !Number.isFinite(c)) return null;
      if (c >= 30 && r < 0.5) {
        return {
          message: `ROAS ${r.toFixed(2)} on ${c} clicks in last 6h — below break-even by 50%.`,
          evidence: { roas: r, clicks: c, window: '6h' },
        };
      }
      return null;
    },
  },
  {
    id: 'P03',
    title: 'CPA blown out',
    severity: 'critical',
    check: ({ metrics }) => {
      const cpa = Number(metrics?.cpa);
      const target = Number(metrics?.target_cpa);
      const conv = Number(metrics?.conversions);
      if (!Number.isFinite(cpa) || !Number.isFinite(target) || target <= 0 || conv < 10) return null;
      if (cpa > target * 3) {
        return {
          message: `CPA ${cpa.toFixed(2)} is ${(cpa / target).toFixed(1)}x over target ${target.toFixed(2)}.`,
          evidence: { cpa, target_cpa: target, conversions: conv },
        };
      }
      return null;
    },
  },
  {
    id: 'P04',
    title: 'Frequency spiking',
    severity: 'warning',
    check: ({ metrics, prev_24h }) => {
      const f = Number(metrics?.frequency);
      const fp = Number(prev_24h?.frequency);
      if (!Number.isFinite(f) || !Number.isFinite(fp) || fp <= 0) return null;
      if ((f - fp) / fp > 0.25 && f > 2.0) {
        return {
          message: `Frequency rose ${(((f - fp) / fp) * 100).toFixed(0)}% in 24h (${fp.toFixed(1)} → ${f.toFixed(1)}).`,
          evidence: { freq_now: f, freq_24h_ago: fp, pct_change: (f - fp) / fp },
        };
      }
      return null;
    },
  },
  {
    id: 'P05',
    title: 'Active campaign producing zero clicks',
    severity: 'warning',
    check: ({ metrics, hours_since_first_click }) => {
      const status = String(metrics?.status || '').toUpperCase();
      const clicks = Number(metrics?.clicks);
      if (status !== 'ACTIVE' || !Number.isFinite(clicks)) return null;
      if (clicks === 0 && hours_since_first_click > 12) {
        return {
          message: `Active campaign with 0 clicks for ${hours_since_first_click}h.`,
          evidence: { clicks, hours_since_first_click },
        };
      }
      return null;
    },
  },
  {
    id: 'P06',
    title: 'Ad rejected mid-day',
    severity: 'critical',
    check: ({ metrics }) => {
      const adStatus = String(metrics?.ad_status || '').toLowerCase();
      if (adStatus.includes('reject') || adStatus.includes('disapprov')) {
        return {
          message: 'Ad rejected by Meta policy — campaign halted.',
          evidence: { ad_status: metrics.ad_status },
        };
      }
      return null;
    },
  },
];

/**
 * Run all rules. Returns array of fired alerts (may be empty).
 */
function evaluatePacing({ metrics, recent_window, prev_24h, hours_elapsed, hours_since_first_click }) {
  const alerts = [];
  const ctx = { metrics, recent_window, prev_24h, hours_elapsed, hours_since_first_click };
  for (const rule of RULES) {
    try {
      const r = rule.check(ctx);
      if (r) {
        alerts.push({
          rule_id: rule.id,
          title: rule.title,
          severity: rule.severity,
          message: r.message,
          evidence: r.evidence,
        });
      }
    } catch { /* defensive */ }
  }
  return alerts;
}

/**
 * Build market-aware human message. (Optionally calls LLM for translation;
 * default just returns the rule message — keep cost zero.)
 */
function humanizeAlert({ alert, business, marketProfile }) {
  return {
    ...alert,
    primary_language: marketProfile?.primary_language || 'en',
    currency: marketProfile?.currency,
    country: marketProfile?.country,
  };
}

function buildAlertSystemPrompt() {
  return `You are an alert-message humanizer. Translate a structured pacing alert into ONE short readable message in the business's primary_language. ≤140 chars. No emoji. No exclamation marks. Just the fact.`;
}

module.exports = {
  RULES,
  evaluatePacing,
  humanizeAlert,
  buildAlertSystemPrompt,
  i18n: adI18n,
};
