'use strict';

/**
 * services/shopify/index.js
 * ---------------------------------------------------------------------------
 * Store catalog ingestion — customer pastes a store URL, Maroa ingests the
 * catalog and markets it automatically.
 *
 *  - Shopify storefronts expose a PUBLIC `/products.json` (no OAuth needed);
 *    we fetch up to 250 products from it.
 *  - Non-Shopify sites fall back to lib/websiteEnricher.js summary-only mode
 *    (Claude reads the homepage) so a generic product site still connects.
 *  - Products land in `store_products` (migration 096); connection state on
 *    `businesses.store_url` / `store_meta`; up to 4 product images are copied
 *    into `businesses.product_image_urls` — WF1's Higgsfield reference-image
 *    path (migration 088) — and a Claude digest lands in
 *    `businesses.website_summary` so the brain "knows" the catalog.
 *
 * Rules honored: UUID-validate + encodeURIComponent every PostgREST filter
 * input (Rule 4); all LLM calls via injected callClaude (Rule 2); external
 * fetch bounded by a 15s timeout; store summary soft-fails (a Claude/credit
 * outage must never break store connect).
 * ---------------------------------------------------------------------------
 */

const { enrichFromWebsite, isBlockedHost, htmlToText } = require('../../lib/websiteEnricher');

const FETCH_TIMEOUT_MS = 15000; // repo-default external HTTP timeout
const MAX_PRODUCTS = 250;
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_IMAGES_PER_PRODUCT = 8;
const MAX_REFERENCE_IMAGES = 4; // businesses.product_image_urls (migration 088)
const MAX_SUMMARY_PRODUCTS = 25; // cap Claude input
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalize a customer-pasted store URL: force https, strip path/query/hash,
 * reject non-http(s) schemes and internal hosts. Returns `https://host` or null.
 */
function normalizeStoreUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (!/^https?:\/\//i.test(s)) return null; // ftp://, file://, …
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    return null; // javascript:, mailto:, data:
  } else {
    s = `https://${s}`;
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || !u.hostname.includes('.')) return null;
  if (isBlockedHost(u.hostname)) return null;
  return `https://${u.hostname}`; // https-forced, path/query/port stripped
}

function stripHtml(html) {
  return htmlToText(html).slice(0, MAX_DESCRIPTION_CHARS);
}

// Best-effort JSON extraction for the enricher fallback when the host
// doesn't inject its own extractJSON.
function defaultExtractJSON(raw) {
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

// callClaude returns different shapes across call sites — coerce to text.
function claudeText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result.text === 'string') return result.text;
  if (Array.isArray(result.content)) {
    return result.content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('');
  }
  if (typeof result.content === 'string') return result.content;
  return '';
}

function parseShopifyProduct(p, storeUrl) {
  if (!p || typeof p !== 'object') return null;
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const images = Array.isArray(p.images) ? p.images : [];
  const priceRaw = variants[0]?.price;
  const price = Number.parseFloat(priceRaw);
  const currency = variants[0]?.presentment_prices?.[0]?.price?.currency_code || p.currency || 'USD';
  return {
    external_id: String(p.id ?? ''),
    title: String(p.title || '').slice(0, 300),
    description: stripHtml(p.body_html || ''),
    price: Number.isFinite(price) ? price : null,
    currency: String(currency).slice(0, 8),
    image_urls: images
      .map((img) => img?.src)
      .filter((src) => typeof src === 'string' && /^https?:\/\//i.test(src))
      .slice(0, MAX_IMAGES_PER_PRODUCT),
    product_url: p.handle ? `${storeUrl}/products/${encodeURIComponent(p.handle)}` : storeUrl,
    vendor: p.vendor ? String(p.vendor).slice(0, 200) : null,
    tags: Array.isArray(p.tags)
      ? p.tags.map((t) => String(t).slice(0, 80)).slice(0, 25)
      : String(p.tags || '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 25),
  };
}

function buildStoreSummaryPrompt(storeUrl, products) {
  const digest = products.slice(0, MAX_SUMMARY_PRODUCTS).map((p) => ({
    title: p.title,
    price: p.price,
    currency: p.currency,
    vendor: p.vendor || undefined,
    tags: (p.tags || []).slice(0, 6),
    description: (p.description || '').slice(0, 240),
  }));
  return [
    'You are analyzing an e-commerce store from its product catalog so an AI',
    'marketing system can promote it. Be factual — only what the catalog',
    'supports. Write a tight plain-text brief (<= 900 chars) covering:',
    '1) positioning: what the store sells + who it is for,',
    '2) likely bestsellers / hero products (best guesses, name them),',
    '3) the target audience,',
    '4) 2-3 concrete marketing angles worth leading with.',
    'No markdown headings, no bullets-of-bullets — a compact paragraph or two.',
    '',
    `STORE: ${storeUrl}`,
    `PRODUCT COUNT: ${products.length}`,
    `CATALOG SAMPLE: ${JSON.stringify(digest)}`,
  ].join('\n');
}

/**
 * Factory. Deps: { sbGet, sbPost, sbPatch, sbDelete?, callClaude, fetchImpl?,
 * extractJSON?, logger? }. sbDelete powers the delete-then-insert catalog
 * refresh; without it, sync falls back to insert-only (first connect works,
 * re-sync may conflict on the (business_id, external_id) unique).
 */
function createShopifyService({ sbGet, sbPost, sbPatch, sbDelete, callClaude, fetchImpl, extractJSON, logger } = {}) {
  if (!sbGet || !sbPost || !sbPatch) throw new Error('createShopifyService: sbGet/sbPost/sbPatch are required');
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const parseJSON = extractJSON || defaultExtractJSON;
  const log = (biz, msg, extra) => logger?.('shopify', biz, msg, extra);

  function assertUuid(businessId) {
    if (!UUID_RE.test(String(businessId || ''))) {
      const err = new Error('invalid business_id');
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
  }

  /**
   * Fetch the public Shopify catalog. Returns
   * { ok:true, products:[…] } or { ok:false, reason:'not_shopify'|… }.
   */
  async function fetchCatalog(storeUrl) {
    const base = normalizeStoreUrl(storeUrl);
    if (!base) return { ok: false, reason: 'invalid_url' };
    if (!doFetch) return { ok: false, reason: 'no_fetch_available' };
    let res;
    try {
      res = await doFetch(`${base}/products.json?limit=${MAX_PRODUCTS}`, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'MaroaBot/1.0 (+https://maroa.ai)', Accept: 'application/json' },
      });
    } catch (e) {
      log(null, 'catalog fetch failed', { storeUrl: base, error: e.message });
      return { ok: false, reason: 'fetch_failed', error: e.message };
    }
    if (!res.ok) return { ok: false, reason: 'not_shopify', status: res.status };
    let body;
    try {
      body = await res.json();
    } catch {
      return { ok: false, reason: 'not_shopify' }; // HTML/404-page masquerading as 200
    }
    if (!body || !Array.isArray(body.products)) return { ok: false, reason: 'not_shopify' };
    const products = body.products.map((p) => parseShopifyProduct(p, base)).filter((p) => p && p.external_id);
    return { ok: true, storeUrl: base, products };
  }

  // Delete-then-insert catalog refresh (unique (business_id, external_id)
  // makes plain re-insert conflict; PostgREST merge-upsert needs a Prefer
  // header sbPost doesn't expose).
  async function replaceProducts(businessId, storeUrl, products) {
    assertUuid(businessId);
    const filter = `business_id=eq.${encodeURIComponent(businessId)}`;
    if (typeof sbDelete === 'function') await sbDelete('store_products', filter);
    if (!products.length) return 0;
    const now = new Date().toISOString();
    const rows = products.map((p) => ({ ...p, business_id: businessId, source: 'shopify', synced_at: now }));
    await sbPost('store_products', rows);
    return rows.length;
  }

  async function getBusiness(businessId) {
    assertUuid(businessId);
    const rows = await sbGet(
      'businesses',
      `id=eq.${encodeURIComponent(businessId)}&select=id,user_id,website_url,store_url,store_meta,product_image_urls&limit=1`
    );
    return rows?.[0] || null;
  }

  // Claude catalog digest → businesses.website_summary. Soft-fails by design:
  // a credit outage or malformed response must never break store connect.
  async function saveStoreSummary(businessId, storeUrl, products) {
    if (typeof callClaude !== 'function' || !products.length) return false;
    try {
      const raw = await callClaude(buildStoreSummaryPrompt(storeUrl, products), 'claude-haiku-4-5', 800, {
        businessId,
        returnRaw: true,
      });
      const summary = claudeText(raw).trim().slice(0, 1200);
      if (!summary) return false;
      await sbPatch('businesses', `id=eq.${encodeURIComponent(businessId)}`, {
        website_summary: summary,
        website_enriched_at: new Date().toISOString(),
      });
      return true;
    } catch (e) {
      log(businessId, 'store summary soft-failed (connect still succeeds)', { error: e.message });
      return false;
    }
  }

  /**
   * Connect a store: ingest catalog (Shopify) or summary-only (generic site),
   * stamp businesses.store_url/store_meta, feed WF1's reference-image path.
   */
  async function connectStore({ businessId, storeUrl }) {
    assertUuid(businessId);
    const base = normalizeStoreUrl(storeUrl);
    if (!base) return { ok: false, reason: 'invalid_url' };
    const business = await getBusiness(businessId);
    if (!business) return { ok: false, reason: 'business_not_found' };

    const catalog = await fetchCatalog(base);
    const connectedAt = new Date().toISOString();

    if (!catalog.ok) {
      // Generic product site — summary-only fallback via websiteEnricher.
      const patch = {
        store_url: base,
        store_meta: { platform: 'generic', product_count: 0, connected_at: connectedAt, top_product_ids: [] },
      };
      if (!business.website_url) patch.website_url = base;
      let summarySaved = false;
      if (typeof callClaude === 'function') {
        const enriched = await enrichFromWebsite({
          url: base,
          businessId,
          deps: { callClaude, extractJSON: parseJSON, logger, fetchImpl: doFetch },
        });
        if (enriched.ok && enriched.summary) {
          patch.website_summary = enriched.summary;
          patch.website_enriched_at = connectedAt;
          summarySaved = true;
        }
      }
      await sbPatch('businesses', `id=eq.${encodeURIComponent(businessId)}`, patch);
      return { ok: true, platform: 'generic', product_count: 0, summary_saved: summarySaved, store_url: base };
    }

    const products = catalog.products;
    const inserted = await replaceProducts(businessId, catalog.storeUrl, products);

    // Up to 4 reference images for WF1's Higgsfield source-image path
    // (migration 088) — first image of each of the first products that have one.
    const referenceImages = [];
    for (const p of products) {
      if (referenceImages.length >= MAX_REFERENCE_IMAGES) break;
      if (p.image_urls?.[0]) referenceImages.push(p.image_urls[0]);
    }

    const patch = {
      store_url: catalog.storeUrl,
      store_meta: {
        platform: 'shopify',
        product_count: products.length,
        connected_at: connectedAt,
        top_product_ids: products.slice(0, MAX_REFERENCE_IMAGES).map((p) => p.external_id),
      },
    };
    if (!business.website_url) patch.website_url = catalog.storeUrl;
    if (referenceImages.length) patch.product_image_urls = referenceImages;
    await sbPatch('businesses', `id=eq.${encodeURIComponent(businessId)}`, patch);

    const summarySaved = await saveStoreSummary(businessId, catalog.storeUrl, products);
    return {
      ok: true,
      platform: 'shopify',
      product_count: products.length,
      products_inserted: inserted,
      summary_saved: summarySaved,
      store_url: catalog.storeUrl,
    };
  }

  async function getProducts({ businessId, limit } = {}) {
    assertUuid(businessId);
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), MAX_PRODUCTS);
    return sbGet(
      'store_products',
      `business_id=eq.${encodeURIComponent(businessId)}&select=*&order=created_at.asc&limit=${n}`
    );
  }

  /** Re-fetch the connected store's catalog and refresh store_products. */
  async function syncStore({ businessId } = {}) {
    const business = await getBusiness(businessId);
    if (!business) return { ok: false, reason: 'business_not_found' };
    if (!business.store_url) return { ok: false, reason: 'no_store_connected' };
    const catalog = await fetchCatalog(business.store_url);
    if (!catalog.ok) return { ok: false, reason: catalog.reason };
    const inserted = await replaceProducts(businessId, catalog.storeUrl, catalog.products);
    await sbPatch('businesses', `id=eq.${encodeURIComponent(businessId)}`, {
      store_meta: {
        ...(business.store_meta || {}),
        platform: 'shopify',
        product_count: catalog.products.length,
        synced_at: new Date().toISOString(),
        top_product_ids: catalog.products.slice(0, MAX_REFERENCE_IMAGES).map((p) => p.external_id),
      },
    });
    return { ok: true, product_count: catalog.products.length, products_inserted: inserted };
  }

  /**
   * Arm/disarm full automation for the store. Deliberately does NOT touch
   * ads_live — autonomous ad spend is a separate explicit consent (migration 095).
   */
  async function setAutomation({ businessId, enabled } = {}) {
    assertUuid(businessId);
    const on = enabled === true || enabled === 'true';
    await sbPatch('businesses', `id=eq.${encodeURIComponent(businessId)}`, {
      autopilot_enabled: on,
      wf1_autonomy_mode: on ? 'full_autopilot' : 'hybrid',
    });
    return { ok: true, autopilot_enabled: on, wf1_autonomy_mode: on ? 'full_autopilot' : 'hybrid' };
  }

  return { normalizeStoreUrl, fetchCatalog, connectStore, getProducts, syncStore, setAutomation };
}

module.exports = { createShopifyService, normalizeStoreUrl };
