'use strict';

/**
 * lib/mapConcurrent.js
 * ---------------------------------------------------------------------------
 * Run an async worker over a list with a bounded number in flight at once.
 *
 * The fleet crons (weekly-scorecard, pacing-alerts, ad-optimizer) previously
 * processed every business/campaign in a strict `for … await` loop. That is
 * fine at 10 businesses and a 60-minute timeout bomb at a few hundred — each
 * item does 4 DB reads + an LLM/Meta call, so a sequential sweep is O(N × slow).
 *
 * This keeps `limit` items running concurrently and starts the next as soon as
 * one finishes — wall-clock ≈ (total work) / limit instead of the full sum.
 * The worker is called as `worker(item, index)`; a thrown worker is caught and
 * surfaced as `{ ok: false, item, index, error }` so one bad item can't abort
 * the whole fleet (mirrors the old per-item try/catch).
 *
 *   const results = await mapConcurrent(businesses, 8, (b) => generateFor(b));
 *   const ok = results.filter((r) => r.ok);
 *
 * Order of the returned array matches the input order.
 * ---------------------------------------------------------------------------
 */

async function mapConcurrent(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const n = list.length;
  const results = new Array(n);
  const width = Math.max(1, Math.min(Number(limit) || 1, n || 1));
  let next = 0;

  async function runner() {
    let i = next;
    next += 1;
    while (i < n) {
      try {
        const value = await worker(list[i], i);
        results[i] = { ok: true, item: list[i], index: i, value };
      } catch (error) {
        results[i] = { ok: false, item: list[i], index: i, error };
      }
      i = next;
      next += 1;
    }
  }

  await Promise.all(Array.from({ length: width }, () => runner()));
  return results;
}

module.exports = { mapConcurrent };
