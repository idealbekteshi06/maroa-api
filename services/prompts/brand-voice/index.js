'use strict';

/**
 * services/prompts/brand-voice/index.js
 * ----------------------------------------------------------------------------
 * Brand Voice Anchor — single source-of-truth voice per business.
 *
 * Public API:
 *   buildAnchor({ business, vocAnalysis }) → brand_voice_anchor object
 *   formatAnchorForPrompt(anchor) → compact text block for LLM injection
 *   isStale(anchor) → bool
 *   mergeManualOverrides(auto, manual) → merged anchor
 *
 * Used by:
 *   - creative-director (to anchor concept generation)
 *   - ad-optimizer (to anchor decision_reason narrative)
 *   - ai-seo (to anchor llms.txt + page rewrite voice)
 *   - cro (to anchor hero/CTA rewrites)
 *   - voice-polish (as the rewrite anchor target)
 *   - weekly-scorecard (to anchor commentary tone)
 * ----------------------------------------------------------------------------
 */

const industryDefaults = require('./industry-defaults');
const adI18n = require('../ad-optimizer/i18n-market');

const STALE_AFTER_DAYS = 90;
const SCHEMA_VERSION = 1;

// ─── Build anchor from inputs ──────────────────────────────────────────────

/**
 * buildAnchor — produces a brand_voice_anchor from business profile + optional VOC.
 *
 * Inputs:
 *   business        — businesses + business_profiles row (merged)
 *   vocAnalysis     — optional: most recent voc_analyses row (or null)
 *   manualOverrides — optional: customer-edited fields to preserve
 *
 * Returns full anchor object.
 */
function buildAnchor({ business, vocAnalysis, manualOverrides }) {
  const industry = String(business?.industry || business?.business_type || '').toLowerCase();
  const market = adI18n.buildMarketProfile(business);
  const primaryLang = market.primary_language || 'en';

  // Start from industry defaults
  const defaults = industryDefaults.defaultsForIndustry(industry);

  // Merge in onboarding signals
  const onboardingTone = Array.isArray(business?.tone_keywords) ? business.tone_keywords : [];
  const neverDo = business?.never_do || '';
  const audience = business?.audience_description || '';
  const weDoBetter = business?.we_do_better || '';
  const painPoint = business?.pain_point || '';

  const tone_descriptors = onboardingTone.length
    ? [...new Set([...onboardingTone, ...defaults.tone_descriptors])].slice(0, 5)
    : defaults.tone_descriptors;

  // Merge in VOC verbatim phrases as do_words (high signal — actual customer language)
  const vocPhrases = [];
  if (vocAnalysis?.pain_points) {
    for (const p of vocAnalysis.pain_points.slice(0, 3)) {
      if (Array.isArray(p.verbatim_quotes)) {
        for (const q of p.verbatim_quotes.slice(0, 2)) {
          // Extract concrete nouns from quote
          const tokens = String(q).match(/\b[a-zçëâäöüáéíóúñ]{4,}\b/giu) || [];
          for (const t of tokens) {
            if (t.length >= 4 && t.length <= 14) vocPhrases.push(t.toLowerCase());
          }
        }
      }
    }
  }
  const do_words = [...new Set([
    ...defaults.do_words,
    ...vocPhrases.slice(0, 6),
  ])].slice(0, 12);

  // Merge in never_do from onboarding
  const customNeverDo = String(neverDo).toLowerCase().match(/[a-zçëâäöü]+/giu) || [];
  const do_not_words = [...new Set([
    ...defaults.do_not_words,
    ...customNeverDo.filter(w => w.length >= 4).slice(0, 10),
  ])];

  // Address-as defaults (locale-specific)
  const addressAs = _addressAsForLocale(primaryLang, defaults.formality_level || 5);

  // Build exemplar paragraph (template-based, deterministic)
  const exemplar = _buildExemplar({ business, defaults, audience });

  const anchor = {
    tone_descriptors,
    voice_register: defaults.voice_register,
    sentence_length_preference: defaults.sentence_length_preference,
    vocabulary_style: defaults.vocabulary_style,
    exemplar_paragraph: exemplar,
    do_words,
    do_not_words,
    punctuation_style: defaults.punctuation_style,
    formality_level: defaults.formality_level,
    humor_level: defaults.humor_level,
    industry_metaphors_allowed: defaults.industry_metaphors_allowed,
    audience_addresses_as: addressAs,
    language_primary: primaryLang,
    languages_secondary: business?.secondary_languages || [],
    derived_from: [
      'industry-defaults',
      onboardingTone.length ? 'onboarding' : null,
      vocAnalysis ? `voc-analysis-${vocAnalysis.id || 'latest'}` : null,
    ].filter(Boolean),
    confidence: _confidenceLevel({ onboardingTone, vocAnalysis }),
    version: SCHEMA_VERSION,
    regenerated_at: new Date().toISOString(),
    stale_after_days: STALE_AFTER_DAYS,
  };

  // Apply manual overrides last (they always win)
  if (manualOverrides && typeof manualOverrides === 'object') {
    for (const [k, v] of Object.entries(manualOverrides)) {
      if (v !== undefined && v !== null) {
        anchor[k] = v;
      }
    }
    anchor.derived_from.push('manual-override');
  }

  return anchor;
}

// ─── Format for prompt injection ──────────────────────────────────────────

/**
 * Format the anchor as a compact text block (~300-400 tokens) ready to inject
 * into any LLM system prompt.
 */
function formatAnchorForPrompt(anchor) {
  if (!anchor) return '';
  const lines = [
    '# BRAND VOICE FOR THIS BUSINESS (use it consistently)',
    '',
    `Tone: ${(anchor.tone_descriptors || []).join(', ')}`,
    `Register: ${anchor.voice_register || 'professional-conversational'}`,
    `Sentence length: ${anchor.sentence_length_preference || 'short'}`,
    `Vocabulary: ${anchor.vocabulary_style || 'everyday'}`,
    `Punctuation: ${anchor.punctuation_style || 'minimal'}`,
    `Formality (1-10): ${anchor.formality_level ?? 5}`,
    `Humor (0-10): ${anchor.humor_level ?? 3}`,
  ];
  if (anchor.do_words?.length) {
    lines.push(`USE these words: ${anchor.do_words.slice(0, 12).join(', ')}`);
  }
  if (anchor.do_not_words?.length) {
    lines.push(`AVOID these words: ${anchor.do_not_words.slice(0, 12).join(', ')}`);
  }
  if (anchor.industry_metaphors_allowed?.length) {
    lines.push(`Metaphor library: ${anchor.industry_metaphors_allowed.join(', ')}`);
  }
  if (anchor.audience_addresses_as) {
    lines.push(`Address customers as: ${anchor.audience_addresses_as}`);
  }
  lines.push(`Language: ${anchor.language_primary || 'en'}`);
  if (anchor.exemplar_paragraph) {
    lines.push('');
    lines.push('Sample of how this brand speaks (mimic the rhythm + word choice):');
    lines.push(`"${anchor.exemplar_paragraph}"`);
  }
  if (anchor.confidence === 'low' || anchor.confidence === 'minimal') {
    lines.push('');
    lines.push('NOTE: voice anchor confidence is LOW (limited onboarding/VOC data). Use industry defaults conservatively.');
  }
  return lines.join('\n');
}

// ─── Staleness ─────────────────────────────────────────────────────────────

function isStale(anchor) {
  if (!anchor || !anchor.regenerated_at) return true;
  const days = anchor.stale_after_days || STALE_AFTER_DAYS;
  const ageMs = Date.now() - new Date(anchor.regenerated_at).getTime();
  return ageMs > days * 86400000;
}

// ─── Manual override merge ─────────────────────────────────────────────────

function mergeManualOverrides(auto, manual) {
  if (!manual || typeof manual !== 'object') return auto;
  return {
    ...auto,
    ...manual,
    derived_from: [...(auto?.derived_from || []), 'manual-override'],
  };
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function _confidenceLevel({ onboardingTone, vocAnalysis }) {
  let score = 0;
  if (onboardingTone && onboardingTone.length) score += 1;
  if (vocAnalysis && (vocAnalysis.total_reviews_analyzed || 0) >= 20) score += 2;
  else if (vocAnalysis && (vocAnalysis.total_reviews_analyzed || 0) >= 5) score += 1;
  if (score >= 3) return 'high';
  if (score >= 2) return 'medium';
  if (score >= 1) return 'low';
  return 'minimal';
}

function _addressAsForLocale(lang, formalityLevel) {
  switch (lang) {
    case 'es': return formalityLevel >= 6 ? 'usted (formal)' : 'tú (informal)';
    case 'de': return formalityLevel >= 6 ? 'Sie (formal)' : 'du (informal)';
    case 'fr': return formalityLevel >= 6 ? 'vous (formal)' : 'tu (informal)';
    case 'it': return formalityLevel >= 6 ? 'Lei (formal)' : 'tu (informal)';
    case 'pt': return formalityLevel >= 6 ? 'você (formal)' : 'tu (informal)';
    case 'sq': return formalityLevel >= 6 ? 'ju (formal)' : 'ti (informal)';
    case 'tr': return formalityLevel >= 6 ? 'siz (formal)' : 'sen (informal)';
    default:   return formalityLevel >= 6 ? 'you (formal)' : 'you (direct)';
  }
}

function _buildExemplar({ business, defaults, audience }) {
  // Deterministic template — caller can replace with LLM-generated exemplar
  const name = business?.business_name || 'this business';
  const isLocal = business?.operation_model === 'location_based' || business?.operation_model === 'hybrid';
  const lang = business?.primary_language || 'en';

  // Simple language-aware templates (deterministic — caller can re-generate via LLM)
  if (lang === 'sq') {
    return isLocal
      ? `${name} ka punuar që nga 2018. Sjellim cilësi dhe staf të dobishëm. Hap çdo ditë.`
      : `${name} ndihmon ${audience || 'klientët tanë'}. Pa fjalë boshe — vetëm rezultate.`;
  }
  if (lang === 'es') {
    return isLocal
      ? `${name} abrió en 2018. Lo que prometemos lo cumplimos. Estamos abiertos todos los días.`
      : `${name} ayuda a ${audience || 'nuestros clientes'} a hacer el trabajo. Sin promesas vacías.`;
  }
  if (lang === 'de') {
    return isLocal
      ? `${name}, seit 2018. Wir machen unsere Arbeit gut. Täglich geöffnet.`
      : `${name} hilft ${audience || 'unseren Kunden'} weiter. Kein Bullshit, nur Ergebnisse.`;
  }
  if (lang === 'it') {
    return isLocal
      ? `${name}, dal 2018. Facciamo bene il nostro lavoro. Aperti tutti i giorni.`
      : `${name} aiuta ${audience || 'i nostri clienti'}. Niente promesse vuote, solo risultati.`;
  }
  if (lang === 'fr') {
    return isLocal
      ? `${name}, depuis 2018. Notre travail est bien fait. Ouvert tous les jours.`
      : `${name} aide ${audience || 'nos clients'}. Pas de bla-bla, juste des résultats.`;
  }
  // English fallback (default)
  const tones = (defaults.tone_descriptors || ['clear']).slice(0, 2).join(', ');
  return isLocal
    ? `${name} since 2018. We keep things ${tones}. Open every day.`
    : `${name} helps ${audience || 'small businesses'} get the job done. No fluff, just results.`;
}

module.exports = {
  STALE_AFTER_DAYS,
  SCHEMA_VERSION,
  buildAnchor,
  formatAnchorForPrompt,
  isStale,
  mergeManualOverrides,
  industryDefaults,
};
