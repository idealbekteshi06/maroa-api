/*
 * workflow_6_presence.js — Local + Digital Presence prompts (backend-native)
 */

'use strict';

const { buildSystemPrompt } = require('./foundation.js');

function buildPresenceAuditPrompt(ctx, audit) {
  const addendum = `
WORKFLOW #6 — LOCAL + DIGITAL PRESENCE

You are the head of digital presence at a premium local-services agency.
${ctx.businessName} needs a full audit + remediation plan for:
  - Google Business Profile completeness + signal strength
  - Schema.org markup + rich snippets
  - NAP (Name, Address, Phone) consistency across citations
  - Local SEO (map pack, city-specific ranking)
  - Digital PR + link earning
  - Website conversion hygiene

FRAMEWORK
  Local 3-pack ranking factors (Moz/BrightLocal 2024):
    1. Proximity (can't change)
    2. Prominence (reviews + citations + links — LEVERAGE THIS)
    3. Relevance (GBP primary category + attributes — FIX THIS)

Return strict JSON:
{
  "overall_score": 0-100,
  "gbp": {
    "score": 0-100,
    "issues": [{ "severity": "low|medium|high", "issue": "string", "fix": "string" }]
  },
  "schema_markup": {
    "score": 0-100,
    "missing": ["type1", "type2"],
    "recommended": ["type1", "type2"]
  },
  "citations": {
    "score": 0-100,
    "nap_consistent": boolean,
    "inconsistencies": [{ "source": "string", "found": "string", "expected": "string" }]
  },
  "local_rank": {
    "score": 0-100,
    "top_keywords_tracked": [{ "keyword": "string", "rank": number, "volume_monthly": number }],
    "gaps": ["specific ranking gaps"]
  },
  "remediation_plan": [
    {
      "priority": 1-10,
      "task": "string",
      "effort_hours": number,
      "owner": "ai|human",
      "expected_lift": "string"
    }
  ],
  "quick_wins_this_week": ["task 1", "task 2"]
}

No vanity — only recommend what moves rank or conversions.
`.trim();

  const user = `
AUDIT SNAPSHOT:
  GBP fields present: ${(audit.gbpFields || []).join(', ') || '(none)'}
  GBP categories: ${audit.gbpCategories || 'unknown'}
  GBP posts last 30d: ${audit.gbpPosts ?? 0}
  Schema types detected: ${(audit.schemaDetected || []).join(', ') || '(none)'}
  Citations found: ${audit.citationCount ?? 0}
  NAP inconsistencies: ${(audit.napInconsistencies || []).length}
  Tracked keywords: ${(audit.keywords || []).length}
  Location: ${ctx.primaryMarkets?.[0] || 'unknown'}
`.trim();

  return { system: buildSystemPrompt(ctx, addendum), user };
}

function buildSchemaGenerationPrompt(ctx, page) {
  const addendum = `
WORKFLOW #6 — SCHEMA MARKUP GENERATION

Generate valid Schema.org JSON-LD for the provided page context. Return ONLY
the JSON-LD object (no prose, no wrapping prose). Match the most appropriate
type (LocalBusiness, Restaurant, ProfessionalService, Organization, Product,
Service, Event, Article, FAQPage, BreadcrumbList).

Requirements:
- Use @context "https://schema.org"
- Populate every field the page context supports
- Include review/rating if data is available
- Include openingHours in ISO 8601 format for local businesses
- Include aggregateRating if aggregate data exists
`.trim();

  const user = JSON.stringify(page, null, 2);

  return { system: buildSystemPrompt(ctx, addendum), user };
}

module.exports.buildPresenceAuditPrompt = buildPresenceAuditPrompt;
module.exports.buildSchemaGenerationPrompt = buildSchemaGenerationPrompt;
