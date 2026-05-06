'use strict';

/**
 * services/prompts/voice-polish/slop-patterns.js
 * ----------------------------------------------------------------------------
 * AI-slop detection patterns. 60+ tells across 12 languages.
 *
 * Each pattern has:
 *   id        — stable identifier (AI001 etc.)
 *   language  — ISO 639-1 code
 *   pattern   — RegExp
 *   penalty   — 1-10 weight (10 = severe AI tell)
 *   category  — 'opener' | 'transition' | 'buzzword' | 'hedge' | 'filler' | 'cliche'
 *
 * Every pattern was selected by:
 *   1. Appearing frequently in Claude/GPT default outputs
 *   2. Rarely appearing in real human marketing copy
 *   3. Being recognizable at first read
 *
 * This is the deterministic detector — feeds the LLM rewrite step.
 * ----------------------------------------------------------------------------
 */

const SLOP_PATTERNS = [
  // ─── ENGLISH (most common) ──────────────────────────────────────────────
  { id: 'AI001', language: 'en', pattern: /\bit'?s\s+worth\s+noting\s+that\b/i, penalty: 9, category: 'opener' },
  { id: 'AI002', language: 'en', pattern: /\bin\s+today'?s\s+(?:fast.?paced|digital|modern|competitive)\s+(?:world|landscape|environment)\b/i, penalty: 10, category: 'opener' },
  { id: 'AI003', language: 'en', pattern: /\b(?:let'?s\s+)?dive\s+(?:right\s+)?(?:in)?(?:to)\b/i, penalty: 8, category: 'transition' },
  { id: 'AI004', language: 'en', pattern: /\b(?:leverage|leveraging|leveraged)\b/i, penalty: 7, category: 'buzzword' },
  { id: 'AI005', language: 'en', pattern: /\b(?:elevate|elevating)\s+your\b/i, penalty: 9, category: 'buzzword' },
  { id: 'AI006', language: 'en', pattern: /\b(?:navigate|navigating)\s+(?:the\s+)?complexities\b/i, penalty: 9, category: 'cliche' },
  { id: 'AI007', language: 'en', pattern: /\bworld.?class\b/i, penalty: 7, category: 'buzzword' },
  { id: 'AI008', language: 'en', pattern: /\bcutting.?edge\b/i, penalty: 7, category: 'buzzword' },
  { id: 'AI009', language: 'en', pattern: /\b(?:innovative|innovation|innovate)\b/i, penalty: 5, category: 'buzzword' },
  { id: 'AI010', language: 'en', pattern: /\b(?:robust|robustly)\b/i, penalty: 5, category: 'buzzword' },
  { id: 'AI011', language: 'en', pattern: /\bbest.in.class\b/i, penalty: 7, category: 'buzzword' },
  { id: 'AI012', language: 'en', pattern: /\bgame.?(?:changing|changer)\b/i, penalty: 8, category: 'buzzword' },
  { id: 'AI013', language: 'en', pattern: /\b(?:revolutionary|revolutionize)\b/i, penalty: 8, category: 'buzzword' },
  { id: 'AI014', language: 'en', pattern: /\bdisruptive\b/i, penalty: 7, category: 'buzzword' },
  { id: 'AI015', language: 'en', pattern: /\b(?:seamlessly|seamless)\s+integrat/i, penalty: 8, category: 'cliche' },
  { id: 'AI016', language: 'en', pattern: /\bsynerg(?:y|ies|istic)\b/i, penalty: 9, category: 'buzzword' },
  { id: 'AI017', language: 'en', pattern: /\bturn.?key\b/i, penalty: 6, category: 'buzzword' },
  { id: 'AI018', language: 'en', pattern: /\b(?:streamline|streamlining)\b/i, penalty: 5, category: 'buzzword' },
  { id: 'AI019', language: 'en', pattern: /\bend.?to.?end\s+(?:solution|experience)\b/i, penalty: 7, category: 'cliche' },
  { id: 'AI020', language: 'en', pattern: /\b(?:furthermore|moreover)\b/i, penalty: 6, category: 'transition' },
  { id: 'AI021', language: 'en', pattern: /\b(?:in\s+conclusion|to\s+conclude|to\s+sum\s+up)\b/i, penalty: 7, category: 'transition' },
  { id: 'AI022', language: 'en', pattern: /\b(?:I\s+understand|I\s+can\s+see)\s+(?:that|how)\s+you\b/i, penalty: 8, category: 'hedge' },
  { id: 'AI023', language: 'en', pattern: /\b(?:certainly|absolutely|definitely)!?(?:\s+|$)/i, penalty: 5, category: 'hedge' },
  { id: 'AI024', language: 'en', pattern: /\bdelve\s+(?:into|deeper)\b/i, penalty: 9, category: 'transition' },
  { id: 'AI025', language: 'en', pattern: /\btapestry\b/i, penalty: 9, category: 'cliche' },
  { id: 'AI026', language: 'en', pattern: /\bplethora\s+of\b/i, penalty: 8, category: 'filler' },
  { id: 'AI027', language: 'en', pattern: /\bunlock\s+(?:the\s+)?(?:power|potential)\b/i, penalty: 8, category: 'cliche' },
  { id: 'AI028', language: 'en', pattern: /\btake\s+(?:your|it)\s+to\s+the\s+next\s+level\b/i, penalty: 9, category: 'cliche' },
  { id: 'AI029', language: 'en', pattern: /\b(?:embark|embarking)\s+on\s+(?:a|this)\s+journey\b/i, penalty: 9, category: 'cliche' },
  { id: 'AI030', language: 'en', pattern: /\bpioneer(?:ing)?\b/i, penalty: 5, category: 'buzzword' },
  { id: 'AI031', language: 'en', pattern: /\bunparalleled\b/i, penalty: 6, category: 'buzzword' },
  { id: 'AI032', language: 'en', pattern: /\bnext.?gen(?:eration)?\b/i, penalty: 5, category: 'buzzword' },
  { id: 'AI033', language: 'en', pattern: /\b(?:from\s+small\s+businesses\s+to\s+enterprises|whether\s+you'?re\s+a)\b/i, penalty: 7, category: 'cliche' },
  { id: 'AI034', language: 'en', pattern: /\bharness(?:ing)?\s+the\s+power\b/i, penalty: 8, category: 'cliche' },
  { id: 'AI035', language: 'en', pattern: /\bpower\s+of\s+(?:AI|technology|automation)\b/i, penalty: 6, category: 'cliche' },

  // ─── ALBANIAN ──────────────────────────────────────────────────────────
  { id: 'AI051', language: 'sq', pattern: /\bduhet\s+thënë\s+që\b/i, penalty: 9, category: 'opener' },
  { id: 'AI052', language: 'sq', pattern: /\bnë\s+botën\s+e\s+sotme\b/i, penalty: 10, category: 'opener' },
  { id: 'AI053', language: 'sq', pattern: /\bshfrytëzo(?:ni)?\s+fuqinë\b/i, penalty: 8, category: 'cliche' },
  { id: 'AI054', language: 'sq', pattern: /\bnivelin\s+tjetër\b/i, penalty: 9, category: 'cliche' },
  { id: 'AI055', language: 'sq', pattern: /\bpa\s+kufi\b/i, penalty: 6, category: 'buzzword' },
  { id: 'AI056', language: 'sq', pattern: /\brevolucionar\b/i, penalty: 7, category: 'buzzword' },

  // ─── SPANISH ───────────────────────────────────────────────────────────
  { id: 'AI071', language: 'es', pattern: /\ben\s+el\s+mundo\s+(?:actual|de\s+hoy)\b/i, penalty: 10, category: 'opener' },
  { id: 'AI072', language: 'es', pattern: /\bsumérgete\s+en\b/i, penalty: 9, category: 'transition' },
  { id: 'AI073', language: 'es', pattern: /\bllevar?\s+(?:tu|su)\s+\w+\s+al\s+(?:siguiente|próximo)\s+nivel\b/i, penalty: 9, category: 'cliche' },
  { id: 'AI074', language: 'es', pattern: /\bsoluciones?\s+integral(?:es)?\b/i, penalty: 7, category: 'buzzword' },
  { id: 'AI075', language: 'es', pattern: /\bvanguardista\b/i, penalty: 7, category: 'buzzword' },
  { id: 'AI076', language: 'es', pattern: /\brevoluciona(?:r|rio)\b/i, penalty: 7, category: 'buzzword' },

  // ─── FRENCH ────────────────────────────────────────────────────────────
  { id: 'AI091', language: 'fr', pattern: /\bdans\s+le\s+monde\s+(?:actuel|d'?aujourd'?hui)\b/i, penalty: 10, category: 'opener' },
  { id: 'AI092', language: 'fr', pattern: /\bplongez\s+(?:dans|au\s+coeur)\b/i, penalty: 9, category: 'transition' },
  { id: 'AI093', language: 'fr', pattern: /\bportez\s+(?:votre|vos)\s+\w+\s+au\s+niveau\s+supérieur\b/i, penalty: 9, category: 'cliche' },
  { id: 'AI094', language: 'fr', pattern: /\bsolutions?\s+(?:innovantes?|de\s+pointe)\b/i, penalty: 7, category: 'buzzword' },
  { id: 'AI095', language: 'fr', pattern: /\b(?:révolutionnaire|révolutionner)\b/i, penalty: 7, category: 'buzzword' },

  // ─── GERMAN ────────────────────────────────────────────────────────────
  { id: 'AI111', language: 'de', pattern: /\bin\s+der\s+heutigen\s+(?:digitalen|schnelllebigen)\s+welt\b/i, penalty: 10, category: 'opener' },
  { id: 'AI112', language: 'de', pattern: /\b(?:tauchen\s+sie\s+ein|eintauchen\s+in)\b/i, penalty: 9, category: 'transition' },
  { id: 'AI113', language: 'de', pattern: /\bauf\s+das\s+nächste\s+(?:level|niveau)\b/i, penalty: 9, category: 'cliche' },
  { id: 'AI114', language: 'de', pattern: /\bganzheitliche?\s+lösung(?:en)?\b/i, penalty: 7, category: 'buzzword' },
  { id: 'AI115', language: 'de', pattern: /\bzukunftsweisend\b/i, penalty: 6, category: 'buzzword' },

  // ─── ITALIAN ───────────────────────────────────────────────────────────
  { id: 'AI131', language: 'it', pattern: /\bnel\s+mondo\s+(?:di\s+oggi|attuale)\b/i, penalty: 10, category: 'opener' },
  { id: 'AI132', language: 'it', pattern: /\bimmergiti\s+(?:nel|nella)\b/i, penalty: 9, category: 'transition' },
  { id: 'AI133', language: 'it', pattern: /\b(?:porta|portare)\s+(?:il\s+tuo|i\s+tuoi)\s+\w+\s+al\s+livello\s+successivo\b/i, penalty: 9, category: 'cliche' },
  { id: 'AI134', language: 'it', pattern: /\bsoluzion[ei]\s+(?:innovative?|all'avanguardia)\b/i, penalty: 7, category: 'buzzword' },
  { id: 'AI135', language: 'it', pattern: /\b(?:rivoluzionario|rivoluzionare)\b/i, penalty: 7, category: 'buzzword' },

  // ─── PORTUGUESE ─────────────────────────────────────────────────────────
  { id: 'AI151', language: 'pt', pattern: /\bno\s+mundo\s+(?:de\s+hoje|atual)\b/i, penalty: 10, category: 'opener' },
  { id: 'AI152', language: 'pt', pattern: /\bmergulhe\s+(?:no|na)\b/i, penalty: 9, category: 'transition' },
  { id: 'AI153', language: 'pt', pattern: /\b(?:leve|levar)\s+(?:o\s+seu|a\s+sua)\s+\w+\s+(?:ao|para)\s+(?:próximo|outro)\s+nível\b/i, penalty: 9, category: 'cliche' },
  { id: 'AI154', language: 'pt', pattern: /\bsoluç[õo]es?\s+(?:inovadora?s?|de\s+ponta)\b/i, penalty: 7, category: 'buzzword' },
  { id: 'AI155', language: 'pt', pattern: /\b(?:revolucionário|revolucionar)\b/i, penalty: 7, category: 'buzzword' },

  // ─── DUTCH ──────────────────────────────────────────────────────────────
  { id: 'AI171', language: 'nl', pattern: /\bin\s+de\s+(?:huidige|hedendaagse)\s+wereld\b/i, penalty: 10, category: 'opener' },
  { id: 'AI172', language: 'nl', pattern: /\bduik\s+in\b/i, penalty: 8, category: 'transition' },
  { id: 'AI173', language: 'nl', pattern: /\bnaar\s+het\s+volgende\s+niveau\b/i, penalty: 8, category: 'cliche' },

  // ─── TURKISH ────────────────────────────────────────────────────────────
  { id: 'AI191', language: 'tr', pattern: /\bgünümüzün\s+(?:hızlı|dijital|rekabetçi)\s+dünyasında\b/i, penalty: 10, category: 'opener' },
  { id: 'AI192', language: 'tr', pattern: /\bbir\s+sonraki\s+seviyeye\b/i, penalty: 8, category: 'cliche' },

  // ─── SERBIAN / CROATIAN ────────────────────────────────────────────────
  { id: 'AI211', language: 'sr', pattern: /\bu\s+današnjem\s+(?:digitalnom|brzom)\s+svetu\b/i, penalty: 10, category: 'opener' },
  { id: 'AI212', language: 'hr', pattern: /\bu\s+današnjem\s+(?:digitalnom|brzom)\s+svijetu\b/i, penalty: 10, category: 'opener' },

  // ─── ARABIC ─────────────────────────────────────────────────────────────
  { id: 'AI231', language: 'ar', pattern: /في\s+عالم\s+اليوم/i, penalty: 10, category: 'opener' },
  { id: 'AI232', language: 'ar', pattern: /انتقل\s+إلى\s+المستوى\s+التالي/i, penalty: 8, category: 'cliche' },

  // ─── HEDGE / META PATTERNS (any language, often AI-flavored) ───────────
  { id: 'AI301', language: 'any', pattern: /\bAs\s+an\s+AI\b/i, penalty: 10, category: 'meta' },
  { id: 'AI302', language: 'any', pattern: /\b(?:I\s+hope\s+this\s+helps|hope\s+this\s+helps)\b/i, penalty: 6, category: 'meta' },
  { id: 'AI303', language: 'any', pattern: /\b(?:please\s+let\s+me\s+know|feel\s+free\s+to\s+ask)\b/i, penalty: 6, category: 'meta' },
];

/**
 * Detect slop in a piece of text. Returns analysis object.
 *
 * @param {string} text  Input text
 * @param {string} [lang] Optional language hint (else detected)
 * @returns {{ slop_score: number, flagged_phrases: Array, language: string }}
 */
function detectSlop(text, lang) {
  if (!text || typeof text !== 'string') {
    return { slop_score: 0, flagged_phrases: [], language: lang || 'unknown' };
  }
  const flagged = [];
  let totalPenalty = 0;
  let detectedLang = lang || _detectLang(text);

  // Pass 1 — scan every pattern (language gate would miss legitimate matches
  // when our cheap language detector picks the wrong language). Multi-word
  // language-specific idioms have negligible cross-language false-positive risk.
  for (const p of SLOP_PATTERNS) {
    const m = text.match(p.pattern);
    if (m) {
      flagged.push({
        phrase: m[0],
        pattern_id: p.id,
        category: p.category,
        language: p.language,
      });
      totalPenalty += p.penalty;
    }
  }

  // Use fired-pattern languages to confirm detected language if heuristic failed
  if (flagged.length) {
    const langCounts = {};
    for (const f of flagged) {
      if (f.language === 'any') continue;
      langCounts[f.language] = (langCounts[f.language] || 0) + 1;
    }
    const top = Object.entries(langCounts).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 1 && (!lang || detectedLang === 'en')) {
      detectedLang = top[0]; // override if patterns strongly suggest different language
    }
  }

  // Normalize to 0-100 scale, capped. Multiplier 12 calibrated so a single
  // severity-10 AI tell in a typical sentence scores ~35 (above the
  // should_rewrite threshold).
  const wordCount = (text.match(/\S+/g) || []).length;
  const density = wordCount > 0 ? totalPenalty / Math.sqrt(wordCount) : 0;
  const score = Math.min(100, Math.round(density * 12));

  return {
    slop_score: score,
    flagged_phrases: flagged,
    language: detectedLang,
  };
}

/**
 * Specificity score — counts numbers, named entities, dates, prices.
 * High specificity = low AI feel even if other slop tells exist.
 */
function specificityScore(text) {
  if (!text || typeof text !== 'string') return 0;

  let score = 30; // baseline

  // Numbers (counts, percentages, prices)
  const numberCount = (text.match(/\b\d+(?:[.,]\d+)?\b/g) || []).length;
  score += Math.min(20, numberCount * 4);

  // Currency symbols (€, $, £, ¥, ﷼, etc.)
  const currencyCount = (text.match(/[€$£¥₹₺₽﷼₪]/g) || []).length;
  score += Math.min(10, currencyCount * 5);

  // Time-of-day patterns (9am, 17:00, etc.)
  const timeCount = (text.match(/\b\d{1,2}[:.]?\d{0,2}\s*(?:am|pm|h|UTC|EST|GMT|CET)?\b/gi) || []).length;
  score += Math.min(10, timeCount * 3);

  // Proper nouns (capitalized words mid-sentence — quick heuristic)
  const properNouns = (text.match(/(?<=[.,!?]\s|^)[A-Z][a-zçëâäöüáéíóúñ]+/g) || []).length;
  score -= properNouns * 0.5; // first-word-capitalized doesn't count, this filters those out — tweak

  const allCapWords = (text.match(/(?<!^)(?<![.!?]\s)\b[A-Z][a-z]+\b/g) || []).length;
  score += Math.min(15, allCapWords * 2);

  // Penalty for vague quantifiers
  const vagueCount = (text.match(/\b(?:many|several|various|a\s+lot|numerous|countless|tons\s+of)\b/gi) || []).length;
  score -= vagueCount * 5;

  return Math.max(0, Math.min(100, score));
}

/**
 * Coarse language detection (re-uses ad-optimizer's detector for consistency).
 */
function _detectLang(text) {
  try {
    const adI18n = require('../ad-optimizer/i18n-market');
    return adI18n.detectLanguage(text) || 'en';
  } catch {
    return 'en';
  }
}

/**
 * Should we run an LLM rewrite on this text?
 * Returns true if slop is significant AND specificity isn't already high.
 */
function shouldRewrite({ slop_score, specificity_score, text_length }) {
  if (text_length < 20) return false;
  if (slop_score < 30) return false;
  // High specificity + medium slop → still acceptable
  if (slop_score < 50 && specificity_score >= 70) return false;
  return true;
}

module.exports = {
  SLOP_PATTERNS,
  detectSlop,
  specificityScore,
  shouldRewrite,
};
