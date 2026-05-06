'use strict';

/**
 * services/prompts/voice-polish/index.js
 * ----------------------------------------------------------------------------
 * Public entry — detect() + rewrite() + polish() (combined detect-then-rewrite).
 *
 * Three modes:
 *   detect(text, [lang])      — pure deterministic, ~1ms, returns score+flags
 *   rewrite(text, business)   — LLM rewrite anchored to brand voice
 *   polish(text, business)    — combined: detect + rewrite if needed
 *
 * The polish() entry is what other services call as a pre-flight pass.
 * ----------------------------------------------------------------------------
 */

const slop = require('./slop-patterns');
const advisor = require('../advisor-tool');

// ─── System prompt ─────────────────────────────────────────────────────────

function buildRewriteSystemPrompt() {
  return `# ROLE

You are Maroa's voice polisher. You take marketing copy that has AI-tells (buzzwords, generic phrasing, robotic transitions) and rewrite it in a real human voice that fits a specific small business.

# HARD RULES

## 1. Preserve every concrete fact
- All numbers, dates, prices, hours, locations, product names — keep exactly as given
- All proper nouns (business name, customer names, place names) — keep exactly as given
- All claims about offers/services — keep accurate. If input says "20% off", output says "20% off" (or natural language equivalent in the language).

## 2. Strip AI-slop
- Remove generic openers ("In today's fast-paced world...")
- Remove buzzwords ("leverage", "elevate", "world-class", "cutting-edge")
- Remove cliché transitions ("Let's dive in", "Take it to the next level")
- Remove hedge language ("It's worth noting that...")
- Remove meta-commentary ("Hope this helps")

## 3. Restore human voice
- Use the specific brand voice (tone_keywords + audience_description + never_do)
- Match how a real owner of THIS business would talk to THEIR customer
- Industry-appropriate vocabulary (a cafe owner sounds different than a SaaS founder)
- Concrete > abstract: "30 customers/day" > "many customers"

## 4. Same language as input
If input is Albanian, output is Albanian. If Spanish, output is Spanish. NEVER translate.

## 5. Same length or shorter
Polished copy should be the same length or 5-15% shorter. Don't pad — strip.

## 6. Output JSON only

\`\`\`json
{
  "polished": "<rewritten text>",
  "changes_made": ["<short list of what was stripped/replaced>"],
  "language_preserved": true | false
}
\`\`\``;
}

function buildRewriteUserMessage({ text, business, slopAnalysis }) {
  return [
    `# VOICE POLISH REQUEST`,
    ``,
    `## Original text (with AI-slop)`,
    `\`\`\``,
    text,
    `\`\`\``,
    ``,
    `## Slop analysis (deterministic)`,
    '```json',
    JSON.stringify({
      slop_score: slopAnalysis.slop_score,
      flagged_phrases: slopAnalysis.flagged_phrases,
      language: slopAnalysis.language,
    }, null, 2),
    '```',
    ``,
    `## Brand voice (anchor your rewrite to THIS)`,
    '```json',
    JSON.stringify({
      business_name: business?.business_name,
      industry: business?.industry || business?.business_type,
      audience_description: business?.audience_description,
      tone_keywords: business?.tone_keywords || [],
      never_do: business?.never_do,
      we_do_better: business?.we_do_better,
      brand_voice_anchor: business?.brand_voice_anchor || null,
    }, null, 2),
    '```',
    ``,
    `Rewrite in language="${slopAnalysis.language}". Preserve every concrete fact. Same length or shorter. Return ONLY the JSON.`,
  ].join('\n');
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Detect — fast deterministic pass.
 */
function detect(text, lang) {
  if (!text || typeof text !== 'string') {
    return { slop_score: 0, flagged_phrases: [], specificity_score: 0, should_rewrite: false, language_detected: lang || 'unknown' };
  }
  const a = slop.detectSlop(text, lang);
  const spec = slop.specificityScore(text);
  return {
    slop_score: a.slop_score,
    flagged_phrases: a.flagged_phrases,
    specificity_score: spec,
    should_rewrite: slop.shouldRewrite({
      slop_score: a.slop_score,
      specificity_score: spec,
      text_length: text.length,
    }),
    language_detected: a.language,
  };
}

/**
 * Rewrite — LLM-driven polish anchored to brand voice.
 */
async function rewrite({ text, business, plan = 'free', callClaude, extractJSON, logger }) {
  if (typeof callClaude !== 'function') throw new Error('rewrite: callClaude required');
  if (typeof extractJSON !== 'function') throw new Error('rewrite: extractJSON required');
  if (!text || typeof text !== 'string') return { polished: text, slop_score_before: 0, slop_score_after: 0, changes_made: [], retries: 0 };

  // Free tier: deterministic-only, no LLM rewrite (cost protection)
  if (String(plan).toLowerCase() === 'free') {
    const a = detect(text);
    return {
      original: text,
      polished: text,
      slop_score_before: a.slop_score,
      slop_score_after: a.slop_score,
      changes_made: [],
      language_preserved: true,
      retries: 0,
      llm_used: false,
      reason: 'free_tier_skip',
    };
  }

  const slopBefore = detect(text);

  let raw;
  try {
    raw = await advisor.callWithAdvisor({
      callClaude,
      system: buildRewriteSystemPrompt(),
      user: buildRewriteUserMessage({ text, business, slopAnalysis: slopBefore }),
      executor: 'claude-sonnet-4-5',
      advisor: 'claude-opus-4-7',
      task: 'rewrite',
      planTier: plan,
      max_tokens: Math.max(400, Math.min(2000, text.length * 2)),
      extra: { cacheSystem: true },
      temperature: 0.4,
    });
  } catch (e) {
    logger?.warn?.('voice-polish.rewrite', null, 'LLM call failed', e?.message);
    return {
      original: text,
      polished: text,
      slop_score_before: slopBefore.slop_score,
      slop_score_after: slopBefore.slop_score,
      changes_made: [],
      language_preserved: true,
      retries: 0,
      llm_used: false,
      reason: 'llm_unavailable',
    };
  }

  let parsed;
  try { parsed = extractJSON(raw); } catch { parsed = null; }
  if (!parsed || !parsed.polished || typeof parsed.polished !== 'string') {
    return {
      original: text,
      polished: text,
      slop_score_before: slopBefore.slop_score,
      slop_score_after: slopBefore.slop_score,
      changes_made: [],
      language_preserved: true,
      retries: 0,
      llm_used: true,
      reason: 'parse_failed',
    };
  }

  const slopAfter = detect(parsed.polished);

  // Quality gate: if rewrite didn't improve, retry once or fall back
  let retries = 0;
  if (slopAfter.slop_score >= slopBefore.slop_score && slopBefore.slop_score >= 40) {
    // Try one retry with stricter instruction
    try {
      retries = 1;
      const stricter = await callClaude({
        system: buildRewriteSystemPrompt() + '\n\nNOTE: Previous rewrite did NOT reduce AI-slop. Be more aggressive — this is a critical quality requirement.',
        user: buildRewriteUserMessage({ text, business, slopAnalysis: slopBefore }),
        model: 'claude-opus-4-7',
        max_tokens: Math.max(400, Math.min(2000, text.length * 2)),
        extra: { temperature: 0.6 },
      });
      const reparsed = extractJSON(stricter);
      if (reparsed?.polished) {
        const slopRetried = detect(reparsed.polished);
        if (slopRetried.slop_score < slopAfter.slop_score) {
          parsed.polished = reparsed.polished;
          parsed.changes_made = (parsed.changes_made || []).concat(reparsed.changes_made || []);
        }
      }
    } catch { /* fall through */ }
  }

  const finalSlop = detect(parsed.polished);

  // Final guard: if final still WORSE than original, return original.
  // Use flagged-phrase count as primary comparator since the score caps at 100
  // and both heavily-slopped versions can tie at the cap.
  const worseByCount = finalSlop.flagged_phrases.length > slopBefore.flagged_phrases.length;
  const worseByScore = finalSlop.slop_score > slopBefore.slop_score;
  if (worseByCount || worseByScore) {
    return {
      original: text,
      polished: text,
      slop_score_before: slopBefore.slop_score,
      slop_score_after: slopBefore.slop_score,
      changes_made: [],
      language_preserved: true,
      retries,
      llm_used: true,
      reason: 'rewrite_made_it_worse_returning_original',
    };
  }

  return {
    original: text,
    polished: parsed.polished,
    slop_score_before: slopBefore.slop_score,
    slop_score_after: finalSlop.slop_score,
    changes_made: Array.isArray(parsed.changes_made) ? parsed.changes_made : [],
    language_preserved: parsed.language_preserved !== false,
    retries,
    llm_used: true,
  };
}

/**
 * Polish — combined detect + rewrite. The "drop-in pre-flight pass" entry.
 *
 * Other services call this before shipping any customer-facing content.
 */
async function polish({ text, business, plan, callClaude, extractJSON, logger }) {
  const detected = detect(text);
  if (!detected.should_rewrite) {
    return {
      polished: text,
      changed: false,
      slop_score: detected.slop_score,
      reason: 'already_clean',
    };
  }
  const r = await rewrite({ text, business, plan, callClaude, extractJSON, logger });
  return {
    polished: r.polished,
    changed: r.polished !== text,
    slop_score: r.slop_score_after,
    slop_score_before: r.slop_score_before,
    retries: r.retries,
    llm_used: r.llm_used,
    reason: r.reason || (r.polished !== text ? 'rewritten' : 'no_change_needed'),
    changes_made: r.changes_made || [],
  };
}

module.exports = {
  detect,
  rewrite,
  polish,
  slopPatterns: slop,
};
