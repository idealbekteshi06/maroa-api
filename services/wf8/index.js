/*
 * services/wf8/index.js — Customer Insights engine
 */

'use strict';

const { buildCustomerInsightPrompt } = require('../prompts/workflow_8_insights.js');
const { buildBrandContext } = require('../wf1/brandContext.js');

function createWf8(deps) {
  const { sbGet, sbPost, callClaude, extractJSON, logger } = deps;

  async function resolveBrandContext(businessId) {
    const [b, p] = await Promise.all([
      sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
    ]);
    if (!b[0]) throw new Error('Business not found');
    return buildBrandContext({ business: b[0], profile: p[0] || {} });
  }

  async function gatherBundle(businessId) {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const [reviews, messages] = await Promise.all([
      sbGet('reviews', `business_id=eq.${businessId}&created_at=gte.${encodeURIComponent(since)}&select=rating,platform,body,sentiment&limit=50`).catch(() => []),
      sbGet('inbox_threads', `business_id=eq.${businessId}&created_at=gte.${encodeURIComponent(since)}&select=channel,body,classification&limit=40`).catch(() => []),
    ]);
    return {
      reviews,
      messages: messages.map(m => ({ source: m.channel, text: m.body })),
      tickets: [],
      comments: [],
      survey: [],
    };
  }

  async function generateInsightReport({ businessId }) {
    const brandContext = await resolveBrandContext(businessId);
    const bundle = await gatherBundle(businessId);
    const { system, user } = buildCustomerInsightPrompt(brandContext, bundle);
    const raw = await callClaude(user, 'claude-opus-4-5', 4000, { system, businessId, returnRaw: true });
    const parsed = extractJSON(raw) || {};
    const row = await sbPost('insight_reports', {
      business_id: businessId,
      top_themes: parsed.top_themes || [],
      pain_points: parsed.pain_points || [],
      delight_moments: parsed.delight_moments || [],
      unmet_needs: parsed.unmet_needs || [],
      personas: parsed.personas_detected || [],
      language_patterns: parsed.language_patterns || [],
      action_items: parsed.action_items || [],
      window_start: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
      window_end: new Date().toISOString().slice(0, 10),
    });
    return { reportId: row.id, ...parsed };
  }

  async function getLatestReport(businessId) {
    const rows = await sbGet('insight_reports', `business_id=eq.${businessId}&order=created_at.desc&limit=1&select=*`).catch(() => []);
    return rows[0] || null;
  }

  return { generateInsightReport, getLatestReport, gatherBundle, resolveBrandContext };
}

module.exports = createWf8;
