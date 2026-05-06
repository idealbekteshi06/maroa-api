'use strict';

/**
 * services/prompts/ai-seo/citability-checks.js
 * ----------------------------------------------------------------------------
 * 32 deterministic checks across 8 AI-search-readiness dimensions.
 *
 *   1. Schema markup       (S01-S05)
 *   2. Extractable answers (S06-S10)
 *   3. Entity associations (S11-S14)
 *   4. llms.txt presence   (S15-S17)
 *   5. Citation-worthiness (S18-S22)
 *   6. Structured TL;DRs   (S23-S25)
 *   7. Anchor consistency  (S26-S28)
 *   8. i18n hreflang       (S29-S32)
 *
 * Each check is pure: takes parsed page + business context, returns finding or
 * null. The LLM reasons over findings; it does not have to discover them.
 * ----------------------------------------------------------------------------
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

function hasJsonLd(html, type) {
  if (!html) return false;
  const pattern = new RegExp(`<script[^>]*type=["']application/ld\\+json["'][^>]*>[\\s\\S]*?"@type"\\s*:\\s*["']${type}["'][\\s\\S]*?</script>`, 'i');
  return pattern.test(html);
}

function countQuestions(text) {
  if (!text) return 0;
  const matches = text.match(/[^.!?\n]+\?/g);
  return matches ? matches.length : 0;
}

function hasTldr(text) {
  if (!text) return false;
  return /\b(tl;?dr|in\s+short|summary|key\s+takeaway)\s*[:.]/i.test(text);
}

function hasFaqBlock(html) {
  if (!html) return false;
  return /<(h[1-3])[^>]*>[^<]*\?/i.test(html) ||
         /<dt[^>]*>[\s\S]*?<\/dt>\s*<dd/i.test(html) ||
         hasJsonLd(html, 'FAQPage');
}

function hasNumber(text) {
  if (!text) return false;
  return /\b\d{2,}\b/.test(text);
}

function wordCount(text) {
  if (!text) return 0;
  return (text.match(/\S+/g) || []).length;
}

// ─── 32 checks ──────────────────────────────────────────────────────────────

const CHECKS = [
  // ── SCHEMA MARKUP (S01-S05) ─────────────────────────────────────────────
  {
    id: 'S01',
    title: 'No JSON-LD schema present',
    dimension: 'schema_markup',
    severity: 'critical',
    priority: 10,
    detect: ({ html }) => {
      if (!html) return null;
      if (!/<script[^>]*type=["']application\/ld\+json["']/i.test(html)) {
        return {
          fix: 'Add JSON-LD schema (Organization + WebSite minimum) — without schema, AI assistants cannot extract canonical facts about your business.',
          evidence: { check: 'jsonld_present', value: false },
        };
      }
      return null;
    },
  },
  {
    id: 'S02',
    title: 'Missing Organization schema',
    dimension: 'schema_markup',
    severity: 'warning',
    priority: 8,
    detect: ({ html }) => {
      if (!html) return null;
      if (!hasJsonLd(html, 'Organization')) {
        return {
          fix: 'Add Organization schema with name, url, logo, sameAs (social profiles), contactPoint.',
          evidence: { check: 'organization_schema', value: false },
        };
      }
      return null;
    },
  },
  {
    id: 'S03',
    title: 'Missing LocalBusiness schema (location-based business)',
    dimension: 'schema_markup',
    severity: 'critical',
    priority: 9,
    detect: ({ html, business }) => {
      const isLocal = business?.operation_model === 'location_based' || business?.operation_model === 'hybrid';
      if (!isLocal || !html) return null;
      if (!hasJsonLd(html, 'LocalBusiness')) {
        return {
          fix: 'Location-based business with no LocalBusiness schema — AI assistants cannot recommend you for "near me" queries.',
          evidence: { check: 'local_business_schema', value: false, operation_model: business.operation_model },
        };
      }
      return null;
    },
  },
  {
    id: 'S04',
    title: 'No FAQ schema',
    dimension: 'schema_markup',
    severity: 'warning',
    priority: 7,
    detect: ({ html }) => {
      if (!html) return null;
      if (!hasJsonLd(html, 'FAQPage')) {
        return {
          fix: 'Add FAQPage schema with 5-10 Q&A pairs answering common customer questions. AI assistants quote FAQ schema directly.',
          evidence: { check: 'faq_schema', value: false },
        };
      }
      return null;
    },
  },
  {
    id: 'S05',
    title: 'No Product schema (e-commerce)',
    dimension: 'schema_markup',
    severity: 'warning',
    priority: 7,
    detect: ({ html, business }) => {
      const sellsProducts = (business?.products || []).length > 0;
      if (!sellsProducts || !html) return null;
      if (!hasJsonLd(html, 'Product')) {
        return {
          fix: 'You sell products but pages have no Product schema — add price, availability, brand, image per product.',
          evidence: { check: 'product_schema', value: false, product_count: business.products.length },
        };
      }
      return null;
    },
  },

  // ── EXTRACTABLE ANSWERS (S06-S10) ───────────────────────────────────────
  {
    id: 'S06',
    title: 'No structured Q&A on page',
    dimension: 'extractable_answers',
    severity: 'warning',
    priority: 8,
    detect: ({ html, text }) => {
      const qCount = countQuestions(text);
      if (qCount < 3 && !hasFaqBlock(html)) {
        return {
          fix: 'Pages have <3 question-answer patterns. AI assistants extract from "How do I X?" + immediate answer structures.',
          evidence: { check: 'questions_in_text', value: qCount, threshold: 3 },
        };
      }
      return null;
    },
  },
  {
    id: 'S07',
    title: 'No definition / "what is" content',
    dimension: 'extractable_answers',
    severity: 'info',
    priority: 5,
    detect: ({ text }) => {
      if (!text) return null;
      const hasDefinition = /\b(is\s+(?:a|an|the)|defined\s+as|refers\s+to|means\s+that)\b/i.test(text.slice(0, 1000));
      if (!hasDefinition) {
        return {
          fix: 'No "X is Y" definition in first 1000 chars. AI assistants cite definitional content for explanatory queries.',
          evidence: { check: 'has_definition_pattern', value: false },
        };
      }
      return null;
    },
  },
  {
    id: 'S08',
    title: 'No comparison / vs. content',
    dimension: 'extractable_answers',
    severity: 'info',
    priority: 4,
    detect: ({ text }) => {
      if (!text) return null;
      const hasComparison = /\b(vs\.?|versus|compared\s+to|better\s+than|alternative\s+to)\b/i.test(text);
      if (!hasComparison) {
        return {
          fix: 'No comparison content — AI assistants cite "X vs Y" pages for evaluative queries.',
          evidence: { check: 'has_comparison_pattern', value: false },
        };
      }
      return null;
    },
  },

  // ── ENTITY ASSOCIATIONS (S11-S14) ───────────────────────────────────────
  {
    id: 'S11',
    title: 'No sameAs entity links',
    dimension: 'entity_associations',
    severity: 'warning',
    priority: 7,
    detect: ({ html }) => {
      if (!html) return null;
      if (!/sameAs/i.test(html)) {
        return {
          fix: 'Schema has no sameAs property — link to Wikipedia, Wikidata, LinkedIn, Crunchbase canonical entities to anchor your brand.',
          evidence: { check: 'sameAs_present', value: false },
        };
      }
      return null;
    },
  },
  {
    id: 'S12',
    title: 'No founder / team person schema',
    dimension: 'entity_associations',
    severity: 'info',
    priority: 4,
    detect: ({ html }) => {
      if (!html) return null;
      if (!hasJsonLd(html, 'Person')) {
        return {
          fix: 'Add Person schema for founder/team — anchors brand to real people, builds AI-assistant trust.',
          evidence: { check: 'person_schema', value: false },
        };
      }
      return null;
    },
  },

  // ── LLMS.TXT (S15-S17) ──────────────────────────────────────────────────
  {
    id: 'S15',
    title: 'No /llms.txt file',
    dimension: 'llms_txt_presence',
    severity: 'critical',
    priority: 9,
    detect: ({ llms_txt_present }) => {
      if (llms_txt_present === true) return null;
      return {
        fix: 'No /llms.txt file. This is the LLM equivalent of robots.txt — tells AI crawlers what your site is about. 5-min fix.',
        evidence: { check: 'llms_txt_present', value: !!llms_txt_present },
      };
    },
  },
  {
    id: 'S16',
    title: 'No /llms-full.txt file',
    dimension: 'llms_txt_presence',
    severity: 'warning',
    priority: 6,
    detect: ({ llms_full_txt_present, plan }) => {
      if (plan === 'free') return null; // Don't push paid features on free.
      if (llms_full_txt_present === true) return null;
      return {
        fix: 'No /llms-full.txt — full-content version that lets AI assistants ingest your site without crawling every page.',
        evidence: { check: 'llms_full_txt_present', value: !!llms_full_txt_present },
      };
    },
  },

  // ── CITATION-WORTHINESS (S18-S22) ───────────────────────────────────────
  {
    id: 'S18',
    title: 'No specific numbers / statistics',
    dimension: 'citation_worthiness',
    severity: 'warning',
    priority: 7,
    detect: ({ text }) => {
      if (!text) return null;
      if (!hasNumber(text)) {
        return {
          fix: 'No specific numbers in content. AI assistants cite "85% reduction in churn", not "significant improvement".',
          evidence: { check: 'has_specific_numbers', value: false },
        };
      }
      return null;
    },
  },
  {
    id: 'S19',
    title: 'Generic marketing language',
    dimension: 'citation_worthiness',
    severity: 'info',
    priority: 5,
    detect: ({ text }) => {
      if (!text) return null;
      const generic = /(world.?class|cutting.edge|innovative|leading|best.in.class|game.?changing|synerg)/gi;
      const matches = (text.match(generic) || []).length;
      if (matches > 3) {
        return {
          fix: `${matches} generic marketing buzzwords found ("world-class", "cutting-edge", etc.) — replace with specific facts AI assistants can cite.`,
          evidence: { check: 'buzzword_count', value: matches, threshold: 3 },
        };
      }
      return null;
    },
  },
  {
    id: 'S20',
    title: 'Page too thin for extraction',
    dimension: 'citation_worthiness',
    severity: 'warning',
    priority: 6,
    detect: ({ text }) => {
      const wc = wordCount(text);
      if (wc > 0 && wc < 200) {
        return {
          fix: `Page has only ${wc} words — too thin for AI extraction. Aim for 600+ on key landing pages.`,
          evidence: { check: 'word_count', value: wc, threshold: 200 },
        };
      }
      return null;
    },
  },

  // ── STRUCTURED TL;DRS (S23-S25) ─────────────────────────────────────────
  {
    id: 'S23',
    title: 'No TL;DR / summary block',
    dimension: 'structured_tldrs',
    severity: 'warning',
    priority: 7,
    detect: ({ text }) => {
      if (!text) return null;
      if (!hasTldr(text)) {
        return {
          fix: 'No TL;DR / "in short" block — add a 2-3 sentence summary at top of page. AI assistants cite TL;DRs first.',
          evidence: { check: 'has_tldr', value: false },
        };
      }
      return null;
    },
  },
  {
    id: 'S24',
    title: 'No bullet-list content',
    dimension: 'structured_tldrs',
    severity: 'info',
    priority: 4,
    detect: ({ html }) => {
      if (!html) return null;
      const ulCount = (html.match(/<ul/gi) || []).length;
      if (ulCount === 0) {
        return {
          fix: 'No <ul> bullet lists — AI assistants extract from bullets more reliably than prose.',
          evidence: { check: 'bullet_list_count', value: ulCount, threshold: 1 },
        };
      }
      return null;
    },
  },

  // ── ANCHOR CONSISTENCY (S26-S28) ────────────────────────────────────────
  {
    id: 'S26',
    title: 'Inconsistent brand mention',
    dimension: 'anchor_consistency',
    severity: 'info',
    priority: 4,
    detect: ({ text, business }) => {
      if (!text || !business?.business_name) return null;
      const variations = new Set();
      const name = business.business_name.toLowerCase();
      if (text.toLowerCase().includes(name)) variations.add(name);
      const lowerText = text.toLowerCase();
      // Detect common variations (with/without spaces, ampersands, .com)
      const candidate = name.replace(/[\s.&]/g, '');
      if (lowerText.includes(candidate) && candidate !== name) variations.add(candidate);
      if (lowerText.match(new RegExp(name + '\\.com', 'i'))) variations.add(name + '.com');
      if (variations.size > 1) {
        return {
          fix: `Brand name appears as ${[...variations].join(', ')} — pick ONE canonical form for AI-assistant anchoring.`,
          evidence: { check: 'brand_variations', value: [...variations] },
        };
      }
      return null;
    },
  },

  // ── I18N HREFLANG (S29-S32) ─────────────────────────────────────────────
  {
    id: 'S29',
    title: 'No hreflang on multi-language site',
    dimension: 'i18n_hreflang',
    severity: 'warning',
    priority: 6,
    detect: ({ html, business }) => {
      const isMulti = (business?.secondary_languages || []).length > 0;
      if (!isMulti || !html) return null;
      if (!/hreflang=/i.test(html)) {
        return {
          fix: 'Multi-language site with no hreflang attributes — AI assistants cannot map regional variants of your content.',
          evidence: { check: 'hreflang_present', value: false, secondary_languages: business.secondary_languages },
        };
      }
      return null;
    },
  },
  {
    id: 'S30',
    title: 'Wrong primary language declared',
    dimension: 'i18n_hreflang',
    severity: 'info',
    priority: 5,
    detect: ({ html, marketProfile }) => {
      if (!html || !marketProfile?.primary_language) return null;
      const langMatch = html.match(/<html[^>]*lang=["']([a-z-]+)["']/i);
      if (langMatch && !langMatch[1].toLowerCase().startsWith(marketProfile.primary_language)) {
        return {
          fix: `<html lang="${langMatch[1]}"> doesn't match business primary_language "${marketProfile.primary_language}".`,
          evidence: { check: 'html_lang_match', html_lang: langMatch[1], expected: marketProfile.primary_language },
        };
      }
      return null;
    },
  },
];

const PRIORITY_FREE_SET = ['S01','S03','S15','S18','S23'];                                                                  // 5
const PRIORITY_GROWTH_SET = ['S01','S02','S03','S04','S05','S06','S11','S15','S18','S19','S20','S23','S26','S29'];          // 14

function runChecks({ html, text, business, marketProfile, llms_txt_present, llms_full_txt_present, plan = 'free' }) {
  const tier = String(plan || 'free').toLowerCase();
  const allowedIds =
      tier === 'agency' ? null
    : tier === 'growth' ? new Set(PRIORITY_GROWTH_SET)
    : new Set(PRIORITY_FREE_SET);

  const findings = [];
  const ctx = { html, text, business, marketProfile, llms_txt_present, llms_full_txt_present, plan };
  for (const check of CHECKS) {
    if (allowedIds && !allowedIds.has(check.id)) continue;
    try {
      const r = check.detect(ctx);
      if (r) {
        findings.push({
          check_id: check.id,
          title: check.title,
          dimension: check.dimension,
          severity: check.severity,
          priority: check.priority,
          fix: r.fix,
          evidence: r.evidence,
        });
      }
    } catch { /* defensive */ }
  }
  const sevW = { critical: 3, warning: 2, info: 1 };
  findings.sort((a, b) => (sevW[b.severity] - sevW[a.severity]) || (b.priority - a.priority));
  return findings;
}

module.exports = {
  CHECKS,
  PRIORITY_FREE_SET,
  PRIORITY_GROWTH_SET,
  runChecks,
};
