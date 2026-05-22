'use strict';

/**
 * services/deep-dive/index.js
 * Agency-tier async marketing research via Claude Managed Agents (beta).
 */

const DEEP_DIVE_AGENT_EXTERNAL_ID = 'maroa_marketing_deep_dive_v1';

function createDeepDiveService({ managedAgentService, sbGet, sbPost, logger }) {
  if (!managedAgentService) throw new Error('deep-dive: managedAgentService required');

  async function assertAgencyPlan(businessId) {
    const rows = await sbGet('businesses', `id=eq.${encodeURIComponent(businessId)}&select=plan,is_active`).catch(
      () => []
    );
    const biz = rows[0];
    if (!biz) return { ok: false, reason: 'business_not_found' };
    if (!biz.is_active) return { ok: false, reason: 'business_inactive' };
    if (String(biz.plan || '').toLowerCase() !== 'agency') {
      return { ok: false, reason: 'agency_plan_required' };
    }
    return { ok: true, plan: biz.plan };
  }

  async function runMarketingDeepDive({ businessId, brief, context = {} }) {
    const gate = await assertAgencyPlan(businessId);
    if (!gate.ok) return gate;

    const [bizRows, profileRows] = await Promise.all([
      sbGet('businesses', `id=eq.${encodeURIComponent(businessId)}&select=*`).catch(() => []),
      sbGet('business_profiles', `user_id=eq.${encodeURIComponent(businessId)}&select=*`).catch(() => []),
    ]);
    const business = { ...(bizRows[0] || {}), ...(profileRows[0] || {}) };

    const instructions = [
      'You are Maroa.ai marketing research lead for an SMB.',
      'Produce: executive summary, competitor implications, 3 campaign angles, channel plan, risks.',
      'Use web search for live market context. Cite sources. JSON block at end: { summary, angles[], risks[] }.',
      `Business: ${business.business_name || 'unknown'} | Industry: ${business.industry || 'general'}`,
      `Location: ${business.location || business.country || 'n/a'} | Goal: ${business.marketing_goal || 'growth'}`,
    ].join('\n');

    const mcpServers = [];
    const tunnelUrl = process.env.MAROA_MCP_TUNNEL_URL;
    if (tunnelUrl) {
      mcpServers.push({
        type: 'url',
        url: tunnelUrl,
        name: 'maroa_internal',
        authorization_token: process.env.MAROA_MCP_TUNNEL_TOKEN || undefined,
      });
    } else if (process.env.MAROA_MCP_SERVER_URL) {
      mcpServers.push({ type: 'url', url: process.env.MAROA_MCP_SERVER_URL, name: 'maroa_mcp' });
    }

    const agent = await managedAgentService.ensureAgent({
      externalId: `${DEEP_DIVE_AGENT_EXTERNAL_ID}_${businessId}`.slice(0, 120),
      name: `Maroa Deep Dive — ${business.business_name || businessId}`.slice(0, 80),
      instructions,
      model: 'claude-opus-4-7',
      tools: [{ type: 'agent_toolset_20260401' }],
      mcp_servers: mcpServers.length ? mcpServers : undefined,
      metadata: { maroa_feature: 'marketing_deep_dive', mcp_tunnel: !!tunnelUrl },
    });

    const agentId = agent.id || agent.agent_id;
    const userMessage = [
      brief || 'Run a full marketing deep dive for this business.',
      '',
      'Context:',
      JSON.stringify(context, null, 2).slice(0, 12000),
    ].join('\n');

    const session = await managedAgentService.runSession({
      agentId,
      message: userMessage,
      businessId,
    });

    const sessionId = session.id || session.session_id;
    const output =
      session.output?.content?.[0]?.text ||
      session.message?.content ||
      session.result ||
      session;

    if (sbPost) {
      await sbPost('events', {
        business_id: businessId,
        kind: 'marketing.deep_dive.completed',
        workflow: 'deep_dive',
        payload: { session_id: sessionId, agent_id: agentId },
        severity: 'info',
      }).catch(() => {});
    }

    return {
      ok: true,
      business_id: businessId,
      session_id: sessionId,
      agent_id: agentId,
      output,
    };
  }

  return { runMarketingDeepDive, assertAgencyPlan, DEEP_DIVE_AGENT_EXTERNAL_ID };
}

module.exports = { createDeepDiveService };
