'use strict';

/**
 * lib/adversarialCritic.js — Reflexion-style adversarial critic loop.
 *
 * Pipeline:
 *   Copywriter (Sonnet) ──► Critic (Haiku, harsh) ──► Rewriter (Sonnet)
 *                                │
 *                                └► severity = 'pass' → return original (no rewrite cost)
 *
 * Why Haiku as critic: ruthless critique is a classification task, not a
 * generation task. Haiku 4.5 is ~10× cheaper than Sonnet 4.5 per token
 * and just as good at "find what's wrong with this." Reserves the
 * expensive Sonnet budget for the actual writing + rewriting.
 *
 * Cost model (per piece of content):
 *   - Draft only:                      1× Sonnet
 *   - Draft + critique (pass):         1× Sonnet + 1× Haiku  (~1.05× base)
 *   - Draft + critique + rewrite:      2× Sonnet + 1× Haiku  (~2.05× base)
 *
 * Telemetry counters emitted (via injected `metrics`):
 *   - critic_runs_total{role,severity}
 *   - critic_rewrite_applied_total{role}
 *   - critic_kept_original_total{role}
 *   - critic_duration_ms{role}
 *
 * Single-entry API:
 *   reflexion({ callClaude, role, draft, ... }) → { final, ... }
 *
 * The caller passes either `draft` (string) or `draftFn` (async () => string).
 * Passing a thunk lets the caller skip the expensive first draft if a cached
 * decision says "skip this whole piece".
 */

const CRITIC_PERSONAS = {
  ad_copy: {
    persona:
      'You are a senior creative director at a top-tier ad agency. You have shipped 1000+ Meta + Google ads. You hate clichés, weak hooks, and on-the-nose copy. You destroy bad copy so the team can ship great copy.',
    bad_patterns: [
      'generic openers ("In today\'s world...", "Are you looking for...?", "Did you know...")',
      'feature dumps without an emotional hook in the first 5 words',
      'unspecified claims ("the best", "amazing", "industry-leading")',
      'CTAs that say "click here" or "learn more" instead of the action they want',
      'AI-coded phrasing ("seamlessly", "leverage", "empower", "unlock")',
      "promises the product can't keep on day 1",
    ],
  },
  email: {
    persona:
      'You are a direct-response email expert. You have written subject lines that converted at 60% open rate. You ruthlessly cut anything that sounds like a newsletter or a corporate email.',
    bad_patterns: [
      'subject lines longer than 50 characters',
      'opening with "Hi [name], hope this email finds you well"',
      'paragraphs longer than 3 sentences',
      'multiple CTAs (an email should have ONE action)',
      'corporate jargon ("synergize", "circle back", "touch base")',
      'wall-of-text formatting with no scannable structure',
    ],
  },
  social_post: {
    persona:
      'You are a social media director who has grown accounts from zero to 500K followers. You know what stops thumbs in the feed. You hate posts that read like press releases.',
    bad_patterns: [
      "first 7 words that don't earn the rest of the post",
      'hashtag stuffing (>3 hashtags = unfollow-bait)',
      'corporate "we are excited to announce" energy',
      'em-dash overuse (a known AI tell)',
      "questions the reader can't answer in their head in under 3 seconds",
      "captions that don't match the image energy",
    ],
  },
  landing_page: {
    persona:
      'You are a CRO expert. You have run 10,000+ A/B tests. You know that one extra word in the H1 can drop conversion 5%. You destroy hero sections that bury the value prop.',
    bad_patterns: [
      "H1 that doesn't say what the product does in 8 words or fewer",
      'sub-headline that repeats the H1 instead of expanding it',
      "social proof without specific numbers ('many customers' vs. '12,847 customers')",
      'CTA buttons that say "Submit" or "Continue"',
      'feature list before a benefit reframe',
      'testimonials without a name, photo, or context',
    ],
  },
  caption: {
    persona:
      'You are an Instagram + TikTok caption expert who has written for top creators. You know the first 3 words decide whether the post gets read.',
    bad_patterns: [
      'first 3 words being a filler ("So,", "Hey guys,", "Today I...")',
      'announcing "what the post is about" instead of just being it',
      'emojis used as decoration instead of punctuation',
      'caption longer than the attention span (>120 chars without a hook)',
    ],
  },
  generic: {
    persona:
      'You are a senior marketing reviewer. You are harsh but fair. You only flag things that would actually hurt performance.',
    bad_patterns: [
      'vague claims without specifics',
      'corporate / AI-coded phrasing',
      'weak hooks that bury the value',
      'CTAs that are not action verbs',
    ],
  },
};

const SEVERITY = Object.freeze(['pass', 'minor', 'major']);
const DEFAULT_CRITIC_MODEL = 'claude-haiku-4-5';

/**
 * Build the critic system prompt for a given role.
 * Tuned to extract STRUCTURED JSON, never prose.
 */
function buildCriticSystemPrompt(role, extraCriteria) {
  const meta = CRITIC_PERSONAS[role] || CRITIC_PERSONAS.generic;
  const badList = meta.bad_patterns.map((p, i) => `  ${i + 1}. ${p}`).join('\n');
  return `${meta.persona}

You are critiquing a single piece of marketing copy. Be ruthless but accurate.

DO NOT REWRITE. Only diagnose. The rewrite is someone else's job.

Common failure patterns to flag (cite if any apply):
${badList}
${extraCriteria ? `\nAdditional criteria from caller:\n  ${extraCriteria}\n` : ''}
Output ONLY this JSON, no prose, no markdown fences:

{
  "severity": "pass" | "minor" | "major",
  "issues": [
    { "span": "exact substring from the copy", "problem": "what's wrong", "fix": "what to change to" }
  ],
  "overall": "one sentence summary of the critique"
}

Severity rules:
- "pass"  = ship as-is. Issues array MUST be empty.
- "minor" = one or two specific weaknesses worth fixing.
- "major" = structural problem; needs rewrite, not patching.

Do not be precious. Most first drafts are minor. Most second drafts are pass.
Do not invent issues to look thorough — if it's good, say pass.`;
}

/**
 * Build the rewrite system prompt — the rewriter sees the original + critique
 * and must return ONLY the rewritten copy.
 */
function buildRewriteSystemPrompt(role) {
  const meta = CRITIC_PERSONAS[role] || CRITIC_PERSONAS.generic;
  return `You are a senior copywriter rewriting marketing copy based on a critic's feedback.

Role context: ${meta.persona}

You will be shown:
  1. The original copy.
  2. A structured critique with specific issues + suggested fixes.

Your job:
  - Apply EVERY fix from the critique.
  - Preserve everything the critique did NOT flag — those parts are good.
  - Return ONLY the rewritten copy. No preamble, no explanation, no quotes.
  - Match the original's length budget (±15%). Do not pad.`;
}

/**
 * Parse the critic's JSON output. Defensive — returns a "skip rewrite"
 * verdict on any parse failure so a malformed critic doesn't burn the
 * rewrite budget. Better to ship the draft than to corrupt it.
 */
function parseCriticOutput(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { severity: 'pass', issues: [], overall: 'critic returned non-string', _malformed: true };
  }
  // Strip code fences if the model ignored instructions
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to find the first {...} block
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      return { severity: 'pass', issues: [], overall: 'critic JSON unparseable', _malformed: true };
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return { severity: 'pass', issues: [], overall: 'critic JSON unparseable', _malformed: true };
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { severity: 'pass', issues: [], overall: 'critic JSON not object', _malformed: true };
  }
  let severity = String(parsed.severity || 'pass').toLowerCase();
  if (!SEVERITY.includes(severity)) severity = 'pass';
  const issues = Array.isArray(parsed.issues) ? parsed.issues.filter((i) => i && typeof i === 'object') : [];
  // Coerce "pass" to empty issues (model sometimes flags issues but says pass)
  if (severity === 'pass' && issues.length > 0) severity = 'minor';
  return {
    severity,
    issues,
    overall: typeof parsed.overall === 'string' ? parsed.overall : '',
  };
}

/**
 * Single critique pass. Cheap (Haiku).
 */
async function critique({
  callClaude,
  draft,
  role = 'generic',
  extraCriteria,
  businessId,
  criticModel = DEFAULT_CRITIC_MODEL,
  skill,
}) {
  if (!callClaude) throw new Error('adversarialCritic.critique: callClaude required');
  if (!draft || typeof draft !== 'string') {
    return { severity: 'pass', issues: [], overall: 'empty draft', _malformed: true };
  }
  const system = buildCriticSystemPrompt(role, extraCriteria);
  const user = `Critique this ${role.replace(/_/g, ' ')}:\n\n${draft}`;
  const raw = await callClaude({
    system,
    user,
    model: criticModel,
    max_tokens: 600,
    extra: {
      businessId,
      skill: skill || `critic_${role}`,
      // Critic must not be rewritten itself, never apply brand voice (it's
      // judging brand voice, not following it).
      skipBrandVoice: true,
      returnRaw: true,
    },
  });
  const text = typeof raw === 'string' ? raw : raw?._raw || raw?.text || '';
  return parseCriticOutput(text);
}

/**
 * Single rewrite pass. Uses the same model as the draft (caller-provided).
 *
 * For `major`-severity rewrites we route through the strategic-thinking
 * wrapper so the model plans its rewrite before writing. Minor rewrites
 * skip the wrapper (cheaper, less needed when the fixes are small).
 */
async function rewrite({
  callClaude,
  original,
  criticVerdict,
  role = 'generic',
  rewriteModel = 'claude-sonnet-5',
  businessId,
  skill,
  maxTokens = 1500,
}) {
  if (!callClaude) throw new Error('adversarialCritic.rewrite: callClaude required');
  if (!original) return original;
  const system = buildRewriteSystemPrompt(role);
  const issuesText = (criticVerdict.issues || [])
    .map(
      (it, i) =>
        `  ${i + 1}. SPAN: ${JSON.stringify(it.span || '').slice(0, 200)}\n     PROBLEM: ${it.problem || ''}\n     FIX: ${it.fix || ''}`
    )
    .join('\n');
  const user = `ORIGINAL:\n${original}\n\nCRITIQUE (severity: ${criticVerdict.severity}):\n${issuesText || criticVerdict.overall || ''}\n\nReturn ONLY the rewritten ${role.replace(/_/g, ' ')}.`;

  // Strategic thinking only for `major` rewrites — structural problems
  // benefit from planning. For `minor` (one or two flagged phrases), the
  // model already has enough context.
  if (criticVerdict.severity === 'major') {
    try {
      const strategicThinking = require('./strategicThinking');
      const result = await strategicThinking.strategize({
        callClaude,
        system,
        user,
        model: rewriteModel,
        max_tokens: maxTokens,
        businessId,
        skill: skill || `rewrite_${role}_strategic`,
        thinkingBudget: 800,
      });
      const text = result.output || '';
      return text.trim().replace(/^["']|["']$/g, '');
    } catch {
      // Fall through to standard rewrite if strategic path errors
    }
  }

  const raw = await callClaude({
    system,
    user,
    model: rewriteModel,
    max_tokens: maxTokens,
    extra: {
      businessId,
      skill: skill || `rewrite_${role}`,
      returnRaw: true,
    },
  });
  const text = typeof raw === 'string' ? raw : raw?._raw || raw?.text || '';
  return text.trim().replace(/^["']|["']$/g, '');
}

/**
 * Full reflexion orchestrator. Accept either `draft` (already-generated
 * string) or `draftFn` (async producer). The thunk form lets a caller
 * skip generation entirely if e.g. a budget check fails.
 */
async function reflexion({
  callClaude,
  draft,
  draftFn,
  role = 'generic',
  extraCriteria,
  businessId,
  skill,
  criticModel = DEFAULT_CRITIC_MODEL,
  rewriteModel = 'claude-sonnet-5',
  maxRewriteRounds = 1,
  rewriteMaxTokens = 1500,
  metrics, // optional — services/observability/metrics
  logger, // optional
} = {}) {
  if (!callClaude) throw new Error('adversarialCritic.reflexion: callClaude required');
  const start = Date.now();
  const rounds = [];

  // ─── Step 1: get the draft ──────────────────────────────────────────
  let current;
  if (typeof draft === 'string') {
    current = draft;
  } else if (typeof draftFn === 'function') {
    current = await draftFn();
  } else {
    throw new Error('adversarialCritic.reflexion: draft or draftFn required');
  }
  if (typeof current !== 'string' || !current.trim()) {
    return { final: current || '', rounds, improved: false, criticVerdict: null, totalLatencyMs: Date.now() - start };
  }

  let lastVerdict = null;
  let improved = false;

  // ─── Step 2: critique + (optional) rewrite, up to maxRewriteRounds ───
  for (let round = 0; round < maxRewriteRounds + 1; round++) {
    const verdict = await critique({
      callClaude,
      draft: current,
      role,
      extraCriteria,
      businessId,
      criticModel,
      skill,
    });
    lastVerdict = verdict;
    rounds.push({ round, severity: verdict.severity, issueCount: verdict.issues.length, draft: current });

    if (metrics?.increment) {
      metrics.increment('critic_runs_total', { role, severity: verdict.severity });
    }

    // Stop conditions: pass, malformed critique, or out of rewrite budget
    if (verdict.severity === 'pass' || verdict._malformed) {
      if (metrics?.increment) metrics.increment('critic_kept_original_total', { role });
      break;
    }
    if (round >= maxRewriteRounds) break;

    // Rewrite
    const rewritten = await rewrite({
      callClaude,
      original: current,
      criticVerdict: verdict,
      role,
      rewriteModel,
      businessId,
      skill,
      maxTokens: rewriteMaxTokens,
    });
    if (rewritten && rewritten !== current) {
      current = rewritten;
      improved = true;
      if (metrics?.increment) metrics.increment('critic_rewrite_applied_total', { role });
    } else {
      // Rewriter returned nothing usable — keep original, stop.
      break;
    }
  }

  const totalLatencyMs = Date.now() - start;
  if (metrics?.observeHistogram) {
    metrics.observeHistogram('critic_duration_ms', totalLatencyMs, { role });
  }
  if (logger?.info) {
    logger.info({
      event: 'adversarial_critic',
      role,
      rounds: rounds.length,
      final_severity: lastVerdict?.severity,
      improved,
      latency_ms: totalLatencyMs,
    });
  }
  return { final: current, rounds, improved, criticVerdict: lastVerdict, totalLatencyMs };
}

module.exports = {
  reflexion,
  critique,
  rewrite,
  parseCriticOutput,
  buildCriticSystemPrompt,
  buildRewriteSystemPrompt,
  CRITIC_PERSONAS,
  SEVERITY,
};
