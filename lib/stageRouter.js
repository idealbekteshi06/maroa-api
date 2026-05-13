'use strict';

/**
 * lib/stageRouter.js
 * ---------------------------------------------------------------------------
 * Routes generation requests through the 20-cell awareness × funnel matrix.
 * Wave 60 Session 2.
 *
 * Every customer-facing generation should first call routeContent() to get:
 *   - which methodologies (from the Wave 60 S1 registry) to apply
 *   - which CTA style + tone are appropriate
 *   - which manipulation_risk ceiling applies to this cell
 *   - which channels are best-fit for this awareness+funnel combo
 *   - refusals if the cell is invalid (e.g. unaware × bofu)
 *
 * The router is pure logic — no I/O, no LLM calls. The optional
 * detectStage() helper can probe via callClaude when the caller doesn't
 * know which awareness stage to target.
 *
 * Public API:
 *   routeContent({ awareness, funnel, channel?, industry? })
 *     → { ok, methodologies, cta_style, tone, max_manip_risk,
 *         max_length_hint, channel_priority, refusal? }
 *
 *   detectStage({ customer_history?, current_content?, callClaude? })
 *     → { awareness, funnel, confidence, source: 'heuristic'|'llm' }
 *
 * Wired into: services/creative-engine/index.js (S2), services/wf1/engine.js
 * via dep injection so tests can stub.
 * ---------------------------------------------------------------------------
 */

const { MATRIX, AWARENESS_STAGES, FUNNEL_STAGES } = require('../services/prompts/stage-rules');
const schwartz = require('../services/prompts/methodologies/psychology/schwartz-5-stages');
const channels = require('../services/prompts/channels');

/**
 * Cell key for matrix lookup.
 */
function _cellKey(awareness, funnel) {
  return `${awareness}:${funnel}`;
}

/**
 * Main routing entrypoint. Returns the configuration for the given
 * (awareness, funnel) cell, optionally narrowed by channel + industry.
 *
 * Invalid cells (e.g. unaware × retention) return { ok: false, refusal }.
 */
function routeContent({ awareness, funnel, channel, industry } = {}) {
  if (!AWARENESS_STAGES.includes(awareness)) {
    return { ok: false, refusal: `invalid awareness "${awareness}"; expected one of ${AWARENESS_STAGES.join(', ')}` };
  }
  if (!FUNNEL_STAGES.includes(funnel)) {
    return { ok: false, refusal: `invalid funnel "${funnel}"; expected one of ${FUNNEL_STAGES.join(', ')}` };
  }

  const cell = MATRIX[_cellKey(awareness, funnel)];
  if (!cell) {
    return { ok: false, refusal: `no rule for cell ${awareness}×${funnel}` };
  }
  if (cell.invalid) {
    return { ok: false, refusal: cell.reason, invalid_cell: true };
  }

  // If a channel was requested, verify it's reasonable for this cell.
  // We don't refuse — we just surface a warning so the caller can decide.
  const warnings = [];
  if (channel && !cell.channel_priority.includes(channel)) {
    warnings.push(
      `channel "${channel}" is not in the priority list for ${awareness}×${funnel}: ` +
        `${cell.channel_priority.slice(0, 3).join(', ')}`
    );
  }

  // Surface channel-native format guidance when a specific channel is
  // requested. Falls back to the cell's top-priority channel if none was
  // supplied — keeps the prompt actionable.
  const effectiveChannel = channel || (cell.channel_priority && cell.channel_priority[0]) || null;
  let channelGuidance = null;
  if (effectiveChannel) {
    const mod = channels.getChannel(effectiveChannel);
    if (mod && mod !== channels.NULL_MODULE) {
      channelGuidance = {
        id: mod.id,
        name: mod.name,
        category: mod.category,
        surface_type: mod.surface_type,
        prompt_segments: channels.getChannelPromptSegments(effectiveChannel, { industry }),
      };
    }
  }

  return {
    ok: true,
    awareness,
    funnel,
    channel: effectiveChannel,
    industry,
    methodologies: cell.recommended_frameworks,
    cta_style: cell.cta_style,
    tone: cell.tone,
    max_manip_risk: cell.max_manip_risk,
    max_length_hint: cell.max_length_hint,
    channel_priority: cell.channel_priority,
    channel_guidance: channelGuidance,
    notes: cell.notes,
    warnings,
  };
}

/**
 * Detect awareness + funnel stage from light context.
 *
 * Heuristic-only path (no LLM): inspects customer_history (number of
 * sessions, conversions) + current_content (Schwartz signals) to make
 * a best guess. Returns confidence so callers can decide whether to
 * trust it.
 *
 * If callClaude is provided AND heuristic confidence is < 0.6, runs a
 * Haiku probe with the customer history to refine.
 *
 * @param {object} args
 * @param {object} [args.customer_history] — { sessions, conversions,
 *                                              is_existing_customer,
 *                                              last_purchase_days_ago }
 * @param {string} [args.current_content]  — the draft or seed text
 * @param {function} [args.callClaude]     — optional, for ambiguous cases
 */
async function detectStage({ customer_history, current_content, callClaude } = {}) {
  // ─── Heuristic pass ──────────────────────────────────────────────────
  let awareness = null;
  let funnel = null;
  let confidence = 0;

  if (customer_history) {
    // Existing customer = most_aware + retention
    if (customer_history.is_existing_customer || customer_history.last_purchase_days_ago != null) {
      awareness = 'most_aware';
      funnel = 'retention';
      confidence = 0.9;
    } else if ((customer_history.sessions || 0) >= 3 && (customer_history.conversions || 0) === 0) {
      // Multiple visits, no buy → product_aware + bofu
      awareness = 'product_aware';
      funnel = 'bofu';
      confidence = 0.7;
    } else if ((customer_history.sessions || 0) >= 1) {
      awareness = 'solution_aware';
      funnel = 'mofu';
      confidence = 0.5;
    } else {
      // First-time visitor
      awareness = 'problem_aware';
      funnel = 'tofu';
      confidence = 0.4;
    }
  }

  // If we have current_content, let Schwartz's detector vote
  if (current_content) {
    const det = schwartz.detectStage(current_content);
    if (det.dominant && det.confidence > 0.5) {
      // Schwartz wins if it has stronger confidence than the heuristic
      if (det.confidence > confidence) {
        awareness = det.dominant;
        confidence = det.confidence;
      }
    }
  }

  // ─── LLM refinement for ambiguous cases ──────────────────────────────
  if (callClaude && confidence < 0.6 && customer_history) {
    try {
      const ctx = JSON.stringify(customer_history);
      const raw = await callClaude({
        system: `You are a marketing stage classifier. Given customer history JSON, output ONLY this JSON:
{"awareness":"unaware|problem_aware|solution_aware|product_aware|most_aware","funnel":"tofu|mofu|bofu|retention","confidence":0..1}
Use stage definitions from Eugene Schwartz, "Breakthrough Advertising" (1966).`,
        user: `Customer history: ${ctx}\n\nCurrent content: ${current_content || '(none)'}`,
        model: 'claude-haiku-4-5',
        max_tokens: 100,
        extra: { skill: 'stage_detection', skipBrandVoice: true, returnRaw: true },
      });
      const text = typeof raw === 'string' ? raw : raw?._raw || raw?.text || '';
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const parsed = JSON.parse(m[0]);
          if (
            AWARENESS_STAGES.includes(parsed.awareness) &&
            FUNNEL_STAGES.includes(parsed.funnel) &&
            typeof parsed.confidence === 'number' &&
            parsed.confidence > confidence
          ) {
            return {
              awareness: parsed.awareness,
              funnel: parsed.funnel,
              confidence: parsed.confidence,
              source: 'llm',
            };
          }
        } catch {
          /* fall through */
        }
      }
    } catch {
      /* LLM probe failed — return heuristic result */
    }
  }

  // Safe defaults if nothing detected
  if (!awareness) awareness = 'problem_aware';
  if (!funnel) funnel = 'tofu';

  return {
    awareness,
    funnel,
    confidence,
    source: 'heuristic',
  };
}

/**
 * Convenience helper: detect + route in one call. Returns the route
 * result with the detected stages attached for transparency.
 */
async function detectAndRoute({ customer_history, current_content, channel, industry, callClaude } = {}) {
  const det = await detectStage({ customer_history, current_content, callClaude });
  const route = routeContent({ awareness: det.awareness, funnel: det.funnel, channel, industry });
  return { ...route, detection: det };
}

module.exports = {
  routeContent,
  detectStage,
  detectAndRoute,
  AWARENESS_STAGES,
  FUNNEL_STAGES,
  // Re-export for convenience — callers wiring full prompts don't need to
  // double-require channels.
  channels,
};
