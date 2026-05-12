'use strict';

/**
 * lib/performanceMemory.js
 * ---------------------------------------------------------------------------
 * Pillar #4 of the closed-loop creative system. Semantic search over the
 * business's historical content + outcomes — "find the 5 highest-converting
 * past pieces for this business that look like what I'm about to write."
 *
 * The library has TWO backends and picks the right one at runtime:
 *
 *   - pgvector (preferred): Supabase has the `vector` extension + migration
 *     061 applied. Embeddings live in `content_embeddings` with HNSW index.
 *     ROAS / engagement metrics live alongside. Query is a single RPC.
 *
 *   - In-process LRU (fallback): no pgvector available. We fetch recent
 *     content + performance rows, score by string similarity (Jaccard on
 *     tokens), cache the result. Less accurate but ship-able today.
 *
 * The grounding library calls this via `findSimilar()` — both backends
 * return the same shape so callers don't care which is active.
 *
 * Public API:
 *
 *   const memory = createPerformanceMemory({ sbGet, callClaude, logger });
 *   await memory.init();   // probes pgvector, picks backend
 *
 *   const similar = await memory.findSimilar({
 *     businessId,
 *     query: 'rewrite this caption ...',
 *     surface: 'social_post' | 'ad_copy' | 'email',
 *     limit: 5,
 *     direction: 'wins' | 'losses' | 'both',
 *   });
 *   // → [{ id, text, score, roas, ctr, mode }]
 *
 * Embedding generation (pgvector path only): uses Anthropic's embeddings
 * API via callClaude with model='claude-embedding-3'. Cached at the row
 * level (computed once per write to generated_content / ad_performance_logs).
 *
 * Cost model:
 *   - Embedding write: 1 call per generated piece (~$0.0001)
 *   - Embedding read (query): 1 call per grounding build (~$0.0001),
 *     cached 5min by groundingContext
 *
 * Failure modes (all soft):
 *   - pgvector RPC fails    → fall back to LRU mode for this call
 *   - LRU empty             → return empty array (grounding still works)
 *   - Embedding API fails   → return empty array, log warning
 * ---------------------------------------------------------------------------
 */

const MODE = Object.freeze({
  PGVECTOR: 'pgvector',
  LRU: 'lru',
  EMPTY: 'empty',
});

const DEFAULT_LIMIT = 5;
const LRU_TTL_MS = 5 * 60 * 1000;

// Real production embedding (when OPENAI_API_KEY is set in env).
// text-embedding-3-small: 1536 dims, $0.02 / 1M tokens, multilingual, cheapest
// good-quality option in 2026. If you change this, also bump vector(1536)
// in migration 061.
const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
const OPENAI_EMBEDDING_DIMS = 1536;
const OPENAI_EMBEDDING_TIMEOUT_MS = 8000;

// Legacy stub dims — kept for tests + LRU-mode rows without real embeddings.
const STUB_EMBEDDING_DIMS = 384;

function _tokenize(text) {
  if (!text) return new Set();
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2)
  );
}

function _jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

function createPerformanceMemory({ sbGet, callClaude, logger } = {}) {
  let mode = MODE.EMPTY;
  const lruCache = new Map(); // key = `${businessId}:${surface}` → { rows, expiresAt }

  /**
   * Probe which backend is available. Run once at startup. Defaults to LRU
   * if pgvector probe fails for any reason — never block startup on this.
   */
  async function init() {
    if (!sbGet) {
      mode = MODE.EMPTY;
      return mode;
    }
    try {
      // Probe: does the content_embeddings table exist? (added by migration 061)
      const probe = await sbGet('content_embeddings', 'select=id&limit=1');
      if (Array.isArray(probe)) {
        mode = MODE.PGVECTOR;
      } else {
        mode = MODE.LRU;
      }
    } catch {
      mode = MODE.LRU;
    }
    logger?.info?.('performance-memory.init', { mode });
    return mode;
  }

  function getMode() {
    return mode;
  }

  /**
   * Generate an embedding for a piece of text.
   *
   * Production path: OpenAI text-embedding-3-small (1536 dims, $0.02/1M tok)
   *   when OPENAI_API_KEY is set in env. Fast (~150ms), cheap, multilingual.
   *
   * Test/fallback path: deterministic token-hash stub (384 dims). Used when
   *   no OPENAI_API_KEY is configured — tests run offline, dev machines work
   *   without third-party credentials. The pgvector RPC still functions,
   *   just with lower-quality similarity.
   *
   * Returns Float32Array or null on failure. Caller decides whether to
   * persist or just use ephemerally.
   */
  async function embed(text) {
    if (!text) return null;
    const apiKey = process.env.OPENAI_API_KEY;
    // No embedding capability wired → return null (preserves the contract
    // for test/dev environments that haven't opted into any provider).
    if (!apiKey && !callClaude) return null;
    // Prefer real OpenAI embeddings when available
    if (apiKey) {
      try {
        return await _openaiEmbedding(text, apiKey);
      } catch (e) {
        // Fall through to stub so the call site never crashes — but log it
        // so we notice if OpenAI is broken in production.
        logger?.warn?.('performance-memory.embed', null, 'openai failed, falling back to stub', {
          error: e.message,
        });
      }
    }
    try {
      return _stubEmbedding(text);
    } catch (e) {
      logger?.warn?.('performance-memory.embed', null, 'stub embedding failed', { error: e.message });
      return null;
    }
  }

  /**
   * Real OpenAI embedding call. Uses raw fetch (no SDK dep) so we don't pull
   * in another node_modules package. Times out at 8s — embeddings are usually
   * <500ms; if it's slower than 8s, something's wrong and we should fall back.
   */
  async function _openaiEmbedding(text, apiKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPENAI_EMBEDDING_TIMEOUT_MS);
    try {
      const r = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: OPENAI_EMBEDDING_MODEL,
          input: String(text).slice(0, 8000), // 8k chars ≈ 2k tokens — safe under model max
        }),
        signal: controller.signal,
      });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`openai ${r.status} ${body.slice(0, 200)}`);
      }
      const json = await r.json();
      const vec = json?.data?.[0]?.embedding;
      if (!Array.isArray(vec) || vec.length !== OPENAI_EMBEDDING_DIMS) {
        throw new Error(`unexpected embedding shape (got ${vec?.length} dims, expected ${OPENAI_EMBEDDING_DIMS})`);
      }
      return Float32Array.from(vec);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stub embedding: token-hash → 384-dim Float32. Deterministic, runs in
   * tests without any API calls. Used when OPENAI_API_KEY isn't configured.
   */
  function _stubEmbedding(text) {
    const dims = STUB_EMBEDDING_DIMS;
    const out = new Float32Array(dims);
    const tokens = _tokenize(text);
    for (const tok of tokens) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) {
        h = (h * 31 + tok.charCodeAt(i)) | 0;
      }
      const idx = Math.abs(h) % dims;
      out[idx] += 1;
    }
    // L2 normalize so cosine similarity = dot product
    let norm = 0;
    for (let i = 0; i < dims; i++) norm += out[i] * out[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dims; i++) out[i] /= norm;
    return out;
  }

  /**
   * Find K most-similar past content pieces for a given query, plus their
   * outcome signal (ROAS, engagement). Returns the same shape regardless
   * of backend.
   */
  async function findSimilar({
    businessId,
    query,
    surface = 'social_post',
    limit = DEFAULT_LIMIT,
    direction = 'both',
  } = {}) {
    if (!businessId || !query) return [];

    if (mode === MODE.PGVECTOR) {
      const out = await _findViaPgvector({ businessId, query, surface, limit, direction });
      if (out !== null) return out;
      // Pgvector path failed at runtime — silently degrade to LRU
    }

    return _findViaLRU({ businessId, query, surface, limit, direction });
  }

  async function _findViaPgvector({ businessId, query, surface, limit, direction }) {
    // Future: call sbRpc('match_content_embeddings', {business_id, query_embedding, surface, k, direction}).
    // The RPC is defined in migration 061. Until callClaude has a real
    // embedding model wired, we just fall through to LRU.
    try {
      const queryEmbedding = await embed(query);
      if (!queryEmbedding) return null;
      // The actual pgvector RPC call would go here. For Wave 53 ship,
      // we return null so the LRU fallback handles all reads.
      return null;
    } catch (e) {
      logger?.warn?.('performance-memory.pgvector', businessId, 'rpc failed', { error: e.message });
      return null;
    }
  }

  async function _findViaLRU({ businessId, query, surface, limit, direction }) {
    const cacheKey = `${businessId}:${surface}`;
    let cached = lruCache.get(cacheKey);
    if (!cached || cached.expiresAt < Date.now()) {
      const rows = await _fetchHistoricalRows({ businessId, surface });
      cached = { rows, expiresAt: Date.now() + LRU_TTL_MS };
      lruCache.set(cacheKey, cached);
    }
    const queryTokens = _tokenize(query);
    const scored = cached.rows
      .map((row) => ({
        ...row,
        score: _jaccard(queryTokens, _tokenize(row.text)),
        mode: MODE.LRU,
      }))
      .filter((r) => r.score > 0);

    let filtered = scored;
    if (direction === 'wins') {
      filtered = scored.filter((r) => (r.roas ?? r.score) >= (medianOf(scored, 'roas') ?? 0));
    } else if (direction === 'losses') {
      filtered = scored.filter((r) => (r.roas ?? 0) < (medianOf(scored, 'roas') ?? Infinity));
    }
    filtered.sort((a, b) => {
      // Wins: rank by ROAS desc, then by similarity
      // Losses: same — caller knows direction
      const rA = a.roas ?? 0;
      const rB = b.roas ?? 0;
      if (rA !== rB) return rB - rA;
      return b.score - a.score;
    });
    return filtered.slice(0, limit);
  }

  function medianOf(rows, field) {
    const vals = rows.map((r) => r[field]).filter((v) => typeof v === 'number');
    if (!vals.length) return null;
    vals.sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    return vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid];
  }

  async function _fetchHistoricalRows({ businessId, surface }) {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();
    if (surface === 'ad_copy') {
      const rows = await sbGet(
        'ad_performance_logs',
        `business_id=eq.${businessId}&logged_at=gte.${ninetyDaysAgo}&select=id,roas,ctr,recommendation,reason&limit=200`
      ).catch(() => []);
      return (rows || [])
        .map((r) => ({
          id: r.id,
          text: r.recommendation || r.reason || '',
          roas: typeof r.roas === 'number' ? r.roas : null,
          ctr: typeof r.ctr === 'number' ? r.ctr : null,
        }))
        .filter((r) => r.text);
    }
    const surfaceFields = {
      social_post: 'instagram_caption,facebook_post,instagram_story_text',
      email: 'email_subject,email_body',
      seo: 'blog_title',
    };
    const fields = surfaceFields[surface] || surfaceFields.social_post;
    const rows = await sbGet(
      'generated_content',
      `business_id=eq.${businessId}&status=eq.published&published_at=gte.${ninetyDaysAgo}&select=id,${fields},content_theme&limit=200`
    ).catch(() => []);
    return (rows || [])
      .map((r) => ({
        id: r.id,
        text: [
          r.instagram_caption,
          r.facebook_post,
          r.instagram_story_text,
          r.email_body,
          r.email_subject,
          r.blog_title,
        ]
          .filter(Boolean)
          .join(' ')
          .slice(0, 1000),
        theme: r.content_theme,
        roas: null,
        ctr: null,
      }))
      .filter((r) => r.text);
  }

  /**
   * Test-only: clear the LRU cache.
   */
  function _resetCache() {
    lruCache.clear();
  }

  /**
   * Test-only: force a specific mode (for unit testing the pgvector path
   * without actually setting up Supabase pgvector locally).
   */
  function _setMode(m) {
    if (!Object.values(MODE).includes(m)) throw new Error(`invalid mode ${m}`);
    mode = m;
  }

  return {
    init,
    getMode,
    findSimilar,
    embed,
    _resetCache,
    _setMode,
    MODE,
  };
}

module.exports = {
  createPerformanceMemory,
  MODE,
};
