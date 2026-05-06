'use strict';

/**
 * services/cro/engine.js
 * ----------------------------------------------------------------------------
 * Orchestrator for CRO audit + rewrite. Pulls business profile, runs audit/
 * rewrite, persists.
 * ----------------------------------------------------------------------------
 */

const cro = require('../prompts/cro');

function createEngine(deps) {
  const { sbGet, sbPost, sbPatch, callClaude, extractJSON, logger, Sentry } = deps;
  if (!sbGet || !sbPost || !sbPatch) throw new Error('cro engine: sbGet/sbPost/sbPatch required');
  if (!callClaude || !extractJSON)     throw new Error('cro engine: callClaude + extractJSON required');

  async function audit({ businessId, html, text }) {
    const tx = Sentry?.startTransaction?.({ name: 'cro.audit' });
    try {
      const [bizRows, profileRows] = await Promise.all([
        sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
        sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
      ]);
      const business = { ...(bizRows[0] || {}), ...(profileRows[0] || {}) };
      if (!business?.id && !business?.user_id) throw new Error(`business ${businessId} not found`);

      const result = await cro.auditPage({
        business, html, text,
        plan: business.plan || 'free',
        callClaude, extractJSON, logger,
      });

      await sbPost('cro_audits', {
        business_id: businessId,
        audit_score: result.audit_score,
        dimension_scores: result.dimension_scores,
        critical_issues: result.critical_issues,
        warnings: result.warnings,
        opportunities: result.opportunities,
        primary_language: result.primary_language,
        country: result.country,
        current_estimated_conv_rate_band: result.current_estimated_conv_rate_band,
        expected_lift_band: result.expected_lift_band,
        citations: result.citations,
        short_circuited: !!result.short_circuited,
        short_circuit_reason: result.short_circuit_reason || null,
        plan_used: business.plan || 'free',
      }).catch((e) => logger?.warn?.('cro', businessId, 'persist failed', e));

      return result;
    } catch (e) {
      Sentry?.captureException?.(e);
      throw e;
    } finally {
      tx?.finish?.();
    }
  }

  async function rewrite({ businessId, currentHero }) {
    const [bizRows, profileRows] = await Promise.all([
      sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
    ]);
    const business = { ...(bizRows[0] || {}), ...(profileRows[0] || {}) };
    if (!business?.id && !business?.user_id) throw new Error(`business ${businessId} not found`);

    const result = await cro.rewritePage({
      business, currentHero,
      plan: business.plan || 'free',
      callClaude, extractJSON, logger,
    });

    await sbPost('cro_rewrites', {
      business_id: businessId,
      hero_headline_variants: result.hero_headline_variants,
      hero_subhead_variants: result.hero_subhead_variants,
      primary_cta_variants: result.primary_cta_variants,
      value_prop_bullets: result.value_prop_bullets,
      social_proof_template: result.social_proof_template,
      form_simplification: result.form_simplification,
      llm_used: !!result.llm_used,
      plan_used: business.plan || 'free',
    }).catch(() => {});

    return result;
  }

  return { audit, rewrite };
}

module.exports = createEngine;
