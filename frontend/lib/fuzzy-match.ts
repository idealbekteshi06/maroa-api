/**
 * fuzzy-match.ts — tiny fzf-style ranker.
 *
 * Scores a candidate against a query so the palette search finds
 * "Smile Studio" when you type "stusm" — and ranks tighter matches
 * higher. Pure function, no deps. No allocations beyond the score.
 *
 * Scoring rules (higher = better):
 *   +18 per matched character
 *   +12 bonus if a match falls on a word boundary (start, after space,
 *       after punctuation)
 *   +8  bonus if two matches are consecutive (no gap)
 *   -1  per gap character between matches (penalises sparse spread)
 *   +6  bonus if the first match is at the very start of the candidate
 *
 * Returns `null` when the query characters cannot all be matched in
 * order. Returns `Infinity` for an exact-substring match so it always
 * sorts first. Empty query → score 0 (caller decides default order).
 */

const WORD_BOUNDARY = /[\s\-_·•/.,]/;

function isWordBoundary(prev: string | undefined): boolean {
  if (prev === undefined) return true;
  return WORD_BOUNDARY.test(prev);
}

export function fuzzyScore(query: string, candidate: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (c.includes(q)) {
    // Exact-substring matches always rank first; the closer to the start,
    // the higher within that tier.
    return Number.POSITIVE_INFINITY - c.indexOf(q);
  }

  let score = 0;
  let ci = 0;
  let lastMatchIndex = -2; // -2 so first match never reads as consecutive
  let matchedAny = false;

  for (let qi = 0; qi < q.length; qi++) {
    const target = q[qi]!;
    let found = -1;
    while (ci < c.length) {
      if (c[ci] === target) {
        found = ci;
        ci++;
        break;
      }
      ci++;
    }
    if (found === -1) return null;
    score += 18;
    if (isWordBoundary(c[found - 1])) score += 12;
    if (found === lastMatchIndex + 1) score += 8;
    else score -= Math.min(found - lastMatchIndex - 1, 12); // capped gap penalty
    if (qi === 0 && found === 0) score += 6;
    lastMatchIndex = found;
    matchedAny = true;
  }

  return matchedAny ? score : null;
}

/**
 * Rank a list of items by fuzzy score against `query`. Stable across
 * ties (input order preserved). Caller passes a key extractor so items
 * can be anything.
 */
export function fuzzyRank<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
): T[] {
  if (!query.trim()) return items.slice();
  const scored: Array<{ item: T; score: number; i: number }> = [];
  items.forEach((item, i) => {
    const s = fuzzyScore(query, getText(item));
    if (s !== null) scored.push({ item, score: s, i });
  });
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  return scored.map((s) => s.item);
}
