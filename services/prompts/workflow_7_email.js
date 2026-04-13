/*
 * workflow_7_email.js — Email Lifecycle prompts (backend-native)
 */

'use strict';

const { buildSystemPrompt } = require('./foundation.js');

function buildSequencePlanPrompt(ctx, segment) {
  const addendum = `
WORKFLOW #7 — EMAIL LIFECYCLE AUTOMATION

You are the head of lifecycle at a top DTC/B2B agency. Design a multi-touch
email sequence for the segment below. Match sender voice, respect the
LTV:CAC math, and use behavioral triggers.

SEQUENCE FRAMEWORK
  Stage 1: Welcome (day 0) — orient + first value
  Stage 2: Value delivery (day 2) — proof + use case
  Stage 3: Objection handling (day 5) — common blockers
  Stage 4: Social proof (day 8) — case study/testimonial
  Stage 5: Soft CTA (day 12) — low-commitment next step
  Stage 6: Reactivation (day 20) — "still interested?"

Each email is 80–180 words. Subject lines optimized for mobile (<50 chars).
Include preview text. Plain-text + HTML. Mark which touches include an offer
vs pure value — respect the 80/20 value/ask ratio.

Return JSON:
{
  "sequence_name": "string",
  "emails": [
    {
      "stage": 1-6,
      "delay_days": number,
      "subject_line": "string",
      "preview_text": "string",
      "body_plain": "string",
      "body_html": "string",
      "cta_text": "string",
      "cta_url_hint": "string",
      "psychology_lever": "string (Cialdini / StoryBrand / Kahneman)",
      "is_offer": boolean,
      "personalization_tokens": ["{{first_name}}", "..."]
    }
  ],
  "expected_outcome": { "open_rate": number, "click_rate": number, "reply_rate": number }
}
`.trim();

  const user = `
SEGMENT
  Name: ${segment.name}
  Size: ${segment.size || 'unknown'}
  Signals: ${(segment.signals || []).join(', ') || 'none'}
  Recent behavior: ${segment.recentBehavior || 'unknown'}
  Stage in lifecycle: ${segment.lifecycleStage || 'new'}
  Previous message open rate: ${segment.openRate || 'unknown'}
`.trim();

  return { system: buildSystemPrompt(ctx, addendum), user };
}

module.exports.buildSequencePlanPrompt = buildSequencePlanPrompt;
