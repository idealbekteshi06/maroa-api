'use strict';

/**
 * services/ai-seo/engine.js
 * ----------------------------------------------------------------------------
 * Orchestrator for AI-SEO audit + generation.
 *
 *   audit(businessId, html?, text?, llms_txt_present?, llms_full_txt_present?)
 *   generate(businessId, pages?)
 *
 * Pulls business profile from Supabase, runs auditSite / generateArtifacts,
 * persists the result.
 * ----------------------------------------------------------------------------
 */

const aiSeo = require('../prompts/ai-seo');

function createEngine(deps) {
  const { sbGet, sbPost, sbPatch, callClaude, extractJSON, logger, Sentry } = deps;
  if (!sbGet || !sbPost || !sbPatch) throw new Error('ai-seo engine: sbGet/sbPost/sbPatch required');
  if (!callClaude || !extractJSON)     throw new Error('ai-seo engine: callClaude + extractJSON required');

  async function auditOne({ businessId, html, text, llms_txt_present, llms_full_txt_present }) {
    const tx = Sentry?.startTransaction?.({ name: 'ai-seo.auditOne' });
    Sentry?.addBreadcrumb?.({ category: 'ai-seo', message: 'auditOne', data: { businessId } });
    try {
      const [bizRows, profileRows] = await Promise.all([
        sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
        sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
      ]);
      const business = { ...(bizRows[0] || {}), ...(profileRows[0] || {}) };
      if (!business?.id && !business?.user_id) throw new Error(`business ${businessId} not found`);

      const audit = await aiSeo.auditSite({
        business,
        html, text,
        llms_txt_present,
        llms_full_txt_present,
        plan: business.plan || 'free',
        callClaude, extractJSON, logger,
      });

      // Persist
      await sbPost('ai_seo_audits', {
        business_id: businessId,
        audit_score: audit.audit_score,
        dimension_scores: audit.dimension_scores,
        critical_gaps: audit.critical_gaps,
        warnings: audit.warnings,
        opportunities: audit.opportunities,
        ai_search_readiness: audit.ai_search_readiness,
        estimated_citation_potential: audit.estimated_citation_potential,
        primary_language: audit.primary_language,
        country: audit.country,
        citations: audit.citations,
        short_circuited: !!audit.short_circuited,
        short_circuit_reason: audit.short_circuit_reason || null,
        plan_used: business.plan || 'free',
      }).catch((e) => logger?.warn?.('ai-seo', businessId, 'persist failed', e));

      return audit;
    } catch (e) {
      Sentry?.captureException?.(e);
      throw e;
    } finally {
      tx?.finish?.();
    }
  }

  async function generate({ businessId, pages = [] }) {
    const [bizRows, profileRows] = await Promise.all([
      sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
    ]);
    const business = { ...(bizRows[0] || {}), ...(profileRows[0] || {}) };
    if (!business?.id && !business?.user_id) throw new Error(`business ${businessId} not found`);

    const result = await aiSeo.generateArtifacts({
      business, pages,
      plan: business.plan || 'free',
      callClaude, extractJSON, logger,
    });

    await sbPost('ai_seo_artifacts', {
      business_id: businessId,
      llms_txt: result.llms_txt,
      llms_full_txt: result.llms_full_txt,
      schema_blocks: result.schema_blocks,
      page_rewrites: result.page_rewrites,
      internal_link_suggestions: result.internal_link_suggestions,
      llm_used: !!result.llm_used,
      plan_used: business.plan || 'free',
    }).catch((e) => logger?.warn?.('ai-seo', businessId, 'persist artifacts failed', e));

    return result;
  }

  return { auditOne, generate };
}

module.exports = createEngine;
