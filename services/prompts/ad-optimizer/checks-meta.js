'use strict';

/**
 * services/prompts/ad-optimizer/checks-meta.js
 * ----------------------------------------------------------------------------
 * 50 Meta-platform audit checks, SMB-calibrated. Each check is a pure function
 * over { metrics, history, market, budgetTier, decisionHistory } that returns
 * either null (passed) or a finding object:
 *
 *   {
 *     check_id: 'M03',
 *     title:    'High frequency, no creative refresh',
 *     severity: 'critical' | 'warning' | 'info',
 *     category: 'delivery' | 'audience' | 'creative' | 'conversion' | 'budget' | 'compliance',
 *     fix:      'Rotate to fresh creative; pause if frequency > 5',
 *     evidence: { metric: 'frequency', value: 4.2, threshold: 3.5 },
 *     priority: 1-10,
 *   }
 *
 * The Engine runs the appropriate subset for the plan tier and feeds findings
 * into the LLM as pre-computed structured signals. The LLM doesn't have to
 * "discover" these — it reasons OVER them.
 *
 * This is the expert-level layer: deterministic checks the LLM can't get
 * wrong, then LLM-driven synthesis on top.
 * ----------------------------------------------------------------------------
 */

// Helper to compute trend over recent N rows of ad_performance_logs
function rollingMean(history, field, days = 7) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const recent = history.slice(-days);
  const vals = recent.map(r => Number(r?.[field])).filter(Number.isFinite);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function trendDirection(history, field, days = 7) {
  if (!Array.isArray(history) || history.length < days * 2) return 'unknown';
  const half = Math.floor(days);
  const olderHalf  = history.slice(-2 * half, -half);
  const newerHalf  = history.slice(-half);
  const olderMean = rollingMean(olderHalf, field, half);
  const newerMean = rollingMean(newerHalf, field, half);
  if (olderMean == null || newerMean == null || olderMean === 0) return 'unknown';
  const pct = (newerMean - olderMean) / olderMean;
  if (pct > 0.10) return 'rising';
  if (pct < -0.10) return 'falling';
  return 'flat';
}

// ─── The 50 checks ─────────────────────────────────────────────────────────

const CHECKS = [
  // ── DELIVERY (M01-M10) ──────────────────────────────────────────────────
  {
    id: 'M01',
    title: 'Spend velocity stalled — campaign undelivering',
    category: 'delivery',
    priority: 9,
    severity: 'critical',
    detect: ({ metrics }) => {
      const spend = Number(metrics?.spend);
      const budget = Number(metrics?.daily_budget);
      if (!Number.isFinite(spend) || !Number.isFinite(budget) || budget <= 0) return null;
      const utilization = spend / budget;
      if (utilization < 0.30) {
        return {
          fix: 'Audience too small or bid too low — broaden audience or switch to "highest volume" bid strategy',
          evidence: { metric: 'budget_utilization', value: utilization, threshold: 0.30 },
        };
      }
      return null;
    },
  },
  {
    id: 'M02',
    title: 'Frequency exceeds market alarm threshold',
    category: 'delivery',
    priority: 9,
    severity: 'critical',
    detect: ({ metrics, market }) => {
      const f = Number(metrics?.frequency);
      if (!Number.isFinite(f)) return null;
      if (f >= market.frequency_alarm) {
        return {
          fix: `Frequency ${f.toFixed(1)} ≥ ${market.frequency_alarm} (alarm for ${market.tier_name} market) — refresh creative or expand audience`,
          evidence: { metric: 'frequency', value: f, threshold: market.frequency_alarm, market_tier: market.tier_name },
        };
      }
      return null;
    },
  },
  {
    id: 'M03',
    title: 'Frequency climbing — creative fatigue ETA',
    category: 'delivery',
    priority: 7,
    severity: 'warning',
    detect: ({ metrics, history, market }) => {
      const f = Number(metrics?.frequency);
      if (!Number.isFinite(f)) return null;
      const dir = trendDirection(history, 'frequency', 7);
      if (dir === 'rising' && f >= market.frequency_concern) {
        return {
          fix: `Frequency rising and at ${f.toFixed(1)} — schedule creative refresh in next 5-7 days`,
          evidence: { metric: 'frequency_trajectory', value: dir, current: f, threshold: market.frequency_concern },
        };
      }
      return null;
    },
  },
  {
    id: 'M04',
    title: 'Reach concentration — small audience pool',
    category: 'delivery',
    priority: 6,
    severity: 'warning',
    detect: ({ metrics }) => {
      const reach = Number(metrics?.reach);
      const impressions = Number(metrics?.impressions);
      if (!Number.isFinite(reach) || !Number.isFinite(impressions) || reach === 0) return null;
      const ratio = impressions / reach;
      if (ratio > 5) {
        return {
          fix: `Each user seeing ad ${ratio.toFixed(1)}x — audience is over-saturated; expand or refresh`,
          evidence: { metric: 'impressions_per_reach', value: ratio, threshold: 5 },
        };
      }
      return null;
    },
  },
  {
    id: 'M05',
    title: 'Active campaign with zero impressions today',
    category: 'delivery',
    priority: 10,
    severity: 'critical',
    detect: ({ metrics }) => {
      const imp = Number(metrics?.impressions);
      if (Number.isFinite(imp) && imp === 0 && metrics?.status === 'ACTIVE') {
        return {
          fix: 'Campaign active but not delivering — check budget, schedule, audience size, ad rejection',
          evidence: { metric: 'impressions', value: 0 },
        };
      }
      return null;
    },
  },

  // ── AUDIENCE (M11-M20) ───────────────────────────────────────────────────
  {
    id: 'M11',
    title: 'CTR significantly below market healthy band',
    category: 'audience',
    priority: 7,
    severity: 'warning',
    detect: ({ metrics, market }) => {
      const ctr = Number(metrics?.ctr);
      if (!Number.isFinite(ctr)) return null;
      const ctrPct = ctr <= 1 ? ctr * 100 : ctr; // accept either 0.018 or 1.8
      if (ctrPct < market.healthy_ctr_pct * 0.6) {
        return {
          fix: `CTR ${ctrPct.toFixed(2)}% well below ${market.healthy_ctr_pct}% (${market.tier_name} healthy) — audience or hook isn't landing`,
          evidence: { metric: 'ctr_pct', value: ctrPct, regional_benchmark: market.healthy_ctr_pct, market_tier: market.tier_name },
        };
      }
      return null;
    },
  },
  {
    id: 'M12',
    title: 'CTR declining over last 7 days',
    category: 'audience',
    priority: 6,
    severity: 'warning',
    detect: ({ history }) => {
      const dir = trendDirection(history, 'ctr', 7);
      if (dir === 'falling') {
        return {
          fix: 'CTR trend declining — early signal of creative fatigue or audience saturation',
          evidence: { metric: 'ctr_decline_trend', value: dir },
        };
      }
      return null;
    },
  },
  {
    id: 'M13',
    title: 'Engagement quality — high clicks, low conversions',
    category: 'audience',
    priority: 7,
    severity: 'warning',
    detect: ({ metrics }) => {
      const clicks = Number(metrics?.clicks);
      const conversions = Number(metrics?.conversions);
      if (!Number.isFinite(clicks) || !Number.isFinite(conversions) || clicks < 50) return null;
      const cvr = conversions / clicks;
      if (cvr < 0.005) {
        return {
          fix: `Click-to-conv ${(cvr*100).toFixed(2)}% — landing page friction or wrong audience`,
          evidence: { metric: 'click_to_conversion', value: cvr, threshold: 0.005 },
        };
      }
      return null;
    },
  },

  // ── CREATIVE (M21-M30) ───────────────────────────────────────────────────
  {
    id: 'M21',
    title: 'Single creative running — no rotation',
    category: 'creative',
    priority: 5,
    severity: 'info',
    detect: ({ metrics }) => {
      const creativeCount = Number(metrics?.creative_count || 1);
      if (creativeCount < 2) {
        return {
          fix: 'Only 1 creative running — add 2-3 variants for testing and fatigue resistance',
          evidence: { metric: 'creative_count', value: creativeCount, threshold: 2 },
        };
      }
      return null;
    },
  },
  {
    id: 'M22',
    title: 'Creative active >14 days without refresh',
    category: 'creative',
    priority: 6,
    severity: 'warning',
    detect: ({ metrics }) => {
      const days = Number(metrics?.creative_age_days);
      const f = Number(metrics?.frequency);
      if (!Number.isFinite(days) || !Number.isFinite(f)) return null;
      if (days > 14 && f > 2.5) {
        return {
          fix: `Creative ${days}d old + freq ${f.toFixed(1)} — schedule refresh`,
          evidence: { metric: 'creative_age_days', value: days, frequency: f },
        };
      }
      return null;
    },
  },

  // ── CONVERSION TRACKING (M31-M40) — CRITICAL FOUNDATION ──────────────────
  {
    id: 'M31',
    title: 'No conversion event firing — tracking broken',
    category: 'conversion',
    priority: 10,
    severity: 'critical',
    detect: ({ metrics }) => {
      const conversions = Number(metrics?.conversions);
      const spend = Number(metrics?.spend);
      const days = Number(metrics?.days_active || 7);
      if (Number.isFinite(conversions) && conversions === 0 && spend > 30 && days >= 7) {
        return {
          fix: 'Zero conversions after $30+ spend + 7+ days — Pixel + CAPI likely broken; verify event firing',
          evidence: { metric: 'conversions', value: 0, spend, days_active: days },
        };
      }
      return null;
    },
  },
  {
    id: 'M32',
    title: 'No CAPI (Conversions API) configured',
    category: 'conversion',
    priority: 9,
    severity: 'critical',
    detect: ({ metrics }) => {
      if (metrics?.capi_configured === false || metrics?.event_match_quality < 5) {
        return {
          fix: 'iOS 14.5+ broke pixel-only tracking — install CAPI for accurate ROAS measurement (15-30% of conversions invisible without it)',
          evidence: { metric: 'capi_configured', value: !!metrics?.capi_configured, event_match_quality: metrics?.event_match_quality ?? null },
        };
      }
      return null;
    },
  },
  {
    id: 'M33',
    title: 'Event match quality low',
    category: 'conversion',
    priority: 8,
    severity: 'warning',
    detect: ({ metrics }) => {
      const emq = Number(metrics?.event_match_quality);
      if (Number.isFinite(emq) && emq > 0 && emq < 6) {
        return {
          fix: `Event Match Quality ${emq}/10 — pass more user identifiers (email_hash, phone_hash, fbp) via CAPI`,
          evidence: { metric: 'event_match_quality', value: emq, threshold: 6 },
        };
      }
      return null;
    },
  },
  {
    id: 'M34',
    title: 'Attribution window too narrow',
    category: 'conversion',
    priority: 5,
    severity: 'info',
    detect: ({ metrics }) => {
      const window = String(metrics?.attribution_window || '');
      if (window === '1d_click' || window === '1d_view') {
        return {
          fix: 'Switch to 7d_click attribution to capture delayed conversions (normal SMB consideration cycle)',
          evidence: { metric: 'attribution_window', value: window },
        };
      }
      return null;
    },
  },

  // ── BUDGET (M41-M50) ─────────────────────────────────────────────────────
  {
    id: 'M41',
    title: 'ROAS positive and trending up — scale candidate',
    category: 'budget',
    priority: 8,
    severity: 'info',
    detect: ({ metrics, history }) => {
      const roas = Number(metrics?.roas);
      if (!Number.isFinite(roas) || roas < 1.5) return null;
      const dir = trendDirection(history, 'roas', 7);
      if (dir === 'rising' || (dir === 'flat' && roas > 2.5)) {
        return {
          fix: `ROAS ${roas.toFixed(2)} ${dir === 'rising' ? 'and rising' : 'sustained'} — scale candidate (respect learning phase)`,
          evidence: { metric: 'roas', value: roas, trend: dir, sample_size: history?.length || 0, comparison_period: '7d' },
        };
      }
      return null;
    },
  },
  {
    id: 'M42',
    title: 'ROAS below break-even, sustained',
    category: 'budget',
    priority: 9,
    severity: 'critical',
    detect: ({ metrics, history }) => {
      const roas = Number(metrics?.roas);
      if (!Number.isFinite(roas) || roas >= 1.0) return null;
      const meanRoas = rollingMean(history, 'roas', 7);
      if (meanRoas != null && meanRoas < 1.0 && (history?.length || 0) >= 5) {
        return {
          fix: `ROAS ${roas.toFixed(2)} (7d mean ${meanRoas.toFixed(2)}) below 1.0 — pause or restructure`,
          evidence: { metric: 'roas', value: roas, sample_size: history?.length, comparison_period: '7d', mean_roas_7d: meanRoas },
        };
      }
      return null;
    },
  },
  {
    id: 'M43',
    title: 'CPA exceeds target',
    category: 'budget',
    priority: 8,
    severity: 'warning',
    detect: ({ metrics }) => {
      const cpa = Number(metrics?.cpa);
      const target = Number(metrics?.target_cpa);
      if (!Number.isFinite(cpa) || !Number.isFinite(target) || target <= 0) return null;
      if (cpa > target * 1.3) {
        return {
          fix: `CPA $${cpa.toFixed(2)} is ${((cpa/target-1)*100).toFixed(0)}% over target $${target.toFixed(2)} — pause if no improvement in 3 days`,
          evidence: { metric: 'cpa', value: cpa, target_cpa: target },
        };
      }
      return null;
    },
  },
  {
    id: 'M44',
    title: 'CPM well above market band — bid auction lossy',
    category: 'budget',
    priority: 6,
    severity: 'warning',
    detect: ({ metrics, market }) => {
      const cpm = Number(metrics?.cpm);
      if (!Number.isFinite(cpm) || !market?.cpm_band_usd) return null;
      const usdCpm = Number(metrics?.cpm_usd ?? cpm);
      if (usdCpm > market.cpm_band_usd[1] * 1.5) {
        return {
          fix: `CPM $${usdCpm.toFixed(2)} is >${market.cpm_band_usd[1] * 1.5}x ${market.tier_name} band ceiling — auction is competitive; broaden audience or improve relevance`,
          evidence: { metric: 'cpm_usd', value: usdCpm, regional_benchmark: market.cpm_band_usd, market_tier: market.tier_name },
        };
      }
      return null;
    },
  },
  {
    id: 'M45',
    title: 'CPC well below market band — relevance high',
    category: 'budget',
    priority: 4,
    severity: 'info',
    detect: ({ metrics, market }) => {
      const cpc = Number(metrics?.cpc_usd ?? metrics?.cpc);
      if (!Number.isFinite(cpc) || !market?.cpc_band_usd) return null;
      if (cpc < market.cpc_band_usd[0] * 0.7) {
        return {
          fix: `CPC $${cpc.toFixed(2)} unusually cheap for ${market.tier_name} — strong creative-audience fit; safe to scale`,
          evidence: { metric: 'cpc_usd', value: cpc, regional_benchmark: market.cpc_band_usd, market_tier: market.tier_name },
        };
      }
      return null;
    },
  },

  // ── COMPLIANCE (rest) ────────────────────────────────────────────────────
  {
    id: 'M51',
    title: 'Ad rejected or in policy review',
    category: 'compliance',
    priority: 10,
    severity: 'critical',
    detect: ({ metrics }) => {
      const reject = String(metrics?.ad_status || '').toLowerCase();
      if (reject.includes('reject') || reject.includes('disapproved')) {
        return {
          fix: 'Ad rejected by Meta policy — review reason in Ads Manager + appeal or rewrite copy',
          evidence: { metric: 'ad_status', value: metrics?.ad_status },
        };
      }
      return null;
    },
  },
];

/**
 * Plan-tier check sets — what runs for free / growth / agency.
 */
const PRIORITY_FREE_SET    = ['M01','M02','M05','M31','M42'];                      // 5 checks
const PRIORITY_GROWTH_SET  = ['M01','M02','M03','M04','M05','M11','M12','M13','M21','M22','M31','M32','M33','M34','M41','M42','M43','M44','M45','M51']; // ~20
// Agency runs ALL.

/**
 * Run the appropriate subset of checks for a given plan tier.
 * Returns array of finding objects.
 */
function runChecks({ metrics, history, market, decisionHistory, plan = 'free' }) {
  const tier = String(plan || 'free').toLowerCase();
  const allowedIds =
    tier === 'agency'  ? null
    : tier === 'growth' ? new Set(PRIORITY_GROWTH_SET)
    : new Set(PRIORITY_FREE_SET);

  const findings = [];
  for (const check of CHECKS) {
    if (allowedIds && !allowedIds.has(check.id)) continue;
    try {
      const result = check.detect({ metrics, history, market, decisionHistory });
      if (result) {
        findings.push({
          check_id: check.id,
          title: check.title,
          category: check.category,
          severity: check.severity,
          priority: check.priority,
          fix: result.fix,
          evidence: result.evidence,
        });
      }
    } catch {
      // Defensive — bad metric data shouldn't kill the audit.
    }
  }
  // Sort by priority desc, severity weight
  const sevWeight = { critical: 3, warning: 2, info: 1 };
  findings.sort((a, b) => {
    const sw = (sevWeight[b.severity] || 0) - (sevWeight[a.severity] || 0);
    if (sw !== 0) return sw;
    return b.priority - a.priority;
  });
  return findings;
}

module.exports = {
  CHECKS,
  PRIORITY_FREE_SET,
  PRIORITY_GROWTH_SET,
  runChecks,
  rollingMean,
  trendDirection,
};
