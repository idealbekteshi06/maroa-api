/*
 * workflow_5_competitors.js — Competitor Intelligence prompt (backend-native)
 */

'use strict';

const { buildSystemPrompt } = require('./foundation.js');

function buildCompetitorAnalysisPrompt(ctx, bundle) {
  const addendum = `
WORKFLOW #5 — COMPETITOR INTELLIGENCE

You are the senior competitive strategist. ${ctx.businessName} (${ctx.industry})
competes against the players below. Your job: produce a weekly intelligence
brief that's actually actionable — not a data dump.

FRAMEWORK
  - Position on Porter's 5 Forces: where is each competitor weakest/strongest?
  - Blue Ocean: what's the underserved segment?
  - Movement analysis: velocity of change matters more than absolute position

BRIEF STRUCTURE (JSON, required)
{
  "summary": "one-paragraph state of competitive landscape",
  "competitors": [
    {
      "name": "string",
      "posture_change": "scaling|defending|pivoting|quiet|retreating",
      "key_move_this_week": "1 sentence",
      "evidence": ["data points"],
      "threat_level": "low|medium|high|critical",
      "our_counter": "what we should do — specific action",
      "counter_framework": "which framework lever"
    }
  ],
  "market_shifts": ["shift 1", "shift 2"],
  "white_space_opportunities": [
    { "opportunity": "string", "why_now": "string", "difficulty": "easy|medium|hard" }
  ],
  "recommended_actions": [
    { "action": "string", "expected_impact": "string", "effort_days": number, "requires_approval": boolean }
  ],
  "frameworks_cited": ["string"]
}

NON-NEGOTIABLE
- Every claim tied to a specific piece of evidence (post, ad, page, pricing).
- Never recommend naming competitors in public-facing copy (legal/brand risk).
- Respect the LTV:CAC math on any counter-move involving spend.
`.trim();

  const user = `
COMPETITOR DATA (last 7 days):
${(bundle.competitors || []).map(c => `  ${c.name} (${c.url || 'no url'})
    recent posts: ${(c.posts || []).slice(0, 3).map(p => `"${p.title || ''}" eng=${p.engagement || 0}`).join(' | ') || '(none)'}
    active ads: ${(c.ads || []).length}
    price signals: ${c.pricing || 'unchanged'}
    sentiment: ${c.sentiment || 'flat'}
`).join('\n') || '(no competitors tracked)'}

OUR WEEK:
  content published: ${bundle.ourPosts ?? 0}
  ad spend: $${bundle.ourSpend ?? 0}
  pipeline: ${bundle.ourPipeline ?? 'stable'}

MARKET NEWS:
${(bundle.newsCycle || []).map(n => `  ${n.headline} (${n.source})`).join('\n') || '(none)'}
`.trim();

  return { system: buildSystemPrompt(ctx, addendum), user };
}

module.exports.buildCompetitorAnalysisPrompt = buildCompetitorAnalysisPrompt;
