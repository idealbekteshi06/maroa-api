'use strict';

/**
 * services/taxonomy-refresh/index.js
 * ---------------------------------------------------------------------------
 * Quarterly AI-assisted taxonomy refresh (Wave 59 Session 5).
 *
 * Problem: lib/taxonomy/industries.js + expert_sources.js are hand-curated.
 * Without ongoing maintenance, they go stale — new verticals (AI agents,
 * Web3 brands, etc.) get missed; old categories (BlackBerry apps, RIM
 * partners) linger. Manual quarterly audits don't happen because nobody
 * remembers to schedule them.
 *
 * Fix: Inngest fires this every 90 days. Claude (Sonnet) compares the
 * current taxonomy against recent marketing trends + identifies adds/drops.
 * We post the proposed diff to Slack for human review — NEVER auto-merge.
 * Human approves by opening a PR with the suggested changes.
 *
 * Why no auto-merge: the taxonomy is load-bearing. A bad rename or removed
 * vertical could break grounding retrieval for every customer in that
 * industry. We trade automation speed for safety here.
 *
 * Cost: 2 Sonnet calls per quarter (~$0.10 total). Negligible.
 *
 * Public API:
 *   refreshTaxonomy({ deps }) → { ok, industries_diff, expert_sources_diff,
 *                                  alert_dispatched }
 *
 * Deps:
 *   - callClaude  (Sonnet — propose diffs)
 *   - alertRouter (route the proposed diff to Slack)
 *   - logger
 * ---------------------------------------------------------------------------
 */

const { industries, expertSources } = require('../../lib/taxonomy');

const INDUSTRIES_REVIEW_SYSTEM_PROMPT = `You are a senior marketing strategist reviewing a SaaS company's industry taxonomy.

You will be shown the current list of industries the company classifies businesses into. Your job:

1. Identify VERTICALS THAT HAVE GROWN in the last 90 days and aren't in the list (e.g., new SMB categories that emerged from recent trends).
2. Identify VERTICALS THAT ARE DEAD (e.g., a category that no longer represents enough businesses to justify a slot).
3. Identify VERTICALS WITH SIGNIFICANT OVERLAP that should be merged.

Be conservative. Only propose changes you'd confidently recommend to a product team. If the list looks fine, return an empty diff — that's a valid answer.

Output ONLY this JSON, no prose, no markdown:

{
  "additions":   [{ "id": "snake_case_id", "label": "...", "parent": "...", "reason": "why" }],
  "removals":    [{ "id": "existing_id", "reason": "why" }],
  "merges":      [{ "absorbed_into": "keep_this_id", "remove": "this_id", "reason": "why" }],
  "summary": "one-sentence overall assessment"
}`;

const EXPERT_SOURCES_REVIEW_SYSTEM_PROMPT = `You are a senior marketing strategist reviewing a SaaS company's "expert brand" catalog.

You will be shown the current list of brands the company considers expert-tier for each industry. Your job:

1. Identify BRANDS WORTH ADDING — recent award winners, viral moments, fast-growing DTC brands (last 12 months).
2. Identify BRANDS TO RETIRE — brands that have shrunk, gone out of business, or stopped innovating.

Be conservative. The current list is high quality; only propose changes you'd confidently recommend.

Output ONLY this JSON, no prose, no markdown:

{
  "additions": [{ "name": "Brand Name", "industry": "industry_id", "region": "REGION", "quality_score": 0.85, "reason": "why" }],
  "removals":  [{ "name": "Brand Name", "industry": "industry_id", "reason": "why" }],
  "summary": "one-sentence overall assessment"
}`;

function _parseDiff(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

/**
 * Format an industries diff for Slack — keeps the alert under 3000 chars
 * (Slack's webhook block limit) while surfacing the highest-value info.
 */
function _formatIndustriesDiff(diff) {
  if (!diff) return '⚠️ Industries review failed to parse';
  const parts = [];
  parts.push(`📊 *Industries taxonomy review*`);
  if (diff.summary) parts.push(`_${diff.summary}_`);
  if (Array.isArray(diff.additions) && diff.additions.length) {
    parts.push(`\n*+ ${diff.additions.length} suggested additions:*`);
    for (const a of diff.additions.slice(0, 8)) parts.push(`  • \`${a.id}\` — ${a.label}: _${a.reason}_`);
  }
  if (Array.isArray(diff.removals) && diff.removals.length) {
    parts.push(`\n*− ${diff.removals.length} suggested removals:*`);
    for (const r of diff.removals.slice(0, 8)) parts.push(`  • \`${r.id}\`: _${r.reason}_`);
  }
  if (Array.isArray(diff.merges) && diff.merges.length) {
    parts.push(`\n*⟲ ${diff.merges.length} suggested merges:*`);
    for (const m of diff.merges.slice(0, 8)) parts.push(`  • \`${m.remove}\` → \`${m.absorbed_into}\`: _${m.reason}_`);
  }
  parts.push(`\n_Review at \`lib/taxonomy/industries.js\` — open a PR to apply._`);
  return parts.join('\n');
}

function _formatExpertSourcesDiff(diff) {
  if (!diff) return '⚠️ Expert sources review failed to parse';
  const parts = [];
  parts.push(`🏆 *Expert brands taxonomy review*`);
  if (diff.summary) parts.push(`_${diff.summary}_`);
  if (Array.isArray(diff.additions) && diff.additions.length) {
    parts.push(`\n*+ ${diff.additions.length} suggested additions:*`);
    for (const a of diff.additions.slice(0, 8))
      parts.push(`  • *${a.name}* (${a.industry}/${a.region}): _${a.reason}_`);
  }
  if (Array.isArray(diff.removals) && diff.removals.length) {
    parts.push(`\n*− ${diff.removals.length} suggested removals:*`);
    for (const r of diff.removals.slice(0, 8)) parts.push(`  • *${r.name}* (${r.industry}): _${r.reason}_`);
  }
  parts.push(`\n_Review at \`lib/taxonomy/expert_sources.js\` — open a PR to apply._`);
  return parts.join('\n');
}

/**
 * Main entrypoint. Runs both reviews, posts results to Slack via alertRouter.
 *
 * Returns the diffs + dispatch result. NEVER mutates taxonomy files —
 * humans apply changes via PR after Slack review.
 */
async function refreshTaxonomy({ deps } = {}) {
  if (!deps?.callClaude || !deps?.alertRouter) {
    return { ok: false, reason: 'callClaude + alertRouter required' };
  }
  const { callClaude, alertRouter, logger } = deps;

  // ─── Pass 1: industries review ───────────────────────────────────────
  const industriesUser = [
    'Current industries (50 verticals):',
    ...industries.INDUSTRIES.map((i) => `  - ${i.id}: ${i.label}${i.parent ? ` (parent: ${i.parent})` : ''}`),
  ].join('\n');

  let industriesDiff = null;
  try {
    const raw = await callClaude({
      system: INDUSTRIES_REVIEW_SYSTEM_PROMPT,
      user: industriesUser,
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      extra: {
        skill: 'taxonomy_refresh_industries',
        skipBrandVoice: true,
        returnRaw: true,
      },
    });
    const text = typeof raw === 'string' ? raw : raw?._raw || raw?.text || '';
    industriesDiff = _parseDiff(text);
  } catch (e) {
    logger?.warn?.('taxonomy-refresh.industries', null, 'review failed', { error: e.message });
  }

  // ─── Pass 2: expert sources review ────────────────────────────────────
  const expertBrandsList = Object.entries(expertSources.EXPERT_BRANDS)
    .map(([industryId, brands]) =>
      brands.map((b) => `  - ${industryId} / ${b.name} (${b.region}, q${b.qualityScore})`).join('\n')
    )
    .join('\n');
  const expertSourcesUser = [
    `Current expert brand catalog (${Object.keys(expertSources.EXPERT_BRANDS).length} verticals):`,
    expertBrandsList,
  ].join('\n');

  let expertSourcesDiff = null;
  try {
    const raw = await callClaude({
      system: EXPERT_SOURCES_REVIEW_SYSTEM_PROMPT,
      user: expertSourcesUser,
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      extra: {
        skill: 'taxonomy_refresh_expert_sources',
        skipBrandVoice: true,
        returnRaw: true,
      },
    });
    const text = typeof raw === 'string' ? raw : raw?._raw || raw?.text || '';
    expertSourcesDiff = _parseDiff(text);
  } catch (e) {
    logger?.warn?.('taxonomy-refresh.expert_sources', null, 'review failed', { error: e.message });
  }

  // ─── Step 3: dispatch to Slack via alertRouter ────────────────────────
  // NOTE: severity = 'info' so Slack fires but no Email / PagerDuty. This
  // is a quarterly informational ping, not an incident.
  const industriesMessage = _formatIndustriesDiff(industriesDiff);
  const expertSourcesMessage = _formatExpertSourcesDiff(expertSourcesDiff);
  const combined = [industriesMessage, '', '────────', '', expertSourcesMessage].join('\n');

  let dispatchResult = null;
  try {
    dispatchResult = await alertRouter.alert({
      key: 'taxonomy-refresh-quarterly',
      severity: 'info',
      title: 'Quarterly taxonomy refresh proposals',
      message: combined,
      extra: { industries_diff: industriesDiff, expert_sources_diff: expertSourcesDiff },
    });
  } catch (e) {
    logger?.warn?.('taxonomy-refresh.alert', null, 'dispatch failed', { error: e.message });
  }

  logger?.info?.('taxonomy-refresh', null, 'completed', {
    industries_changes:
      (industriesDiff?.additions?.length || 0) +
      (industriesDiff?.removals?.length || 0) +
      (industriesDiff?.merges?.length || 0),
    expert_sources_changes: (expertSourcesDiff?.additions?.length || 0) + (expertSourcesDiff?.removals?.length || 0),
  });

  return {
    ok: true,
    industries_diff: industriesDiff,
    expert_sources_diff: expertSourcesDiff,
    alert_dispatched: dispatchResult,
  };
}

module.exports = {
  refreshTaxonomy,
  _parseDiff,
  _formatIndustriesDiff,
  _formatExpertSourcesDiff,
  INDUSTRIES_REVIEW_SYSTEM_PROMPT,
  EXPERT_SOURCES_REVIEW_SYSTEM_PROMPT,
};
