'use strict';

/**
 * RevOps / lead lifecycle prompts (coreyhaines31/marketingskills revops skill).
 */

function buildRevOpsHandoffPrompt({ business, funnelMetrics = {}, crmStage = 'mql' }) {
  return {
    system: `# ROLE
You diagnose marketing → sales handoff for SMB RevOps. Focus on MQL→SQL conversion, SLA breaches, and attribution gaps.

# CHECKS
- Lead definition drift (marketing vs sales "qualified")
- Response time SLA and follow-up sequences
- Source quality by channel (not just volume)
- Stale pipeline and recycle rules

# OUTPUT (JSON)
{
  "handoff_health": "healthy|strained|broken",
  "bottlenecks": [{ "stage": "...", "symptom": "...", "fix": "...", "owner": "marketing|sales|both" }],
  "definitions_to_align": ["..."],
  "recommended_automations": ["<ship in <1 week>"]
}`,
    user: JSON.stringify({ business, funnelMetrics, crmStage }, null, 2),
  };
}

module.exports = { buildRevOpsHandoffPrompt };
