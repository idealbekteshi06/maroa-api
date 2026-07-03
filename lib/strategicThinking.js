'use strict';

/**
 * lib/strategicThinking.js
 * ---------------------------------------------------------------------------
 * Opt-in chain-of-thought wrapper for high-stakes generations.
 *
 * The pattern: force the model to write a structured strategic breakdown
 * BEFORE the final output. Empirically improves output quality on tasks
 * where:
 *   - The decision involves choosing between options
 *   - The output must respect multiple constraints
 *   - The model would otherwise rush to an obvious answer
 *
 * NOT in core callClaude (intentional). Per CLAUDE.md Rule 6 + ADR-0005:
 * deploying chain-of-thought globally would double token costs on simple
 * classification calls. Use this wrapper ONLY where reasoning quality
 * matters more than cost.
 *
 * Two execution modes (auto-selected):
 *
 *   Native extended-thinking (Sonnet 4.5+, Opus 4.7+): the model thinks
 *   in dedicated reasoning tokens that don't appear in the output. We
 *   pass `extra.thinking: { type: 'enabled', budget_tokens: ... }` and
 *   take just the final text. Best signal, no output pollution.
 *
 *   Tag-prompted fallback (older models): we prepend instructions to
 *   write the strategic plan inside `<strategy>...</strategy>` tags
 *   first, then the final output. We post-process to split them.
 *
 * Public API:
 *
 *   const { strategy, output, mode } = await strategize({
 *     callClaude,
 *     system,
 *     user,
 *     model: 'claude-sonnet-5',   // optional, defaults to sonnet
 *     max_tokens: 2000,
 *     businessId, skill,
 *     thinkingBudget: 1500,           // tokens reserved for strategy block
 *     forceTagMode: false,            // override auto-selection (test only)
 *   });
 *
 * The `strategy` field is what the model planned before writing. The
 * `output` is the actual deliverable. Callers ship `output`; they can
 * log `strategy` for debugging / "show your work" features.
 *
 * Where to use this:
 *   - Phase 2 of wf1 (strategic decision — already Opus)
 *   - N-best judge (rank with reasoning)
 *   - Critic rewrite step (plan the rewrite before writing)
 *   - Launch campaigns (multi-phase ORB plan)
 *   - CRO audit recommendations (multi-constraint reasoning)
 *
 * Where NOT to use it:
 *   - Hashtag generation
 *   - Single-line CTA writing
 *   - Classification calls (intent detection, etc.)
 *   - Anything where the model would "think" longer than the output.
 * ---------------------------------------------------------------------------
 */

const NATIVE_THINKING_MODELS = new Set([
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-opus-4-8[1m]',
  'sonnet', // alias
  'opus', // alias
]);

const MODE = Object.freeze({
  NATIVE: 'native_extended_thinking',
  TAG: 'tag_prompted',
});

function supportsNativeThinking(model) {
  if (!model) return false;
  const m = String(model).toLowerCase();
  if (NATIVE_THINKING_MODELS.has(m)) return true;
  // Family check: anything 4.5+ supports it
  if (/claude-(sonnet|opus)-4\.[5-9]/.test(m)) return true;
  if (/claude-(sonnet|opus)-[5-9]/.test(m)) return true;
  return false;
}

function _buildTagModeSystem(originalSystem) {
  const strategyInstructions = `Before you write the final output, write a strategic breakdown inside <strategy>...</strategy> tags. The strategy must address:

1. TARGET AUDIENCE — who is this for, what do they fear, what do they want?
2. CORE HOOK — the single psychological lever you'll pull (Cialdini / Kahneman / Ariely)
3. CONSTRAINT MAP — what must this output respect (length, tone, format, never-say list)?
4. RISKS — what's the most likely way this output goes wrong, and how do you avoid it?

After the closing </strategy> tag, write the final output. Do NOT include the strategy block in your final output — only put it inside the tags.

Strategy length: 4–8 sentences. Don't pad. Don't write a thesis.`;

  return `${originalSystem || ''}\n\n${strategyInstructions}`.trim();
}

/**
 * Extract the strategy block + output from a tag-mode response.
 * Defensive — if no tags found, treats the whole response as output.
 */
function parseTagModeResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { strategy: '', output: '' };
  }
  const match = rawText.match(/<strategy>([\s\S]*?)<\/strategy>([\s\S]*)/i);
  if (match) {
    return {
      strategy: match[1].trim(),
      output: match[2].trim(),
    };
  }
  // No tags — the model ignored instructions. Ship the whole response
  // as output (don't lose the work).
  return { strategy: '', output: rawText.trim() };
}

/**
 * Main entrypoint. Auto-selects native vs tag mode based on model.
 * Returns { strategy, output, mode, raw }.
 */
async function strategize({
  callClaude,
  system,
  user,
  model = 'claude-sonnet-5',
  max_tokens = 2000,
  businessId,
  skill,
  thinkingBudget = 1500,
  forceTagMode = false,
  extra = {},
} = {}) {
  if (!callClaude) throw new Error('strategicThinking.strategize: callClaude required');
  if (!user) throw new Error('strategicThinking.strategize: user required');

  const useNative = !forceTagMode && supportsNativeThinking(model);

  if (useNative) {
    // Native extended-thinking path. The API returns hidden thinking +
    // a clean final output. The model's reasoning is in `thinking` block
    // entries, which callClaude returns alongside the text when
    // `extra.thinking` is configured.
    try {
      const raw = await callClaude({
        system,
        user,
        model,
        max_tokens,
        extra: {
          ...extra,
          businessId,
          skill: skill || 'strategic_thinking_native',
          returnRaw: true,
          // Sonnet 5 / Opus 4.8 reject budget_tokens (400) — adaptive is the
          // only on-mode; the model self-selects thinking depth. Older
          // native-thinking models still take the explicit budget.
          thinking: require('./modelUpgrades').isFiveFamily(model)
            ? { type: 'adaptive' }
            : { type: 'enabled', budget_tokens: thinkingBudget },
        },
      });
      const text = typeof raw === 'string' ? raw : raw?._raw || raw?.text || '';
      // Native mode: the thinking is server-side and not exposed in the
      // text. We don't get the strategy back as a separate field unless
      // callClaude lifts it from the response's `content` array, which it
      // currently doesn't. So we return the text as output and leave
      // strategy empty — the *quality* still went up because the model
      // reasoned before writing.
      return {
        strategy: '',
        output: typeof text === 'string' ? text.trim() : '',
        mode: MODE.NATIVE,
        raw: text,
      };
    } catch (err) {
      // Native thinking can be rejected if the model API doesn't accept
      // the parameter (e.g. older API version on the account). Fall
      // through to tag mode rather than failing the call.
      if (!/thinking|unsupported|400/i.test(err.message || '')) throw err;
    }
  }

  // Tag mode (works on all models including older Sonnet/Haiku).
  const wrappedSystem = _buildTagModeSystem(system);
  const raw = await callClaude({
    system: wrappedSystem,
    user,
    model,
    max_tokens,
    extra: {
      ...extra,
      businessId,
      skill: skill || 'strategic_thinking_tag',
      returnRaw: true,
    },
  });
  const text = typeof raw === 'string' ? raw : raw?._raw || raw?.text || '';
  const parsed = parseTagModeResponse(text);
  return { ...parsed, mode: MODE.TAG, raw: text };
}

module.exports = {
  strategize,
  parseTagModeResponse,
  supportsNativeThinking,
  MODE,
  NATIVE_THINKING_MODELS,
};
