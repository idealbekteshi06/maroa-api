/*
 * workflow_12_launch.js — Launch Orchestrator prompts (backend-native)
 */

'use strict';

const { buildSystemPrompt } = require('./foundation.js');

function buildLaunchPlanPrompt(ctx, req) {
  const addendum = `
WORKFLOW #12 — LAUNCH CAMPAIGN ORCHESTRATOR

You are the senior launch strategist at a top agency. Build a multi-phase
launch plan for ${ctx.businessName}'s upcoming ${req.launchType}.

PHASES (always include)
  1. PRE-LAUNCH (weeks -4 to -1): tease + interest list + influencer seeding
  2. LAUNCH WEEK (week 0): announcement + PR + ads on + email drop + social storm
  3. POST-LAUNCH (weeks +1 to +2): retargeting + social proof + reviews
  4. MOMENTUM (weeks +3 to +4): category education + SEO content + expansion

FRAMEWORK
  - Eugene Schwartz 5 Stages of Awareness (unaware → most aware)
  - Cialdini scarcity for pre-launch list building
  - StoryBrand hero's journey over the full arc

OUTPUT JSON
{
  "launch_name": "string",
  "one_line_positioning": "string",
  "story_arc": "3-4 sentences — what's the emotional narrative over 8 weeks",
  "phases": [
    {
      "phase": "pre_launch|launch_week|post_launch|momentum",
      "week_start_offset": number,
      "goals": ["string"],
      "key_activities": [
        {
          "activity": "string",
          "channel": "instagram|tiktok|email|blog|pr|ads",
          "owner": "ai|human",
          "effort_days": number,
          "deliverables": ["string"]
        }
      ],
      "metrics_to_watch": ["string"]
    }
  ],
  "budget_allocation": {
    "organic_effort_hours": number,
    "paid_spend_usd": number,
    "influencer_spend_usd": number,
    "total_usd": number
  },
  "risks": [{ "risk": "string", "mitigation": "string" }],
  "frameworks_cited": ["string"]
}
`.trim();

  const user = `
LAUNCH REQUEST
  Type: ${req.launchType}
  Name: ${req.name}
  Description: ${req.description}
  Launch date: ${req.launchDate}
  Target audience: ${req.audience}
  Budget ceiling: $${req.budget || 'flexible'}
  Goals: ${(req.goals || []).join(', ') || 'none specified'}
`.trim();

  return { system: buildSystemPrompt(ctx, addendum), user };
}

module.exports.buildLaunchPlanPrompt = buildLaunchPlanPrompt;
