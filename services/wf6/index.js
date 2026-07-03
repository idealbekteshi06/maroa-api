/*
 * services/wf6/index.js — Local + Digital Presence engine (PARTIALLY DEPRECATED)
 *
 * @deprecated for AI-SEO / schema-markup / AI-search-readiness audits — those
 * overlap the canonical services/ai-seo (/api/ai-seo, ai_seo_audits +
 * ai_seo_artifacts). See CANONICAL_WORKFLOWS.md. Do NOT build new SEO/schema
 * features here.
 *
 * RETAINED (not yet superseded): the unique Google Business Profile /
 * local-presence audit (gbpSnapshot.js, local_rank, NAP). Folding that into
 * ai-seo as a "Local Presence" dimension is a scoped follow-up — see
 * CANONICAL_WORKFLOWS.md.
 */

'use strict';

const { buildPresenceAuditPrompt, buildSchemaGenerationPrompt } = require('../prompts/workflow_6_presence.js');
const { buildBrandContext } = require('../wf1/brandContext.js');
const { fetchGbpSnapshot } = require('./gbpSnapshot.js');

function createWf6(deps) {
  const { sbGet, sbPost, sbPatch, callClaude, extractJSON, logger } = deps;

  async function resolveBrandContext(businessId) {
    const [b, p] = await Promise.all([
      sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
    ]);
    if (!b[0]) throw new Error('Business not found');
    return buildBrandContext({ business: b[0], profile: p[0] || {} });
  }

  async function runAudit({ businessId, auditInput = {} }) {
    const brandContext = await resolveBrandContext(businessId);
    const biz = brandContext.business || {};
    const gbpLive = await fetchGbpSnapshot({
      placeId: auditInput.placeId || biz.google_place_id,
      businessName: biz.business_name,
      city: biz.city || biz.location,
    }).catch(() => null);

    const audit = {
      gbpLive,
      gbpFields: auditInput.gbpFields || (gbpLive ? ['name', 'rating', 'website', 'address'] : []),
      gbpCategories: auditInput.gbpCategories || 'unknown',
      gbpPosts: auditInput.gbpPosts || 0,
      schemaDetected: auditInput.schemaDetected || [],
      citationCount: auditInput.citationCount || 0,
      napInconsistencies: auditInput.napInconsistencies || [],
      keywords: auditInput.keywords || [],
    };
    const { system, user } = buildPresenceAuditPrompt(brandContext, audit);
    const raw = await callClaude(user, 'claude-sonnet-5', 2500, { system, businessId, returnRaw: true });
    const parsed = extractJSON(raw) || {};
    const row = await sbPost('presence_audits', {
      business_id: businessId,
      overall_score: parsed.overall_score || 0,
      gbp: parsed.gbp || {},
      schema_markup: parsed.schema_markup || {},
      citations: parsed.citations || {},
      local_rank: parsed.local_rank || {},
      remediation_plan: parsed.remediation_plan || [],
      quick_wins: parsed.quick_wins_this_week || [],
    });
    return { auditId: row.id, ...parsed };
  }

  async function generateSchema({ businessId, page }) {
    const brandContext = await resolveBrandContext(businessId);
    const { system, user } = buildSchemaGenerationPrompt(brandContext, page);
    const raw = await callClaude(user, 'claude-sonnet-5', 1500, { system, businessId, returnRaw: true });
    const parsed = extractJSON(raw);
    if (!parsed) throw new Error('Schema generation returned invalid JSON');
    const row = await sbPost('schema_markup_generated', {
      business_id: businessId,
      page_url: page.url || null,
      schema_type: parsed['@type'] || 'Unknown',
      json_ld: parsed,
    });
    return { schemaId: row.id, jsonLd: parsed };
  }

  async function getLatestAudit(businessId) {
    const rows = await sbGet(
      'presence_audits',
      `business_id=eq.${businessId}&order=audit_run_at.desc&limit=1&select=*`
    ).catch(() => []);
    return rows[0] || null;
  }

  return { runAudit, generateSchema, getLatestAudit, resolveBrandContext };
}

module.exports = createWf6;
