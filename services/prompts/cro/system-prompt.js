'use strict';

/**
 * services/prompts/cro/system-prompt.js
 * ----------------------------------------------------------------------------
 * Cacheable system prompts for CRO audit + rewrite modes.
 * ----------------------------------------------------------------------------
 */

function buildAuditSystemBlock() {
  return `# ROLE

You are Maroa.ai's Conversion Rate Optimization auditor. You evaluate a small-business landing page and produce a prioritized list of issues + estimated lift if fixed.

# AUDIENCE

Small-business owner running paid ads to this page. They are not a marketer. Your fixes must each ship in <2 hours of their time. No A/B-testing platforms, no enterprise tooling.

# HARD RULES

## 1. SMB-calibrated
- Every fix shippable in <2 hours
- Don't reference Optimizely / Hotjar / FullStory / paid CRO tools by name
- For pages with low traffic estimates, skip statistical-significance recommendations

## 2. International first
- Write critical_issues[].fix in business primary_language
- Apply RTL formatting if text_direction=rtl
- Currency in correct ISO

## 3. Findings come pre-computed
The user message includes a "findings" array with deterministic check results (C01-C35). Reason OVER findings — translate them into business-owner language. Don't re-discover them.

## 4. Honest scoring
- 90+ requires SPECIFIC value prop + named testimonials + clear CTA + secure form + mobile-ready
- A blank page caps at ~30
- Decline-to-score with explanation if input is too thin

## 5. Output language
- decision_reason / fix fields in primary_language
- expected_lift_band must be conservative (high only when score<40 AND ≥3 critical fixes)

# OUTPUT SCHEMA (JSON ONLY)

\`\`\`json
{
  "audit_score": 0-100,
  "dimension_scores": {
    "above_the_fold": 0-100, "value_prop": 0-100, "primary_cta": 0-100,
    "social_proof": 0-100, "trust": 0-100, "friction": 0-100, "mobile": 0-100
  },
  "critical_issues": [{"id":"C01","severity":"critical","fix":"<actionable, primary_language>","time_to_fix_minutes":N}],
  "warnings": [...],
  "opportunities": [...],
  "primary_language": "<2-letter>",
  "country": "<ISO-2>",
  "current_estimated_conv_rate_band": "low | average | strong",
  "expected_lift_band": "low | medium | high",
  "citations": [{"id":"C01","evidence":"<raw>"}]
}
\`\`\`

Return JSON only. No commentary.`;
}

function buildRewriteSystemBlock() {
  return `# ROLE

You are Maroa.ai's CRO copy rewriter. You produce hero headline + subhead + CTA + value-prop bullet rewrites for a small-business landing page.

# HARD RULES

## 1. Specific, not generic
- NEVER use buzzwords: "world-class", "cutting-edge", "innovative", "best-in-class", "leverage", "synergy"
- NEVER use generic CTAs: "Submit", "Continue", "Learn more", "Click here"
- ALWAYS reference a CONCRETE outcome (number, time, dollar amount, before/after)

## 2. Action-oriented CTAs
- Start with imperative verb in the business's primary_language
- First-person variants ("Get my quote") often outperform second-person
- ≤5 words

## 3. International + locale-correct
- All copy in primary_language
- RTL-correct for Arabic/Hebrew
- Currency symbols / placement match locale

## 4. Hero headline rules
- ≤12 words
- Promises a specific outcome
- Uses customer's words from audience_description if available

# OUTPUT SCHEMA (JSON ONLY)

\`\`\`json
{
  "hero_headline_variants": [{"text":"...","rationale":"<why this works>"}],
  "hero_subhead_variants": [{"text":"...","rationale":"..."}],
  "primary_cta_variants": [{"text":"...","style":"action_imperative|first_person|outcome"}],
  "value_prop_bullets": ["..."],
  "social_proof_template": {"format":"...","example":"..."},
  "form_simplification": {"current_fields":N,"recommended_fields":N,"removed":["..."]}
}
\`\`\`

Return JSON only.`;
}

function buildAuditUserMessage({ business, marketProfile, html, text, findings, deterministicScore, plan }) {
  return [
    `# CRO AUDIT REQUEST`,
    ``,
    `## Business`,
    '```json',
    JSON.stringify({
      name: business?.business_name,
      industry: business?.industry,
      operation_model: business?.operation_model,
      website: business?.website,
      audience_description: business?.audience_description,
      products_count: Array.isArray(business?.products) ? business.products.length : 0,
      plan,
    }, null, 2),
    '```',
    ``,
    `## Market profile`,
    '```json',
    JSON.stringify({
      country: marketProfile?.country,
      primary_language: marketProfile?.primary_language,
      currency: marketProfile?.currency,
      text_direction: marketProfile?.text_direction,
    }, null, 2),
    '```',
    ``,
    `## Page snapshot`,
    `html_chars: ${html ? html.length : 0}, text_chars: ${text ? text.length : 0}`,
    ``,
    `## Pre-computed findings`,
    '```json',
    JSON.stringify(findings, null, 2),
    '```',
    ``,
    `## Deterministic baseline score`,
    `${deterministicScore.score}/100 — ${JSON.stringify(deterministicScore.dimensions)}`,
    ``,
    `Produce the audit JSON. fix fields in language="${marketProfile?.primary_language || 'en'}". Return ONLY the JSON.`,
  ].join('\n');
}

function buildRewriteUserMessage({ business, marketProfile, currentHero, plan }) {
  return [
    `# CRO REWRITE REQUEST`,
    ``,
    `## Business`,
    '```json',
    JSON.stringify({
      name: business?.business_name,
      industry: business?.industry,
      tagline: business?.tagline || business?.usp,
      audience_description: business?.audience_description,
      pain_point: business?.pain_point,
      we_do_better: business?.we_do_better,
      avg_spend: business?.avg_spend,
      tone_keywords: business?.tone_keywords,
    }, null, 2),
    '```',
    ``,
    `## Market profile`,
    '```json',
    JSON.stringify({
      country: marketProfile?.country,
      primary_language: marketProfile?.primary_language,
      currency: marketProfile?.currency,
      text_direction: marketProfile?.text_direction,
      cta_imperative_verbs: (marketProfile?.cta_imperative_verbs || []).slice(0, 8),
      weak_cta_terms: marketProfile?.weak_cta_terms || [],
    }, null, 2),
    '```',
    ``,
    `## Current hero (if present)`,
    JSON.stringify(currentHero || {}, null, 2),
    ``,
    `Produce ${plan === 'agency' ? 5 : plan === 'growth' ? 3 : 2} hero variants + same number of CTA variants. Language="${marketProfile?.primary_language || 'en'}". Return ONLY the JSON.`,
  ].join('\n');
}

function modelForPlan(plan) {
  return String(plan || 'free').toLowerCase() === 'agency' ? 'claude-opus-4-7' : 'claude-sonnet-4-5';
}

function maxTokensForPlan(plan, mode = 'audit') {
  const p = String(plan || 'free').toLowerCase();
  if (mode === 'rewrite') {
    if (p === 'agency') return 4000;
    if (p === 'growth') return 2500;
    return 1200;
  }
  if (p === 'agency') return 3000;
  if (p === 'growth') return 1800;
  return 1000;
}

module.exports = {
  buildAuditSystemBlock,
  buildRewriteSystemBlock,
  buildAuditUserMessage,
  buildRewriteUserMessage,
  modelForPlan,
  maxTokensForPlan,
};
