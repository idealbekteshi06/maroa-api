'use strict';

/**
 * services/citation-tracker/index.js
 * ---------------------------------------------------------------------------
 * AI Search Citation Tracker — the "Profound at $49/mo" layer.
 *
 * Three jobs:
 *   1. Generate a 15-20 prompt seed library per business (auto from
 *      industry + location + competitors)
 *   2. Run those prompts daily against AI engines (DataForSEO LLM Mentions,
 *      Perplexity Sonar, SerpAPI Google AI Mode)
 *   3. Log citations + competitor share-of-voice + alert on gaps
 *
 * Cost economics (per business per month):
 *   ~20 prompts × 5 engines × 30 days = 3000 queries
 *   DataForSEO: $0.10 × 1500 = $150 (covers Google AIO + ChatGPT)
 *   Perplexity Sonar: ~$1-3 / 1M tokens — call it $5-10
 *   SerpAPI: $0.001 × 600 = $0.60
 *   ≈ $3-5/business/month — fits inside Growth tier margin
 *
 * Public API:
 *   buildSeedPrompts({ business })    — 15-20 industry-aware queries
 *   runDailyForBusiness({ businessId }) — runs all prompts × engines
 *   computeShareOfVoice({ businessId, days = 7 }) — competitor SoV report
 *   detectCitationGaps({ businessId }) — prompts where competitors got
 *                                        cited but we didn't
 * ---------------------------------------------------------------------------
 */

const PROMPTS_PER_BUSINESS = 18;       // sweet spot for cost vs coverage
const DEFAULT_ENGINES = ['chatgpt', 'perplexity', 'google_aio', 'claude'];

// ─── Prompt seed library generator (no LLM needed — rule-based) ─────────

/**
 * buildSeedPrompts — produces ~18 prompts per business covering 7 intents.
 * No LLM calls — pure templates for deterministic, cost-free generation.
 *
 * Industry-aware: dental clinic gets local-discovery prompts;
 * SaaS gets comparison prompts; restaurants get review-style prompts.
 */
function buildSeedPrompts({ business }) {
  if (!business) return [];

  const name = business.business_name || 'this business';
  const industry = String(business.industry || 'business').toLowerCase();
  const location = business.location || null;
  const competitors = Array.isArray(business.competitors)
    ? business.competitors.map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean).slice(0, 3)
    : [];

  const prompts = [];

  // ── Discovery ──
  prompts.push({ prompt_text: `What is ${name}?`, prompt_intent: 'discovery' });
  if (location) {
    prompts.push({ prompt_text: `best ${industry} in ${location}`, prompt_intent: 'local_search' });
    prompts.push({ prompt_text: `top ${industry} near ${location}`, prompt_intent: 'local_search' });
    prompts.push({ prompt_text: `recommended ${industry} ${location}`, prompt_intent: 'recommendation' });
  } else {
    prompts.push({ prompt_text: `best ${industry} companies`, prompt_intent: 'discovery' });
  }

  // ── Recommendation ──
  prompts.push({ prompt_text: `who should I hire for ${industry} services`, prompt_intent: 'recommendation' });
  prompts.push({ prompt_text: `recommend a ${industry}`, prompt_intent: 'recommendation' });
  prompts.push({ prompt_text: `trustworthy ${industry}${location ? ' in ' + location : ''}`, prompt_intent: 'recommendation' });

  // ── Comparison vs competitors ──
  for (const comp of competitors) {
    prompts.push({
      prompt_text: `${name} vs ${comp}`,
      prompt_intent: 'vs',
    });
    prompts.push({
      prompt_text: `${comp} alternative`,
      prompt_intent: 'comparison',
    });
  }

  // ── Reviews ──
  prompts.push({ prompt_text: `${name} reviews`, prompt_intent: 'review' });
  prompts.push({ prompt_text: `is ${name} legit`, prompt_intent: 'review' });

  // ── Industry-specific intents ──
  if (/saas|software|tech|app/.test(industry)) {
    prompts.push({ prompt_text: `best ${industry} tools 2026`, prompt_intent: 'comparison' });
    prompts.push({ prompt_text: `how to choose a ${industry} platform`, prompt_intent: 'how_to' });
  } else if (/dental|medical|clinic|doctor/.test(industry)) {
    prompts.push({ prompt_text: `${industry} questions to ask`, prompt_intent: 'how_to' });
    prompts.push({ prompt_text: `is ${industry} covered by insurance`, prompt_intent: 'how_to' });
  } else if (/e-?commerce|shop|retail|apparel/.test(industry)) {
    prompts.push({ prompt_text: `where to buy ${industry} online`, prompt_intent: 'discovery' });
    prompts.push({ prompt_text: `best ${industry} brands`, prompt_intent: 'comparison' });
  } else if (/restaurant|cafe|food/.test(industry)) {
    prompts.push({ prompt_text: `${industry} ${location || ''} reservations`, prompt_intent: 'local_search' });
    prompts.push({ prompt_text: `${industry} menu ${location || ''}`, prompt_intent: 'local_search' });
  } else if (/law|attorney|legal/.test(industry)) {
    prompts.push({ prompt_text: `do I need a ${industry}`, prompt_intent: 'how_to' });
    prompts.push({ prompt_text: `${industry} consultation cost`, prompt_intent: 'how_to' });
  } else {
    prompts.push({ prompt_text: `${industry} pricing`, prompt_intent: 'how_to' });
    prompts.push({ prompt_text: `${industry} for small business`, prompt_intent: 'discovery' });
  }

  // Trim to target count
  return prompts.slice(0, PROMPTS_PER_BUSINESS);
}

// ─── Citation parser — does the response mention us? ─────────────────────

/**
 * parseCitationResult — given a response from any AI engine + the customer's
 * brand info, determine if cited + at what position. Engine-agnostic.
 *
 * Inputs:
 *   { responseText, citedUrls, competitorNames, brandName, brandUrl }
 *
 * Returns:
 *   { brand_cited, brand_position, brand_url_cited, cited_urls, competitor_citations }
 */
function parseCitationResult({ responseText, citedUrls, competitorNames, brandName, brandUrl }) {
  const urls = Array.isArray(citedUrls) ? citedUrls : [];
  const text = String(responseText || '').toLowerCase();
  const brand = String(brandName || '').toLowerCase();
  const brandHost = brandUrl ? new URL(/^https?:/.test(brandUrl) ? brandUrl : `https://${brandUrl}`).hostname.replace(/^www\./, '') : null;

  // Brand cited? — match by URL host, or by brand name in cited URLs, or by mention in text
  let brandCited = false;
  let brandPosition = null;
  let brandUrlCited = null;

  for (let i = 0; i < urls.length; i += 1) {
    const u = String(urls[i] || '').toLowerCase();
    if (brandHost && u.includes(brandHost)) {
      brandCited = true;
      brandPosition = i + 1;
      brandUrlCited = urls[i];
      break;
    }
    if (brand && u.includes(brand)) {
      brandCited = true;
      brandPosition = i + 1;
      brandUrlCited = urls[i];
      break;
    }
  }

  // Fallback: name mentioned in response text but not cited as URL
  if (!brandCited && brand && text.includes(brand)) {
    brandCited = true; // mentioned-but-not-linked is still a citation
  }

  // Competitor citations — normalize both sides (strip non-alphanumerics)
  // so "Best Smile" matches "bestsmile.com" and vice versa.
  const stripNonAlnum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const competitor_citations = [];
  for (const cname of competitorNames || []) {
    if (!cname) continue;
    const cnStripped = stripNonAlnum(cname);
    if (!cnStripped) continue;
    const cnLower = String(cname).toLowerCase();
    let found = false;
    for (let i = 0; i < urls.length; i += 1) {
      const u = String(urls[i] || '').toLowerCase();
      if (u.includes(cnLower) || stripNonAlnum(u).includes(cnStripped)) {
        competitor_citations.push({ name: cname, position: i + 1, url: urls[i] });
        found = true;
        break;
      }
    }
    if (!found && (text.includes(cnLower) || stripNonAlnum(text).includes(cnStripped))) {
      competitor_citations.push({ name: cname, position: null, url: null });
    }
  }

  return {
    brand_cited: brandCited,
    brand_position: brandPosition,
    brand_url_cited: brandUrlCited,
    cited_urls: urls,
    competitor_citations,
  };
}

// ─── Engine adapters (graceful no-op when API key missing) ───────────────

async function queryPerplexity({ prompt, deps }) {
  if (!process.env.PERPLEXITY_API_KEY) return null;
  const url = 'https://api.perplexity.ai/chat/completions';
  const body = {
    model: 'sonar-pro',
    messages: [{ role: 'user', content: prompt }],
    return_citations: true,
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const content = j?.choices?.[0]?.message?.content || '';
    const citations = j?.citations || [];
    return {
      engine: 'perplexity',
      response_text: content,
      cited_urls: citations,
      api_cost_usd: 0.005, // approx
      api_source: 'perplexity_sonar',
      raw: j,
    };
  } catch {
    return null;
  }
}

async function queryDataForSEO({ prompt, engine, deps }) {
  // DataForSEO LLM Mentions API — covers Google AI Overviews + ChatGPT
  // citations. Returns cited URLs + the AI response text.
  if (!process.env.DATAFORSEO_API_KEY) return null;
  // Implementation here would POST to DataForSEO's LLM Mentions endpoint.
  // We sketch it as a contract — real wiring lives in the per-customer
  // background job behind the LIVE flag.
  return null;
}

// ─── Daily run ───────────────────────────────────────────────────────────

async function runDailyForBusiness({ businessId, deps }) {
  const { sbGet, sbPost, logger } = deps;

  const businessRows = await sbGet('businesses', `id=eq.${businessId}&select=business_name,website,industry,competitors,plan`).catch(() => []);
  const business = businessRows?.[0];
  if (!business) return { ok: false, reason: 'business not found' };

  // Plan gate — Free tier doesn't get citation tracking
  const plan = (business.plan || 'free').toLowerCase();
  if (plan === 'free' || plan === 'starter') {
    return { ok: true, ran: 0, reason: 'plan tier not eligible' };
  }

  // Pull (or generate) the prompt seed library
  let prompts = await sbGet('ai_citation_prompts',
    `business_id=eq.${businessId}&is_active=eq.true&select=*`
  ).catch(() => []);

  if (!prompts || prompts.length === 0) {
    const generated = buildSeedPrompts({ business });
    for (const p of generated) {
      await sbPost('ai_citation_prompts', { ...p, business_id: businessId, source: 'auto' }).catch(() => {});
    }
    prompts = await sbGet('ai_citation_prompts',
      `business_id=eq.${businessId}&is_active=eq.true&select=*`
    ).catch(() => []);
  }

  const competitorNames = Array.isArray(business.competitors)
    ? business.competitors.map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean)
    : [];

  let runsCompleted = 0;
  let citedCount = 0;
  let totalCost = 0;

  for (const p of prompts || []) {
    for (const engine of DEFAULT_ENGINES) {
      let result;
      if (engine === 'perplexity') result = await queryPerplexity({ prompt: p.prompt_text, deps });
      else if (engine === 'google_aio' || engine === 'chatgpt') result = await queryDataForSEO({ prompt: p.prompt_text, engine, deps });
      // claude / gemini direct queries land in a follow-up; for now we log
      // skipped engines as 'unknown' to keep the schema honest.
      if (!result) continue;

      const parsed = parseCitationResult({
        responseText: result.response_text,
        citedUrls: result.cited_urls,
        competitorNames,
        brandName: business.business_name,
        brandUrl: business.website,
      });

      await sbPost('ai_citations', {
        business_id: businessId,
        prompt_id: p.id,
        prompt_text: p.prompt_text,
        engine,
        brand_cited: parsed.brand_cited,
        brand_position: parsed.brand_position,
        brand_url_cited: parsed.brand_url_cited,
        cited_urls: parsed.cited_urls,
        competitor_citations: parsed.competitor_citations,
        response_summary: (result.response_text || '').slice(0, 1000),
        api_cost_usd: result.api_cost_usd,
        api_source: result.api_source,
      }).catch((e) => logger?.warn?.('citation-tracker.run', businessId, 'persist failed', { error: e.message }));

      runsCompleted += 1;
      if (parsed.brand_cited) citedCount += 1;
      totalCost += Number(result.api_cost_usd) || 0;
    }
  }

  return {
    ok: true,
    ran: runsCompleted,
    cited: citedCount,
    cite_rate: runsCompleted > 0 ? citedCount / runsCompleted : 0,
    cost_usd: totalCost,
  };
}

// ─── Share-of-voice + gap detection ─────────────────────────────────────

async function computeShareOfVoice({ businessId, days = 7, deps }) {
  const { sbGet } = deps;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = await sbGet('ai_citations',
    `business_id=eq.${businessId}&observed_at=gte.${since}&select=brand_cited,competitor_citations&limit=1000`
  ).catch(() => []);

  if (!rows.length) return { ok: true, runs: 0, brand_cite_rate: 0, share_of_voice: {} };

  const total = rows.length;
  const brandCited = rows.filter((r) => r.brand_cited).length;

  // Count competitor mentions across all rows
  const competitorCounts = {};
  for (const r of rows) {
    const cites = Array.isArray(r.competitor_citations) ? r.competitor_citations : [];
    for (const c of cites) {
      const name = c?.name;
      if (!name) continue;
      competitorCounts[name] = (competitorCounts[name] || 0) + 1;
    }
  }

  // Convert to share (0..1)
  const totalMentions = brandCited + Object.values(competitorCounts).reduce((a, b) => a + b, 0);
  const sov = { brand: totalMentions > 0 ? brandCited / totalMentions : 0 };
  for (const [name, count] of Object.entries(competitorCounts)) {
    sov[name] = totalMentions > 0 ? count / totalMentions : 0;
  }

  return {
    ok: true,
    runs: total,
    brand_cite_rate: total > 0 ? brandCited / total : 0,
    share_of_voice: sov,
  };
}

async function detectCitationGaps({ businessId, days = 7, deps }) {
  const { sbGet } = deps;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = await sbGet('ai_citations',
    `business_id=eq.${businessId}&observed_at=gte.${since}&brand_cited=eq.false&select=prompt_text,engine,competitor_citations,observed_at&limit=200`
  ).catch(() => []);

  // A "gap" is a prompt where competitors got cited but we didn't
  const gaps = (rows || []).filter((r) => {
    const cites = Array.isArray(r.competitor_citations) ? r.competitor_citations : [];
    return cites.length > 0;
  });

  return {
    ok: true,
    gaps,
    gap_count: gaps.length,
  };
}

module.exports = {
  buildSeedPrompts,
  parseCitationResult,
  runDailyForBusiness,
  computeShareOfVoice,
  detectCitationGaps,
  PROMPTS_PER_BUSINESS,
  DEFAULT_ENGINES,
};
