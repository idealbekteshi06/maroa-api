'use strict';

/**
 * services/prompts/ad-optimizer/checks-google.js
 * ----------------------------------------------------------------------------
 * Google Ads check stubs. Maroa runs Meta-only in v1, but the architecture
 * is multi-platform-ready. The 80 Google checks live here as a placeholder —
 * activated when the business connects a Google Ads account.
 *
 * The runChecks() signature matches checks-meta.js so the engine can dispatch
 * by platform.
 * ----------------------------------------------------------------------------
 */

const CHECKS = [
  // Stubs — populate when Google Ads OAuth is wired up.
  {
    id: 'G01',
    title: 'Quality Score below 5',
    category: 'audience',
    priority: 8,
    severity: 'warning',
    detect: ({ metrics }) => {
      const qs = Number(metrics?.quality_score);
      if (!Number.isFinite(qs) || qs >= 5) return null;
      return {
        fix: `Quality Score ${qs}/10 — improve ad relevance + landing page experience`,
        evidence: { metric: 'quality_score', value: qs, threshold: 5 },
      };
    },
  },
  {
    id: 'G02',
    title: 'Search lost top impression share — budget',
    category: 'budget',
    priority: 7,
    severity: 'warning',
    detect: ({ metrics }) => {
      const lost = Number(metrics?.search_lost_top_is_budget);
      if (!Number.isFinite(lost) || lost < 0.3) return null;
      return {
        fix: `Lost ${(lost*100).toFixed(0)}% of top-of-page IS to budget — increase budget or reduce keywords`,
        evidence: { metric: 'search_lost_top_is_budget', value: lost, threshold: 0.3 },
      };
    },
  },
  // Future: 78 more SMB-calibrated Google checks (Performance Max, Search,
  // Display, YouTube, Shopping). Wire up when Google Ads integration ships.
];

function runChecks({ metrics, history, market, decisionHistory, plan = 'free' }) {
  const findings = [];
  for (const check of CHECKS) {
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
    } catch { /* skip bad data */ }
  }
  return findings;
}

module.exports = { CHECKS, runChecks };
