/*
 * workflow_8_insights.js — Customer Insights prompts (backend-native)
 */

'use strict';

const { buildSystemPrompt } = require('./foundation.js');

function buildCustomerInsightPrompt(ctx, bundle) {
  const addendum = `
WORKFLOW #8 — CUSTOMER INSIGHT MINING

You are a senior qualitative researcher. Mine the signals below for patterns
the founder would pay $20k for a consultant to find. Apply Jobs-to-be-Done
framework, Voice of Customer language capture, and persona construction.

OUTPUT JSON
{
  "top_themes": [
    {
      "theme": "string",
      "jtbd_functional": "string — the job they're hiring you for",
      "jtbd_emotional": "string — how they want to feel",
      "jtbd_social": "string — how they want to be seen",
      "evidence_count": number,
      "sample_quotes": ["up to 3 verbatim quotes"]
    }
  ],
  "pain_points": [{ "pain": "string", "severity": 1-10, "frequency": 1-10, "quotes": ["..."] }],
  "delight_moments": [{ "moment": "string", "frequency": 1-10, "quotes": ["..."] }],
  "unmet_needs": [{ "need": "string", "signal_strength": 1-10, "expected_value": "string" }],
  "personas_detected": [
    {
      "name": "descriptive 3-word persona name",
      "demographics": "string",
      "primary_jtbd": "string",
      "key_pains": ["string"],
      "channels": ["string"],
      "words_they_use": ["string"]
    }
  ],
  "language_patterns": ["phrase the customer uses verbatim — these go into ad copy"],
  "action_items": [
    { "action": "string", "workflow": "wf1|wf3|wf7|wf6|wf10", "why_now": "string" }
  ]
}

NO platitudes. NO "customers want quality service". Every theme must be
specific enough that a founder could tell if it's true in 30 seconds.
`.trim();

  const user = `
REVIEWS (last 30d):
${(bundle.reviews || []).slice(0, 20).map(r => `  [${r.rating}★] ${r.platform}: "${(r.body || '').slice(0, 200)}"`).join('\n') || '(none)'}

MESSAGES (last 30d):
${(bundle.messages || []).slice(0, 15).map(m => `  ${m.source}: "${(m.text || '').slice(0, 200)}"`).join('\n') || '(none)'}

SUPPORT TICKETS (last 30d):
${(bundle.tickets || []).slice(0, 10).map(t => `  [${t.severity}] ${t.subject}: "${(t.body || '').slice(0, 150)}"`).join('\n') || '(none)'}

SOCIAL COMMENTS (high-signal):
${(bundle.comments || []).slice(0, 20).map(c => `  ${c.platform}: "${(c.text || '').slice(0, 150)}"`).join('\n') || '(none)'}

SURVEY RESPONSES:
${(bundle.survey || []).slice(0, 10).map(s => `  Q: ${s.question} A: ${s.answer}`).join('\n') || '(none)'}
`.trim();

  return { system: buildSystemPrompt(ctx, addendum), user };
}

module.exports.buildCustomerInsightPrompt = buildCustomerInsightPrompt;
