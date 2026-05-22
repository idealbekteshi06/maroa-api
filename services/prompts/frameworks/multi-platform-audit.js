'use strict';

/**
 * Parallel multi-platform ad audit rubric (inspired by composio.dev paid-ads audit).
 * Meta + Google run in parallel; findings merged with spend-weighted scoring.
 */

const PLATFORM_WEIGHT_DEFAULT = { meta: 0.6, google: 0.4 };

function spendWeight(platform, metricsByPlatform, weights = PLATFORM_WEIGHT_DEFAULT) {
  const m = metricsByPlatform?.[platform];
  const spend = Number(m?.spend ?? m?.spend_usd ?? 0);
  if (spend > 0) return spend;
  return weights[platform] ?? 0.25;
}

function normalizeSpendWeights(metricsByPlatform, platforms) {
  const raw = {};
  let total = 0;
  for (const p of platforms) {
    raw[p] = spendWeight(p, metricsByPlatform);
    total += raw[p];
  }
  if (total <= 0) {
    const even = 1 / platforms.length;
    return Object.fromEntries(platforms.map((p) => [p, even]));
  }
  return Object.fromEntries(platforms.map((p) => [p, raw[p] / total]));
}

/**
 * Merge per-platform audit bundles into one audit input shape.
 *
 * @param {Array<{ platform: string, findings: object[], auditScore: number, gates: object }>} bundles
 * @param {Record<string, number>} spendWeights
 */
function mergeMultiPlatformBundles(bundles, spendWeights) {
  const findings = [];
  const platformScores = {};
  let weightedScore = 0;

  for (const b of bundles) {
    const w = spendWeights[b.platform] ?? 0;
    platformScores[b.platform] = { audit_score: b.auditScore, weight: w, finding_count: b.findings.length };
    weightedScore += (b.auditScore || 0) * w;
    for (const f of b.findings) {
      findings.push({
        ...f,
        platform: b.platform,
        check_id: f.check_id ? `${b.platform}:${f.check_id}` : f.check_id,
      });
    }
  }

  findings.sort((a, b) => {
    const sev = { critical: 0, warning: 1, info: 2 };
    return (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3);
  });

  const crossPlatform = [];
  const criticalPlatforms = Object.entries(platformScores).filter(([, v]) => v.audit_score < 50);
  if (criticalPlatforms.length >= 2) {
    crossPlatform.push({
      check_id: 'X01',
      severity: 'critical',
      category: 'cross_platform',
      title: 'Multiple platforms unhealthy',
      detail: `${criticalPlatforms.map(([p]) => p).join(' + ')} scores below 50 — account-level issue likely (tracking, offer, or landing page).`,
    });
  }

  return {
    findings: [...crossPlatform, ...findings],
    auditScore: Math.round(weightedScore),
    multi_platform: {
      platforms: Object.keys(platformScores),
      spend_weights: spendWeights,
      platform_scores: platformScores,
      parallel_audit: true,
      instruction:
        'Findings are tagged by platform. Prioritize spend-weighted platforms. Recommend ONE primary action; secondary actions per platform only if evidence differs.',
    },
  };
}

function buildMultiPlatformPromptSection(multiPlatformMeta) {
  if (!multiPlatformMeta?.parallel_audit) return '';
  return `
## Multi-platform parallel audit

Platforms audited in parallel: ${(multiPlatformMeta.platforms || []).join(', ')}
Spend weights: ${JSON.stringify(multiPlatformMeta.spend_weights || {})}
Per-platform scores: ${JSON.stringify(multiPlatformMeta.platform_scores || {})}

${multiPlatformMeta.instruction}
`.trim();
}

module.exports = {
  PLATFORM_WEIGHT_DEFAULT,
  normalizeSpendWeights,
  mergeMultiPlatformBundles,
  buildMultiPlatformPromptSection,
};
