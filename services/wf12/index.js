/*
 * services/wf12/index.js — Launch Orchestrator engine
 */

'use strict';

const { buildLaunchPlanPrompt } = require('../prompts/workflow_12_launch.js');
const { buildBrandContext } = require('../wf1/brandContext.js');

function createWf12(deps) {
  const { sbGet, sbPost, sbPatch, callClaude, extractJSON, logger } = deps;

  async function resolveBrandContext(businessId) {
    const [b, p] = await Promise.all([
      sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
    ]);
    if (!b[0]) throw new Error('Business not found');
    return buildBrandContext({ business: b[0], profile: p[0] || {} });
  }

  async function planLaunch({ businessId, request }) {
    const brandContext = await resolveBrandContext(businessId);
    const { system, user } = buildLaunchPlanPrompt(brandContext, request);
    const raw = await callClaude(user, 'claude-opus-4-5', 4500, { system, businessId, returnRaw: true });
    const plan = extractJSON(raw) || {};

    const launchRow = await sbPost('launches', {
      business_id: businessId,
      name: plan.launch_name || request.name || 'Launch',
      launch_type: request.launchType,
      launch_date: request.launchDate,
      plan,
      budget_allocation: plan.budget_allocation || {},
      status: 'planning',
    });

    // Persist individual activities
    for (const phase of plan.phases || []) {
      for (const activity of phase.key_activities || []) {
        await sbPost('launch_activities', {
          launch_id: launchRow.id,
          business_id: businessId,
          phase: phase.phase,
          activity: activity.activity,
          channel: activity.channel,
          owner: activity.owner,
          effort_days: activity.effort_days,
          status: 'pending',
        }).catch(() => {});
      }
    }

    return { launchId: launchRow.id, plan };
  }

  async function updateActivityStatus({ businessId, activityId, status }) {
    await sbPatch('launch_activities', `id=eq.${activityId}&business_id=eq.${businessId}`, {
      status,
      completed_at: status === 'completed' ? new Date().toISOString() : null,
    });
    return { ok: true };
  }

  async function listLaunches(businessId) {
    const rows = await sbGet('launches', `business_id=eq.${businessId}&order=created_at.desc&select=*&limit=20`).catch(() => []);
    return { items: rows };
  }

  async function getLaunchDetail({ businessId, launchId }) {
    const [launchRows, activities] = await Promise.all([
      sbGet('launches', `id=eq.${launchId}&business_id=eq.${businessId}&select=*`),
      sbGet('launch_activities', `launch_id=eq.${launchId}&order=created_at.asc&select=*`),
    ]);
    return { launch: launchRows[0] || null, activities };
  }

  return { planLaunch, updateActivityStatus, listLaunches, getLaunchDetail, resolveBrandContext };
}

module.exports = createWf12;
