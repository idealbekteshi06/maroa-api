'use strict';

/**
 * services/ai-seo/serp-outliner.js
 * ---------------------------------------------------------------------------
 * SERP-driven 10x outline generator. Implements the "analyze top 5 → extract
 * gaps → 10x outline → section-by-section write" pipeline described in
 * ADR-0005 (Pillar #3 extension, Wave 55).
 *
 * Why this beats human SEO experts:
 *
 *   Human SEO analyst:
 *     - reads top 3 ranking pages (manually)
 *     - extracts a rough outline of what's covered
 *     - writes "slightly better" content
 *     - ~6 hours per article
 *
 *   This pipeline:
 *     - reads top 5 ranking pages (via DataForSEO / SerpAPI)
 *     - extracts all entities + LSI keywords + topical gaps
 *     - builds a master outline 10× more comprehensive than the top result
 *     - generates section-by-section so token limits don't constrain depth
 *     - ~3 minutes per article
 *
 * Plan-gating: agency tier only. Each article costs ~$0.15–0.30 to produce
 * (5 SERP fetches + outline call + N section writes). Growth tier ($1.50/day
 * cost guard) would burn 1 day of budget on a single article — wrong.
 *
 * Public API:
 *
 *   const outline = await buildOutline({
 *     keyword: 'best cafe in tirana',
 *     business,            // for brand context
 *     callClaude,
 *     fetchSerp,           // injected: async (keyword) => [{title, url, snippet}]
 *     logger?, metrics?,
 *   });
 *   // → { sections: [...], lsi_keywords: [...], gaps_found: [...], citations: [...] }
 *
 *   const article = await writeArticle({
 *     outline,
 *     callClaude,
 *     business,
 *     logger?,
 *   });
 *   // → { sections: [{ title, body }], total_words, _critic_severity }
 *
 * Failure modes (soft):
 *   - SERP fetch returns empty           → outline built from brand only
 *   - SERP fetch throws                  → return null, caller decides
 *   - Claude returns malformed outline   → return null, caller falls back
 *   - One section write fails            → other sections still ship
 * ---------------------------------------------------------------------------
 */

const DEFAULT_TOP_K_SERP = 5;
const MIN_SECTIONS = 6;
const MAX_SECTIONS = 14;

function _buildOutlineSystemPrompt() {
  return `You are a senior SEO content strategist who has ranked #1 for 1000+ keywords.

You will be shown the top ranking articles for a target keyword. Your job:

1. Extract every TOPICAL ENTITY they cover (people, places, concepts, tools, statistics).
2. Identify GAPS — important questions the ranking pages fail to answer, or shallow coverage where depth would dominate.
3. Identify LSI (latent semantic) keywords — terms that AI search engines + Google's BERT use to recognize topical authority.
4. Build a MASTER OUTLINE designed to be 10× more comprehensive + better organized than the top result.

The outline must:
  - Cover every entity from the SERP analysis (no gaps the competition has).
  - Include 2–4 sections answering questions the competition skipped (the "gap fill" sections).
  - Be structured for AI search engine extraction (clear H2/H3, scannable, citable sentences).
  - Have ${MIN_SECTIONS}–${MAX_SECTIONS} sections total.

Output ONLY this JSON, no prose, no markdown fences:

{
  "title": "the H1 — concrete, specific, ≤ 70 chars",
  "meta_description": "≤ 155 chars",
  "primary_entity": "the one entity this article is fundamentally about",
  "lsi_keywords": ["array of latent semantic terms — ~10–20 entries"],
  "gaps_found": ["specific topical gaps the SERP misses — ~3–6 entries"],
  "sections": [
    {
      "h2": "exact section heading",
      "intent": "informational | commercial | navigational",
      "key_points": ["each point this section must hit — 3–6 points"],
      "lsi_to_include": ["which LSI keywords appear in this section"],
      "is_gap_fill": false,
      "is_citable": true
    }
  ]
}

Quality rules:
  - Don't pad. If the keyword only deserves 6 sections, ship 6.
  - Don't invent entities the SERP didn't surface.
  - At least 2 sections must have "is_gap_fill: true".`;
}

function _buildSectionSystemPrompt() {
  return `You are a senior writer producing one section of a long-form SEO article.

You will be shown:
  - The article title + primary entity
  - This section's H2 + intent + key points + LSI keywords to weave in
  - The 2 preceding section excerpts (for continuity)

Your job: write this section AS A SECTION. Don't write an intro for the whole article. Don't write a conclusion. Don't wrap with "in this section...".

Constraints:
  - 250–500 words.
  - Cover every key point.
  - Naturally include the listed LSI keywords (don't keyword-stuff).
  - Lead with the most quotable / extract-friendly sentence (AI search engines extract first sentences).
  - Use H3 sub-headings only if the section has 3+ distinct sub-ideas.
  - End with one concrete takeaway sentence.

Output: just the section body in Markdown. No JSON, no prose preamble.`;
}

/**
 * Parse the outline JSON defensively. Returns null on any parse failure.
 */
function parseOutlineOutput(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!parsed || !Array.isArray(parsed.sections)) return null;
  if (parsed.sections.length < 1) return null;
  // Clamp section count
  if (parsed.sections.length > MAX_SECTIONS) {
    parsed.sections = parsed.sections.slice(0, MAX_SECTIONS);
  }
  return {
    title: typeof parsed.title === 'string' ? parsed.title.slice(0, 100) : '',
    meta_description: typeof parsed.meta_description === 'string' ? parsed.meta_description.slice(0, 200) : '',
    primary_entity: typeof parsed.primary_entity === 'string' ? parsed.primary_entity : '',
    lsi_keywords: Array.isArray(parsed.lsi_keywords) ? parsed.lsi_keywords.slice(0, 30) : [],
    gaps_found: Array.isArray(parsed.gaps_found) ? parsed.gaps_found.slice(0, 10) : [],
    sections: parsed.sections
      .filter((s) => s && typeof s.h2 === 'string' && s.h2.trim())
      .map((s) => ({
        h2: s.h2.trim().slice(0, 200),
        intent: s.intent || 'informational',
        key_points: Array.isArray(s.key_points) ? s.key_points.slice(0, 10) : [],
        lsi_to_include: Array.isArray(s.lsi_to_include) ? s.lsi_to_include.slice(0, 8) : [],
        is_gap_fill: !!s.is_gap_fill,
        is_citable: s.is_citable !== false,
      })),
  };
}

/**
 * Build the SERP-driven outline.
 */
async function buildOutline({
  keyword,
  business,
  callClaude,
  fetchSerp,
  topK = DEFAULT_TOP_K_SERP,
  businessId,
  logger,
  metrics,
} = {}) {
  if (!callClaude) throw new Error('serp-outliner.buildOutline: callClaude required');
  if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
    throw new Error('serp-outliner.buildOutline: keyword required');
  }

  // Fetch SERP results — soft-fail to empty if unavailable
  let serpResults = [];
  if (typeof fetchSerp === 'function') {
    try {
      const r = await fetchSerp(keyword, { topK });
      if (Array.isArray(r)) serpResults = r.slice(0, topK);
    } catch (e) {
      logger?.warn?.('serp-outliner.fetchSerp', businessId, 'SERP fetch failed', { error: e.message });
    }
  }
  if (metrics?.increment) {
    metrics.increment('serp_outliner_runs_total', { keyword_bucket: keyword.length > 30 ? 'long' : 'short' });
    if (!serpResults.length) {
      metrics.increment('serp_outliner_empty_serp_total', {});
    }
  }

  const serpBlock = serpResults.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || ''}`).join('\n\n');

  const userMessage = [
    `KEYWORD: ${keyword}`,
    business?.business_name ? `BUSINESS: ${business.business_name} (${business.industry || 'unknown industry'})` : '',
    business?.country ? `COUNTRY: ${business.country}` : '',
    business?.primary_language ? `LANGUAGE: ${business.primary_language}` : '',
    '',
    serpResults.length
      ? `TOP ${serpResults.length} RANKING ARTICLES (for gap analysis):\n${serpBlock}`
      : 'NOTE: No SERP data available — build the outline from the keyword + business context.',
  ]
    .filter(Boolean)
    .join('\n');

  let raw;
  try {
    raw = await callClaude({
      system: _buildOutlineSystemPrompt(),
      user: userMessage,
      model: 'claude-sonnet-4-5',
      max_tokens: 2500,
      extra: {
        businessId,
        skill: 'serp_outliner_build',
        returnRaw: true,
      },
    });
  } catch (e) {
    logger?.warn?.('serp-outliner.buildOutline', businessId, 'callClaude failed', { error: e.message });
    return null;
  }
  const text = typeof raw === 'string' ? raw : raw?._raw || raw?.text || '';
  const outline = parseOutlineOutput(text);
  if (!outline) {
    if (metrics?.increment) metrics.increment('serp_outliner_malformed_total', {});
    logger?.warn?.('serp-outliner.buildOutline', businessId, 'outline parse failed');
    return null;
  }
  outline._serp_citations = serpResults.map((r) => ({ url: r.url, title: r.title }));
  return outline;
}

/**
 * Write the article section-by-section using the outline. Each section is
 * a separate Claude call so we bypass the single-call token limit AND get
 * proper depth on each section.
 *
 * Sections are written sequentially (not parallel) so each section can
 * reference the prior section's content for continuity. Parallel would
 * give us repetitive intros.
 */
async function writeArticle({ outline, callClaude, business, businessId, logger, metrics } = {}) {
  if (!callClaude) throw new Error('serp-outliner.writeArticle: callClaude required');
  if (!outline || !Array.isArray(outline.sections) || !outline.sections.length) {
    throw new Error('serp-outliner.writeArticle: outline with sections required');
  }
  const start = Date.now();
  const writtenSections = [];
  for (let i = 0; i < outline.sections.length; i++) {
    const section = outline.sections[i];
    const previousExcerpts = writtenSections
      .slice(-2)
      .map((w) => `# ${w.h2}\n${w.body.slice(0, 400)}…`)
      .join('\n\n');

    const userMessage = [
      `ARTICLE TITLE: ${outline.title}`,
      `PRIMARY ENTITY: ${outline.primary_entity}`,
      business?.business_name ? `BUSINESS: ${business.business_name}` : '',
      '',
      `THIS SECTION: ${section.h2}`,
      `Intent: ${section.intent}`,
      `Key points to cover:\n${section.key_points.map((p) => `  - ${p}`).join('\n')}`,
      section.lsi_to_include.length ? `LSI keywords to weave in: ${section.lsi_to_include.join(', ')}` : '',
      section.is_gap_fill ? '⚠️ This is a GAP-FILL section — competition has not covered this. Go deep.' : '',
      '',
      previousExcerpts ? `PRIOR SECTIONS (for continuity, do NOT repeat):\n${previousExcerpts}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const raw = await callClaude({
        system: _buildSectionSystemPrompt(),
        user: userMessage,
        model: 'claude-sonnet-4-5',
        max_tokens: 1200,
        extra: {
          businessId,
          skill: 'serp_outliner_write_section',
          returnRaw: true,
        },
      });
      const body = typeof raw === 'string' ? raw.trim() : (raw?._raw || raw?.text || '').trim();
      if (body) {
        writtenSections.push({ h2: section.h2, body, is_gap_fill: section.is_gap_fill });
      } else {
        if (metrics?.increment) metrics.increment('serp_outliner_section_empty_total', {});
        logger?.warn?.('serp-outliner.writeArticle', businessId, 'section returned empty', { sectionIndex: i });
      }
    } catch (e) {
      if (metrics?.increment) metrics.increment('serp_outliner_section_failed_total', {});
      logger?.warn?.('serp-outliner.writeArticle', businessId, 'section write failed', {
        sectionIndex: i,
        error: e.message,
      });
      // Continue — other sections still ship
    }
  }

  const totalWords = writtenSections.reduce((sum, s) => sum + s.body.split(/\s+/).length, 0);
  const duration = Date.now() - start;
  if (metrics?.observeHistogram) metrics.observeHistogram('serp_outliner_duration_ms', duration);

  return {
    title: outline.title,
    meta_description: outline.meta_description,
    primary_entity: outline.primary_entity,
    sections: writtenSections,
    total_words: totalWords,
    sections_attempted: outline.sections.length,
    sections_shipped: writtenSections.length,
    duration_ms: duration,
    serp_citations: outline._serp_citations || [],
  };
}

module.exports = {
  buildOutline,
  writeArticle,
  parseOutlineOutput,
  MIN_SECTIONS,
  MAX_SECTIONS,
};
