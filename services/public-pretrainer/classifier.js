'use strict';

/**
 * services/public-pretrainer/classifier.js
 * ---------------------------------------------------------------------------
 * Haiku-based classifier. Assigns each ingested example to:
 *   - an industry (must be one of the canonical IDs in lib/taxonomy/industries.js)
 *   - a region (ISO alpha-2 code, validated against lib/taxonomy/regions.js)
 *   - a format (the corpus format enum: meta_ad / google_ad / email / etc.)
 *
 * For ads + content we trust the source's region (the Meta Ad Library
 * "ad_reached_countries" field already tells us where the ad ran). For
 * industry we always classify via Haiku — the seed keyword we searched for
 * doesn't guarantee the ad is actually about that vertical.
 *
 * Cost model: Haiku 4.5 at ~$0.0001 per classification. Seeding 500k rows
 * = ~$50 one-time. Refresh of top performers weekly = ~$2/week.
 *
 * Public API:
 *
 *   classify({ callClaude, row, allowedIndustries, allowedFormats })
 *     → { industry, sub_industry, format, confidence, language?, notes? }
 *
 *   classifyBatch({ callClaude, rows, ... })
 *     → array of classification results, indexed the same as input rows
 *
 * Failure modes (soft):
 *   - callClaude throws        → returns { industry: 'smb_general', format, confidence: 0 }
 *   - JSON parse fails         → same fallback
 *   - LLM returns an invalid   → snapped to closest valid id, confidence -= 0.2
 *     industry / format
 * ---------------------------------------------------------------------------
 */

const { industries, expertSources } = require('../../lib/taxonomy');

const VALID_FORMATS = new Set([
  'meta_ad',
  'google_ad',
  'landing_page',
  'email',
  'social_post',
  'seo_article',
  'review',
  'case_study',
]);

function _buildClassifierSystemPrompt({ allowedIndustries, allowedFormats }) {
  const indList = allowedIndustries
    .map((i) => {
      const meta = industries.getById(i);
      return meta ? `  - ${meta.id}: ${meta.label}` : `  - ${i}`;
    })
    .join('\n');
  return `You are a marketing taxonomist. You will receive one piece of marketing content (an ad, an email, a landing page, a review, etc.) and assign it to one of the following industries and formats.

VALID INDUSTRY IDs (use exactly one):
${indList}

VALID FORMAT IDs (use exactly one):
${Array.from(allowedFormats)
  .map((f) => `  - ${f}`)
  .join('\n')}

Output ONLY this JSON, no prose, no markdown:

{
  "industry": "<one of the valid industry IDs>",
  "format": "<one of the valid format IDs>",
  "language": "<ISO 639-1 code if detectable>",
  "confidence": <0.0..1.0>,
  "notes": "<one short sentence about why this industry was chosen>"
}

Rules:
- If the content is generic SMB marketing not matching any specific industry, use 'smb_general'.
- Confidence: 0.9+ for obvious matches, 0.5-0.7 for plausible, <0.5 for guessing.
- Don't invent industry or format IDs. If unsure, pick the closest valid ID.`;
}

function parseClassifierOutput(rawText) {
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
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed;
}

function _snapIndustry(claimed, allowedIndustries) {
  if (!claimed) return { snapped: 'smb_general', wasSnapped: true };
  const normalized = String(claimed).toLowerCase().trim();
  if (allowedIndustries.includes(normalized)) {
    return { snapped: normalized, wasSnapped: false };
  }
  // Try fuzzy match on industry labels
  for (const id of allowedIndustries) {
    const meta = industries.getById(id);
    if (meta && meta.label.toLowerCase().includes(normalized)) {
      return { snapped: id, wasSnapped: true };
    }
  }
  return { snapped: 'smb_general', wasSnapped: true };
}

function _snapFormat(claimed, allowedFormats) {
  const normalized = String(claimed || '')
    .toLowerCase()
    .trim();
  if (allowedFormats.has(normalized)) return { snapped: normalized, wasSnapped: false };
  return { snapped: 'meta_ad', wasSnapped: true };
}

/**
 * Classify a single row.
 *
 * @param {object} args
 * @param {function} args.callClaude  the standard callClaude interface
 * @param {object}   args.row         { body, title?, source?, page_name?, ... }
 * @param {string[]} args.allowedIndustries  default: full taxonomy
 * @param {Set<string>} args.allowedFormats   default: VALID_FORMATS
 * @param {string}   args.formatHint  if the source already implies a format
 *                                    (e.g. meta_ad), pass it; we still ask
 *                                    Haiku to confirm or correct.
 */
async function classify({ callClaude, row, allowedIndustries, allowedFormats, formatHint, businessId, skill } = {}) {
  if (!callClaude) throw new Error('classifier.classify: callClaude required');
  if (!row || !row.body) return null;

  const _allowedIndustries = allowedIndustries || industries.getAllIds();
  const _allowedFormats = allowedFormats || VALID_FORMATS;

  const system = _buildClassifierSystemPrompt({
    allowedIndustries: _allowedIndustries,
    allowedFormats: _allowedFormats,
  });
  const userBlocks = [
    `Title: ${row.title || '(none)'}`,
    `Body: ${String(row.body).slice(0, 1500)}`,
    row.cta ? `CTA: ${row.cta}` : '',
    row.page_name ? `Brand/Page: ${row.page_name}` : '',
    row.source ? `Source: ${row.source}` : '',
    formatHint ? `(Format hint from source: ${formatHint})` : '',
  ].filter(Boolean);
  const user = userBlocks.join('\n');

  let raw;
  try {
    raw = await callClaude({
      system,
      user,
      model: 'claude-haiku-4-5',
      max_tokens: 250,
      extra: {
        businessId,
        skill: skill || 'pretrainer_classifier',
        skipBrandVoice: true,
        returnRaw: true,
      },
    });
  } catch {
    return {
      industry: 'smb_general',
      format: formatHint && _allowedFormats.has(formatHint) ? formatHint : 'meta_ad',
      language: null,
      confidence: 0,
      notes: 'callClaude failed',
    };
  }

  const text = typeof raw === 'string' ? raw : raw?._raw || raw?.text || '';
  const parsed = parseClassifierOutput(text);
  if (!parsed) {
    return {
      industry: 'smb_general',
      format: formatHint && _allowedFormats.has(formatHint) ? formatHint : 'meta_ad',
      language: null,
      confidence: 0,
      notes: 'malformed classifier output',
    };
  }

  const indSnap = _snapIndustry(parsed.industry, _allowedIndustries);
  const fmtSnap = _snapFormat(parsed.format || formatHint, _allowedFormats);

  let confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
  if (indSnap.wasSnapped) confidence = Math.max(0, confidence - 0.2);
  if (fmtSnap.wasSnapped) confidence = Math.max(0, confidence - 0.1);

  return {
    industry: indSnap.snapped,
    format: fmtSnap.snapped,
    language: typeof parsed.language === 'string' ? parsed.language.toLowerCase() : null,
    confidence: Number(confidence.toFixed(3)),
    notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 200) : '',
  };
}

/**
 * Classify multiple rows. Currently sequential — Haiku is cheap enough
 * that we keep this simple and avoid bursting rate limits. Future:
 * batch with a concurrency limiter.
 */
async function classifyBatch({ callClaude, rows, allowedIndustries, allowedFormats, formatHint }) {
  const out = [];
  for (const row of rows) {
    out.push(await classify({ callClaude, row, allowedIndustries, allowedFormats, formatHint }));
  }
  return out;
}

module.exports = {
  classify,
  classifyBatch,
  parseClassifierOutput,
  VALID_FORMATS,
};
