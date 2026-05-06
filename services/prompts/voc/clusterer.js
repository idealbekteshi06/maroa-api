'use strict';

/**
 * services/prompts/voc/clusterer.js
 * ----------------------------------------------------------------------------
 * Pure-deterministic helpers for VOC analysis.
 *
 * Provides:
 *   detectLanguage(text)        — coarse language classifier (10+ langs)
 *   normalizeReviews(rows)      — flatten heterogeneous source data
 *   sentimentBucket(rating, text) — quick positive/neutral/negative bucket
 *   dedupeQuotes(quotes)        — fuzzy near-duplicate filtering
 *   clusterByKeyword(reviews, n) — keyword frequency clustering
 *   trendSentiment(reviews, days) — time-windowed sentiment
 *   detectCompetitorMentions(reviews, knownCompetitors) — mention extraction
 * ----------------------------------------------------------------------------
 */

// ─── Coarse language detection (re-uses ad-optimizer's detector) ───────────
const adI18n = require('../ad-optimizer/i18n-market');
const detectLanguage = adI18n.detectLanguage;

// ─── Normalize heterogeneous review sources into one shape ─────────────────
/**
 * Each input source has a different shape. Normalize to:
 *   { id, source, text, rating, lang, author, created_at }
 */
function normalizeReviews({ google = [], facebook = [], instagram = [], email = [] }) {
  const out = [];
  for (const r of google || []) {
    out.push({
      id: r.review_id || r.id || `g_${out.length}`,
      source: 'google',
      text: String(r.snippet || r.text || '').trim(),
      rating: Number.isFinite(Number(r.rating)) ? Number(r.rating) : null,
      lang: detectLanguage(r.snippet || r.text || ''),
      author: anonymizeAuthor(r.user?.name || r.author || ''),
      created_at: r.iso_date || r.created_at || null,
    });
  }
  for (const r of facebook || []) {
    out.push({
      id: r.id || `f_${out.length}`,
      source: 'facebook',
      text: String(r.recommendation_text || r.message || r.text || '').trim(),
      rating: r.recommendation_type === 'positive' ? 5 : r.recommendation_type === 'negative' ? 1 : null,
      lang: detectLanguage(r.recommendation_text || r.message || ''),
      author: anonymizeAuthor(r.reviewer?.name || ''),
      created_at: r.created_time || null,
    });
  }
  for (const r of instagram || []) {
    out.push({
      id: r.id || `i_${out.length}`,
      source: 'instagram',
      text: String(r.text || '').trim(),
      rating: null, // IG comments don't have ratings
      lang: detectLanguage(r.text || ''),
      author: anonymizeAuthor(r.username || ''),
      created_at: r.timestamp || null,
    });
  }
  for (const r of email || []) {
    out.push({
      id: r.id || `e_${out.length}`,
      source: 'email',
      text: String(r.body || r.snippet || '').trim().slice(0, 1500),
      rating: null,
      lang: detectLanguage(r.body || r.snippet || ''),
      author: 'anonymized',
      created_at: r.received_at || r.date || null,
    });
  }
  // Filter out empty
  return out.filter(r => r.text && r.text.length >= 8);
}

function anonymizeAuthor(name) {
  if (!name || typeof name !== 'string') return 'anonymous';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 12);
  // First name + last initial
  return parts[0] + ' ' + parts[parts.length - 1][0] + '.';
}

// ─── Sentiment ─────────────────────────────────────────────────────────────
/**
 * Returns 'positive' | 'neutral' | 'negative'.
 * If rating present, use it (>=4 positive, <=2 negative, 3 neutral).
 * Else use simple keyword heuristic (cheap, not perfect).
 */
function sentimentBucket(rating, text) {
  if (Number.isFinite(rating)) {
    if (rating >= 4) return 'positive';
    if (rating <= 2) return 'negative';
    return 'neutral';
  }
  if (!text) return 'neutral';
  const t = text.toLowerCase();
  const positiveTerms = /\b(love|great|excellent|amazing|recommend|best|perfect|fantastic|wonderful|fast|friendly|quality|delicious|thank|gracias|merci|grazie|danke|faleminderit|shumë mirë|brilliant)\b/i;
  const negativeTerms = /\b(terrible|awful|worst|hate|disappointed|rude|slow|bad|poor|never again|waste|complaint|refund|nuk|jo mirë|mauvais|malo|schlecht|cattivo)\b/i;
  const pos = (t.match(positiveTerms) || []).length;
  const neg = (t.match(negativeTerms) || []).length;
  if (pos > neg + 1) return 'positive';
  if (neg > pos + 1) return 'negative';
  return 'neutral';
}

// ─── Deduplicate near-identical quotes ─────────────────────────────────────
/**
 * Some reviews are bot-generated copies. Filter near-duplicates by Jaccard
 * similarity on word sets. >0.7 = considered same.
 */
function dedupeQuotes(quotes) {
  if (!Array.isArray(quotes)) return [];
  const out = [];
  const seenSets = [];

  for (const q of quotes) {
    if (!q) continue;
    const words = new Set(String(q).toLowerCase().match(/\w+/g) || []);
    if (words.size < 3) continue;
    let isDupe = false;
    for (const seen of seenSets) {
      const inter = [...words].filter(w => seen.has(w)).length;
      const union = words.size + seen.size - inter;
      const jacc = union === 0 ? 0 : inter / union;
      if (jacc > 0.7) { isDupe = true; break; }
    }
    if (!isDupe) {
      out.push(q);
      seenSets.push(words);
    }
  }
  return out;
}

// ─── Keyword frequency clustering ──────────────────────────────────────────
/**
 * Multi-language stop-word filtering, top-N keyword frequencies.
 * Used as INPUT to LLM (deterministic, gives LLM real numbers).
 */
const STOPWORDS = new Set([
  'the','and','for','that','this','with','was','are','have','had','they','their','from','you','your',
  'but','not','all','can','will','what','when','where','how','why','our','out','one','its','his','her',
  'shumë','është','janë','dhe','për','nuk','tek','në','si','që','me','të','jam','ishte','ishin',
  'que','para','con','este','esto','sus','los','las','una','uno',
  'che','con','del','dei','sia','suo','suoi','non','molto','grazie',
  'der','die','das','und','mit','von','sehr','danke','nicht','aber',
  'que','pour','avec','dans','très','merci','pas','mais','les','des',
  'a','an','i','it','is','at','as','on','to','of','in','by','be','or','no','my','so','do','if','we','he','she',
]);

function topKeywords(reviews, n = 20) {
  if (!Array.isArray(reviews)) return [];
  const counts = new Map();
  for (const r of reviews) {
    const words = (r.text || '').toLowerCase().match(/[a-zçëâäöüáéíóúñàèìòù]{4,}/giu) || [];
    for (const w of words) {
      if (STOPWORDS.has(w)) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([word, freq]) => ({ word, freq }));
}

// ─── 30-day sentiment trend ────────────────────────────────────────────────
function trendSentiment(reviews) {
  if (!Array.isArray(reviews) || reviews.length < 5) return null;
  const now = Date.now();
  const last30  = reviews.filter(r => r.created_at && (now - new Date(r.created_at).getTime()) <= 30 * 86400000);
  const prior30 = reviews.filter(r => {
    if (!r.created_at) return false;
    const age = now - new Date(r.created_at).getTime();
    return age > 30 * 86400000 && age <= 60 * 86400000;
  });
  if (last30.length < 3 || prior30.length < 3) return null;

  const pctPos = (rs) => rs.filter(r => sentimentBucket(r.rating, r.text) === 'positive').length / Math.max(1, rs.length);
  const lastPos = pctPos(last30);
  const priorPos = pctPos(prior30);
  const delta = lastPos - priorPos;
  if (delta > 0.05) return 'improving';
  if (delta < -0.05) return 'declining';
  return 'stable';
}

// ─── Competitor mention extraction ─────────────────────────────────────────
function detectCompetitorMentions(reviews, knownCompetitors = []) {
  if (!Array.isArray(reviews) || !Array.isArray(knownCompetitors) || !knownCompetitors.length) return [];
  const mentions = new Map();
  for (const r of reviews) {
    const t = (r.text || '').toLowerCase();
    for (const c of knownCompetitors) {
      const name = String(c).toLowerCase();
      if (!name || name.length < 3) continue;
      if (t.includes(name)) {
        const list = mentions.get(c) || [];
        list.push({ quote: r.text, source: r.source, sentiment: sentimentBucket(r.rating, r.text) });
        mentions.set(c, list);
      }
    }
  }
  return [...mentions.entries()].map(([competitor, list]) => ({
    competitor,
    frequency: list.length,
    contexts: list.slice(0, 3), // up to 3 examples
  })).sort((a, b) => b.frequency - a.frequency);
}

// ─── Sample for LLM consumption (avoids context overflow on big datasets) ──
function sampleForLlm(reviews, n = 50) {
  if (!Array.isArray(reviews) || reviews.length <= n) return reviews;
  // Most-recent N preferred, plus a few random older ones for diversity
  const sorted = [...reviews].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  const recent = sorted.slice(0, Math.floor(n * 0.7));
  const older = sorted.slice(Math.floor(n * 0.7));
  const olderShuffled = [...older].sort(() => Math.random() - 0.5).slice(0, n - recent.length);
  return [...recent, ...olderShuffled];
}

module.exports = {
  detectLanguage,
  normalizeReviews,
  anonymizeAuthor,
  sentimentBucket,
  dedupeQuotes,
  topKeywords,
  trendSentiment,
  detectCompetitorMentions,
  sampleForLlm,
};
