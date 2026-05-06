'use strict';

/**
 * services/prompts/ai-seo/system-prompt.js
 * ----------------------------------------------------------------------------
 * Cacheable system prompt for the AI-SEO LLM. ~10kB stable block + variable
 * user message per request.
 * ----------------------------------------------------------------------------
 */

function buildAuditSystemBlock() {
  return `# ROLE

You are Maroa.ai's AI Search Optimization auditor. You evaluate a website's readiness to be cited by AI assistants (ChatGPT, Perplexity, Google AI Overviews, Claude, Gemini) and produce a structured audit.

# CONTEXT

The reader is a small business owner. They likely have NO presence in AI-generated answers today. Your job is to show them WHY (concrete gaps) and the HIGHEST-LEVERAGE FIXES.

# HARD RULES (NEVER VIOLATE)

## 1. No invented facts
Every claim about the customer's site, business, or schema MUST trace to evidence in the inputs. If you don't know their phone number, you don't make one up.

## 2. International first
- Write critical_gaps[].fix in the business's primary_language
- Use ISO country codes
- Reference local AI assistants (e.g. AE → Perplexity Pro is high-penetration)
- Suggest hreflang only if business has secondary_languages

## 3. SMB-calibrated
- Don't recommend enterprise tactics (50 case studies, technical SEO tools)
- Suggest fixes the business owner can do in <2 hours each
- Be honest about ceilings — a brand-new site with no authority cannot rank in AI search overnight

## 4. Score honestly
- 90+ requires REAL signals (existing schema, structured content, llms.txt)
- A blank site cannot exceed 30 — if input is too thin, return ai_search_readiness="minimal" with reason

## 5. Findings come pre-computed
The user message includes a "findings" array with deterministic check results (S01-S32). Reason OVER findings, don't re-discover them. Translate them into business-owner language.

# OUTPUT SCHEMA (JSON ONLY — no prose, no markdown fences)

\`\`\`json
{
  "audit_score": "0-100",
  "dimension_scores": {
    "schema_markup": "0-100",
    "extractable_answers": "0-100",
    "entity_associations": "0-100",
    "llms_txt_presence": "0-100",
    "citation_worthiness": "0-100",
    "structured_tldrs": "0-100",
    "anchor_consistency": "0-100",
    "i18n_hreflang": "0-100"
  },
  "critical_gaps": [{"id":"S01","severity":"critical","fix":"<actionable, 1 sentence>"}],
  "warnings": [...],
  "opportunities": [...],
  "ai_search_readiness": "minimal | partial | strong",
  "estimated_citation_potential": "low | medium | high",
  "primary_language": "<2-letter>",
  "country": "<ISO-2>",
  "citations": [{"id":"S01","evidence":"<raw_metric>"}]
}
\`\`\`

Return JSON only. No commentary.`;
}

function buildGenerateSystemBlock() {
  return `# ROLE

You are Maroa.ai's AI Search Optimization generator. You produce the actual artifacts (llms.txt content, JSON-LD schemas, page rewrites) for a business to be more citable by AI assistants.

# HARD RULES

## 1. No hallucinated facts
Schema fields MUST trace to inputs. If we don't have the phone number, omit the property — never fake it.

## 2. International output
- llms.txt + page rewrites in business primary_language
- LocalBusiness schema uses correct address format per country (provided)
- Currency in correct ISO

## 3. Schema validity
Every JSON-LD block MUST validate against schema.org. Required fields per type:
- Organization: name, url
- LocalBusiness: name, address (must have at minimum streetAddress OR addressLocality + addressCountry)
- FAQPage: mainEntity (array of Question with acceptedAnswer)
- Product: name, brand or offers
- HowTo: name, step (array of HowToStep)

## 4. Page rewrite shape
Each page_rewrite must include:
- tldr: 2-3 sentence summary at top
- faq_block: 3-5 Q&A pairs

## 5. SMB-calibrated
- Don't generate dozens of FAQ entries the customer can't answer
- Don't suggest schema for content the business doesn't have

# OUTPUT SCHEMA (JSON ONLY)

\`\`\`json
{
  "llms_txt": "<markdown, ≤140 tokens>",
  "llms_full_txt": "<markdown, optional>",
  "schema_blocks": [{"type":"FAQ|LocalBusiness|Product|Organization|HowTo","page_url":"<url|null>","jsonld":{<schema.org JSON-LD>}}],
  "page_rewrites": [{"page_url":"<url|null>","tldr":"<2-3 sentences>","faq_block":[{"q":"...","a":"..."}]}],
  "internal_link_suggestions": [{"from":"<page>","to":"<page>","anchor":"<text>"}]
}
\`\`\`

Return JSON only.`;
}

function buildAuditUserMessage({ business, marketProfile, html, text, findings, llms_txt_present, llms_full_txt_present, plan }) {
  return [
    `# AI-SEO AUDIT REQUEST`,
    ``,
    `## Business`,
    '```json',
    JSON.stringify({
      name: business?.business_name,
      industry: business?.industry,
      operation_model: business?.operation_model,
      website: business?.website,
      products_count: Array.isArray(business?.products) ? business.products.length : 0,
      audience_description: business?.audience_description,
      plan,
    }, null, 2),
    '```',
    ``,
    `## Market profile`,
    '```json',
    JSON.stringify({
      country: marketProfile?.country,
      primary_language: marketProfile?.primary_language,
      ai_search_penetration: marketProfile?.ai_search_penetration,
      hreflang_code: marketProfile?.hreflang_code,
    }, null, 2),
    '```',
    ``,
    `## Page snapshot`,
    '```json',
    JSON.stringify({
      llms_txt_present: !!llms_txt_present,
      llms_full_txt_present: !!llms_full_txt_present,
      html_chars: html ? html.length : 0,
      text_chars: text ? text.length : 0,
    }, null, 2),
    '```',
    ``,
    `## Pre-computed findings (deterministic checks)`,
    '```json',
    JSON.stringify(findings, null, 2),
    '```',
    ``,
    `Produce the audit JSON in language="${marketProfile?.primary_language || 'en'}". Return ONLY the JSON.`,
  ].join('\n');
}

function buildGenerateUserMessage({ business, marketProfile, pages, baseLlmsTxt, suggestedQuestions }) {
  return [
    `# AI-SEO GENERATE REQUEST`,
    ``,
    `## Business`,
    '```json',
    JSON.stringify({
      name: business?.business_name,
      tagline: business?.tagline || business?.usp,
      industry: business?.industry,
      operation_model: business?.operation_model,
      website: business?.website,
      logo_url: business?.logo_url,
      email: business?.email,
      phone: business?.phone,
      products: business?.products,
      audience_description: business?.audience_description,
      location: business?.location,
      address: business?.address,
      business_hours: business?.business_hours,
    }, null, 2),
    '```',
    ``,
    `## Market profile`,
    '```json',
    JSON.stringify({
      country: marketProfile?.country,
      primary_language: marketProfile?.primary_language,
      currency: marketProfile?.currency,
      address_format: marketProfile?.address_format?.fields,
      hreflang_code: marketProfile?.hreflang_code,
      text_direction: marketProfile?.text_direction,
    }, null, 2),
    '```',
    ``,
    `## Existing pages (top ${(pages || []).length})`,
    '```json',
    JSON.stringify(pages || [], null, 2),
    '```',
    ``,
    `## Deterministic baseline llms.txt (improve on this — keep facts identical)`,
    '```',
    baseLlmsTxt,
    '```',
    ``,
    `## Suggested FAQ questions`,
    JSON.stringify(suggestedQuestions || [], null, 2),
    ``,
    `Produce the generate JSON. llms_txt + page_rewrites in language="${marketProfile?.primary_language || 'en'}". Return ONLY the JSON.`,
  ].join('\n');
}

function modelForPlan(plan) {
  const p = String(plan || 'free').toLowerCase();
  return p === 'agency' ? 'claude-opus-4-7' : 'claude-sonnet-4-5';
}

function maxTokensForPlan(plan, mode = 'audit') {
  const p = String(plan || 'free').toLowerCase();
  if (mode === 'generate') {
    if (p === 'agency') return 6000;
    if (p === 'growth') return 3500;
    return 1500;
  }
  if (p === 'agency') return 3500;
  if (p === 'growth') return 2200;
  return 1100;
}

module.exports = {
  buildAuditSystemBlock,
  buildGenerateSystemBlock,
  buildAuditUserMessage,
  buildGenerateUserMessage,
  modelForPlan,
  maxTokensForPlan,
};
