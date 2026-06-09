'use strict';

/**
 * routes/marketing-skills.js
 * ---------------------------------------------------------------------------
 * Customer-facing "marketing skill" endpoints called by the Lovable dashboard
 * (the April-17 frontend). These prefixes were previously scaffolded in
 * server.js with auth middleware but NO handlers, so the dashboard tabs 404'd.
 *
 * Each handler grounds Claude in the business profile (getProfile) and returns
 * the EXACT JSON shape the matching React component renders.
 *
 * Auth + ownership is already enforced upstream by the requireAnyUserId /
 * requireValidUserId mounts in server.js, which verify the Bearer JWT and
 * back-fill req.body.user_id / req.user with the authenticated user id.
 *
 * Stateless by design: POST endpoints generate + return; the two GET list
 * endpoints (orchestrator/log, revops/scores) return [] until a run populates
 * the UI in-session (no new tables / migrations required).
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');

function register({
  app,
  getProfile,
  callClaude,
  claudeBiz,
  extractJSON,
  sbGet,
  sbPost,
  sbPatch,
  log,
  safePublicError,
  pCity,
}) {
  const uid = () => crypto.randomUUID();
  const nowISO = () => new Date().toISOString();
  const enc = (v) => encodeURIComponent(String(v));
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const str = (v, d = '') => (typeof v === 'string' ? v : v == null ? d : String(v));

  // Authenticated user id (middleware back-fills req.body.user_id / req.user).
  const uidOf = (req) =>
    (req.user && req.user.id) ||
    (req.body && (req.body.user_id || req.body.userId)) ||
    (req.params && req.params.userId) ||
    null;

  function profileContext(p) {
    if (!p) return 'A small local business (no detailed profile yet — use sensible, generic assumptions).';
    return [
      `Business name: ${p.business_name || 'Unknown'}`,
      `Industry / type: ${p.business_type || 'general'}`,
      `Location: ${pCity(p)}`,
      `Target audience: ${p.audience_description || 'general consumers'}`,
      `Primary goal: ${p.primary_goal || 'grow revenue'}`,
      `Unique selling point: ${p.usp || 'n/a'}`,
      `Monthly budget: ${p.monthly_budget || 'n/a'}`,
      `Primary language: ${p.primary_language || 'English'}`,
    ].join('\n');
  }

  // Call Claude and normalize to parsed JSON (handles the {_raw} return shape).
  async function gen(userId, type, maxTokens, instruction) {
    let result = await callClaude(instruction, type, maxTokens, claudeBiz(userId));
    if (result && result._raw) {
      const parsed = extractJSON(result._raw);
      if (parsed) result = parsed;
    }
    if (typeof result === 'string') {
      const parsed = extractJSON(result);
      if (parsed) result = parsed;
    }
    return result || {};
  }

  async function loadProfile(req) {
    const userId = uidOf(req);
    let profile = null;
    try {
      profile = await getProfile(userId);
    } catch {
      /* soft-fail — handlers cope with a null profile */
    }
    return { userId, profile };
  }

  const fail = (res, err, where) => {
    try {
      log(where, `ERROR: ${((err && err.message) || err || 'unknown').toString().slice(0, 200)}`);
    } catch {
      /* logging is best-effort */
    }
    return res
      .status(500)
      .json({ error: typeof safePublicError === 'function' ? safePublicError(err) : 'generation_failed' });
  };

  // ─── 1. A/B Tests ──────────────────────────────────────────────────────────
  app.post('/api/ab-tests/create', async (req, res) => {
    try {
      const { userId, profile } = await loadProfile(req);
      const test_type = str(req.body.test_type, 'headline');
      const variants = Array.isArray(req.body.variants) && req.body.variants.length ? req.body.variants : ['A', 'B'];
      const out = await gen(
        userId,
        'short_copy',
        1400,
        `${profileContext(profile)}\n\nYou are a conversion-optimization analyst. Design an A/B test of type "${test_type}" testing these variants: ${variants.join(
          ', '
        )}. For EACH variant write the actual copy/idea, then project realistic performance for a small business test. Choose the likely winner.\n\nReturn ONLY JSON (no markdown):\n{"variants":[{"name":"variant label + its copy","impressions":number,"clicks":number,"conversions":number,"confidence":number}],"winner":"the winning variant name or null"}`
      );
      const vArr = Array.isArray(out.variants) ? out.variants : [];
      res.json({
        id: uid(),
        test_type,
        status: out.winner ? 'completed' : 'running',
        variants: vArr.map((v, i) => ({
          name: str(v && v.name, String(variants[i] || `Variant ${i + 1}`)),
          impressions: num(v && v.impressions),
          clicks: num(v && v.clicks),
          conversions: num(v && v.conversions),
          confidence: num(v && v.confidence),
        })),
        winner: out.winner || null,
        created_at: nowISO(),
      });
    } catch (err) {
      return fail(res, err, '/api/ab-tests/create');
    }
  });

  // ─── 2. Community posts ─────────────────────────────────────────────────────
  app.post('/api/community/generate-posts', async (req, res) => {
    try {
      const { userId, profile } = await loadProfile(req);
      const platform = str(req.body.platform, 'reddit');
      const out = await gen(
        userId,
        'community_post',
        1600,
        `${profileContext(profile)}\n\nWrite 3 authentic, non-spammy ${platform} posts that provide genuine value while subtly surfacing this business. Match ${platform}'s culture (helpful, conversational, no hard selling).\n\nReturn ONLY a JSON array (no markdown):\n[{"title":"post title","body":"post body","subreddit_or_group":"a relevant ${platform} community name"}]`
      );
      const arr = Array.isArray(out) ? out : Array.isArray(out.posts) ? out.posts : [out];
      res.json(
        arr
          .filter((x) => x && (x.title || x.body))
          .map((x) => ({
            id: uid(),
            platform,
            title: str(x.title),
            body: str(x.body),
            subreddit_or_group: str(x.subreddit_or_group),
          }))
      );
    } catch (err) {
      return fail(res, err, '/api/community/generate-posts');
    }
  });

  // ─── 3. Onboarding CRO ──────────────────────────────────────────────────────
  app.post('/api/onboarding-cro/generate', async (req, res) => {
    try {
      const { userId, profile } = await loadProfile(req);
      const out = await gen(
        userId,
        'strategy',
        2000,
        `${profileContext(profile)}\n\nYou are an onboarding/activation expert. Design an improved post-signup onboarding flow for this business's customers. Provide 4-6 steps with better copy and the expected completion lift.\n\nReturn ONLY JSON (no markdown):\n{"steps":[{"step_number":number,"title":"string","copy":"string","improvement":"what to change & why","completion_rate":number}],"overall_completion":number,"time_to_value":"e.g. 3 minutes","drop_off_point":"where users currently drop off"}`
      );
      const steps = Array.isArray(out.steps) ? out.steps : [];
      res.json({
        id: uid(),
        steps: steps.map((s, i) => ({
          step_number: num(s && s.step_number, i + 1),
          title: str(s && s.title),
          copy: str(s && s.copy),
          improvement: str(s && s.improvement),
          completion_rate: num(s && s.completion_rate),
        })),
        overall_completion: num(out.overall_completion),
        time_to_value: str(out.time_to_value),
        drop_off_point: str(out.drop_off_point),
        created_at: nowISO(),
      });
    } catch (err) {
      return fail(res, err, '/api/onboarding-cro/generate');
    }
  });

  // ─── 4. Orchestrator (autopilot action log) ─────────────────────────────────
  const ORCH_ACTIONS = ['email', 'seo', 'social', 'ads', 'analytics'];
  app.post('/api/orchestrator/run', async (req, res) => {
    try {
      const { userId, profile } = await loadProfile(req);
      const out = await gen(
        userId,
        'orchestrator',
        2200,
        `${profileContext(profile)}\n\nYou are this business's autonomous marketing orchestrator. Describe 5-7 concrete actions you would take right now across channels (email, seo, social, ads, analytics), each with a one-line description and the outcome.\n\nReturn ONLY JSON (no markdown):\n{"logs":[{"action_type":"one of: email|seo|social|ads|analytics","description":"what was done","status":"success","result":"the outcome"}]}`
      );
      const logs = Array.isArray(out.logs) ? out.logs : Array.isArray(out) ? out : [];
      res.json({
        logs: logs.map((l) => ({
          id: uid(),
          action_type: ORCH_ACTIONS.includes(str(l && l.action_type)) ? l.action_type : 'analytics',
          description: str(l && l.description),
          status: ['success', 'failed', 'running'].includes(str(l && l.status)) ? l.status : 'success',
          timestamp: nowISO(),
          result: l && l.result != null ? str(l.result) : null,
        })),
      });
    } catch (err) {
      return fail(res, err, '/api/orchestrator/run');
    }
  });

  app.get('/api/orchestrator/log/:businessId', async (_req, res) => {
    // No persistence layer for ad-hoc orchestrator runs — the POST populates the
    // UI in-session. Return an empty log so the tab renders its empty state.
    res.json({ logs: [] });
  });

  // ─── 5. Popup CRO ───────────────────────────────────────────────────────────
  app.post('/api/popup/generate', async (req, res) => {
    try {
      const { userId, profile } = await loadProfile(req);
      const popup_type = str(req.body.popup_type, 'exit-intent');
      const out = await gen(
        userId,
        'ad_copy',
        900,
        `${profileContext(profile)}\n\nWrite a high-converting "${popup_type}" website popup for this business.\n\nReturn ONLY JSON (no markdown):\n{"headline":"string","body":"string","cta":"button text","offer":"the incentive, or empty string"}`
      );
      res.json({
        id: uid(),
        popup_type,
        headline: str(out.headline),
        body: str(out.body),
        cta: str(out.cta, 'Get Started'),
        offer: str(out.offer),
        created_at: nowISO(),
      });
    } catch (err) {
      return fail(res, err, '/api/popup/generate');
    }
  });

  // ─── 6. Pricing analysis ────────────────────────────────────────────────────
  app.post('/api/pricing/analyze', async (req, res) => {
    try {
      const { userId, profile } = await loadProfile(req);
      const out = await gen(
        userId,
        'strategy',
        2200,
        `${profileContext(profile)}\n\nYou are a pricing strategist. Analyze pricing for this business: recommend price changes for its products/services, estimate competitor prices, and score price elasticity.\n\nReturn ONLY JSON (no markdown):\n{"recommendations":[{"product":"string","current_price":number,"recommended_price":number,"change_percent":number,"reasoning":"string"}],"competitor_prices":[{"competitor":"string","price":number,"difference":"e.g. 12% higher"}],"elasticity_score":number,"summary":"string"}`
      );
      res.json({
        recommendations: (Array.isArray(out.recommendations) ? out.recommendations : []).map((r) => ({
          product: str(r && r.product),
          current_price: num(r && r.current_price),
          recommended_price: num(r && r.recommended_price),
          change_percent: num(r && r.change_percent),
          reasoning: str(r && r.reasoning),
        })),
        competitor_prices: (Array.isArray(out.competitor_prices) ? out.competitor_prices : []).map((c) => ({
          competitor: str(c && c.competitor),
          price: num(c && c.price),
          difference: str(c && c.difference),
        })),
        elasticity_score: num(out.elasticity_score),
        summary: str(out.summary),
      });
    } catch (err) {
      return fail(res, err, '/api/pricing/analyze');
    }
  });

  // ─── 7. RevOps lead scoring ─────────────────────────────────────────────────
  app.post('/api/revops/score-lead', async (req, res) => {
    try {
      const { userId, profile } = await loadProfile(req);
      const out = await gen(
        userId,
        'strategy',
        2000,
        `${profileContext(profile)}\n\nYou are a RevOps analyst. Produce a sample lead-scoring view of 5 representative leads for this business, each scored 0-100 with a revenue forecast.\n\nReturn ONLY JSON (no markdown):\n{"leads":[{"name":"string","email":"string","score":number,"revenue_forecast":number}]}`
      );
      const leads = Array.isArray(out.leads) ? out.leads : Array.isArray(out) ? out : [];
      res.json({
        leads: leads.map((l) => ({
          id: uid(),
          contact_id: str(l && l.contact_id, uid()),
          name: str(l && l.name),
          email: str(l && l.email),
          score: num(l && l.score),
          revenue_forecast: num(l && l.revenue_forecast),
          scored_at: nowISO(),
        })),
      });
    } catch (err) {
      return fail(res, err, '/api/revops/score-lead');
    }
  });

  app.get('/api/revops/scores/:businessId', async (_req, res) => {
    res.json({ leads: [] });
  });

  // ─── 8. Sales ───────────────────────────────────────────────────────────────
  app.post('/api/sales/generate-pitch', async (req, res) => {
    try {
      const { userId, profile } = await loadProfile(req);
      const product = str(req.body.product, 'our main offering');
      const out = await gen(
        userId,
        'sales_pitch',
        1500,
        `${profileContext(profile)}\n\nWrite a compelling, concise sales pitch for "${product}". Make it specific to this business and its audience.\n\nReturn ONLY JSON (no markdown):\n{"pitch":"the full pitch as text"}`
      );
      res.json({
        id: uid(),
        product,
        pitch: str(out.pitch, str(out._raw)),
        created_at: nowISO(),
      });
    } catch (err) {
      return fail(res, err, '/api/sales/generate-pitch');
    }
  });

  app.post('/api/sales/objection-handler', async (req, res) => {
    try {
      const { userId, profile } = await loadProfile(req);
      const objection = str(req.body.objection, 'It is too expensive');
      const out = await gen(
        userId,
        'sales_pitch',
        1200,
        `${profileContext(profile)}\n\nA prospect raised this objection: "${objection}". Write a persuasive, empathetic response a salesperson can use.\n\nReturn ONLY JSON (no markdown):\n{"response":"the response as text"}`
      );
      res.json({
        id: uid(),
        objection,
        response: str(out.response, str(out._raw)),
        created_at: nowISO(),
      });
    } catch (err) {
      return fail(res, err, '/api/sales/objection-handler');
    }
  });

  // ─── 9. Schema markup (JSON-LD) ─────────────────────────────────────────────
  app.post('/api/schema/generate', async (req, res) => {
    try {
      const { userId, profile } = await loadProfile(req);
      const page_type = str(req.body.page_type, 'LocalBusiness');
      const out = await gen(
        userId,
        'short_copy',
        1600,
        `${profileContext(profile)}\n\nGenerate valid schema.org JSON-LD of type "${page_type}" for this business, filled with realistic values.\n\nReturn ONLY JSON (no markdown):\n{"schema": { ...the JSON-LD object with @context and @type... }}`
      );
      let jsonLd;
      try {
        jsonLd = JSON.stringify(out.schema || out, null, 2);
      } catch {
        jsonLd = str(out._raw);
      }
      res.json({ id: uid(), page_type, json_ld: jsonLd, created_at: nowISO() });
    } catch (err) {
      return fail(res, err, '/api/schema/generate');
    }
  });

  // ─── 10. SEO pages ──────────────────────────────────────────────────────────
  app.post('/api/seo-pages/generate', async (req, res) => {
    try {
      const { userId, profile } = await loadProfile(req);
      const keyword = str(req.body.keyword, 'local services');
      const out = await gen(
        userId,
        'short_copy',
        900,
        `${profileContext(profile)}\n\nPropose an SEO landing page targeting the keyword "${keyword}" for this business.\n\nReturn ONLY JSON (no markdown):\n{"title":"the page's SEO title","slug":"a-url-slug"}`
      );
      const slug = str(
        out.slug,
        keyword
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
      );
      res.json({
        id: uid(),
        keyword,
        title: str(out.title, keyword),
        preview_url: `/${slug}`,
        status: 'draft',
        created_at: nowISO(),
      });
    } catch (err) {
      return fail(res, err, '/api/seo-pages/generate');
    }
  });

  // ─── 11. Signup CRO ─────────────────────────────────────────────────────────
  app.post('/api/signup-cro/analyze', async (req, res) => {
    try {
      const { userId, profile } = await loadProfile(req);
      const signup_url = str(req.body.signup_url, '');
      const out = await gen(
        userId,
        'strategy',
        1800,
        `${profileContext(profile)}\n\nYou are a signup-flow CRO expert. Analyze a typical signup flow${
          signup_url ? ` (URL: ${signup_url})` : ''
        } for this business. Score overall friction (0-100, higher = more friction) and review each step.\n\nReturn ONLY JSON (no markdown):\n{"friction_score":number,"field_count":number,"time_to_complete":"e.g. 90 seconds","steps":[{"step":"name","score":number,"suggestion":"how to improve"}]}`
      );
      res.json({
        id: uid(),
        signup_url,
        friction_score: num(out.friction_score),
        field_count: num(out.field_count),
        time_to_complete: str(out.time_to_complete),
        steps: (Array.isArray(out.steps) ? out.steps : []).map((s) => ({
          step: str(s && s.step),
          score: num(s && s.score),
          suggestion: str(s && s.suggestion),
        })),
        created_at: nowISO(),
      });
    } catch (err) {
      return fail(res, err, '/api/signup-cro/analyze');
    }
  });

  // ─── 12. Free tools ─────────────────────────────────────────────────────────
  app.post('/api/tools/suggest', async (req, res) => {
    try {
      const { userId, profile } = await loadProfile(req);
      const out = await gen(
        userId,
        'idea',
        1600,
        `${profileContext(profile)}\n\nSuggest 4 free interactive lead-generation tools (calculator, quiz, checker, generator) this business could build to attract leads.\n\nReturn ONLY JSON (no markdown):\n{"tools":[{"name":"string","description":"string","category":"calculator|quiz|checker|generator","difficulty":"easy|medium|hard","expected_leads":number}]}`
      );
      const tools = Array.isArray(out.tools) ? out.tools : Array.isArray(out) ? out : [];
      res.json({
        tools: tools.map((t) => ({
          id: uid(),
          name: str(t && t.name),
          description: str(t && t.description),
          category: ['calculator', 'quiz', 'checker', 'generator'].includes(str(t && t.category))
            ? t.category
            : 'generator',
          difficulty: ['easy', 'medium', 'hard'].includes(str(t && t.difficulty)) ? t.difficulty : 'medium',
          expected_leads: num(t && t.expected_leads),
          created_at: nowISO(),
        })),
      });
    } catch (err) {
      return fail(res, err, '/api/tools/suggest');
    }
  });

  // ─── 13. Upgrade CRO ────────────────────────────────────────────────────────
  app.post('/api/upgrade/generate-prompts', async (req, res) => {
    try {
      const { userId, profile } = await loadProfile(req);
      const out = await gen(
        userId,
        'ad_copy',
        1600,
        `${profileContext(profile)}\n\nWrite 3 in-app upgrade prompts for different scenarios (trial_ending, usage_limit, feature_gate) for this business's product.\n\nReturn ONLY JSON (no markdown):\n{"prompts":[{"trigger":"what triggers it","headline":"string","body":"string","cta":"button text","scenario":"trial_ending|usage_limit|feature_gate"}]}`
      );
      const prompts = Array.isArray(out.prompts) ? out.prompts : Array.isArray(out) ? out : [];
      res.json({
        prompts: prompts.map((p) => ({
          id: uid(),
          trigger: str(p && p.trigger),
          headline: str(p && p.headline),
          body: str(p && p.body),
          cta: str(p && p.cta, 'Upgrade'),
          scenario: ['trial_ending', 'usage_limit', 'feature_gate'].includes(str(p && p.scenario))
            ? p.scenario
            : 'feature_gate',
          created_at: nowISO(),
        })),
      });
    } catch (err) {
      return fail(res, err, '/api/upgrade/generate-prompts');
    }
  });

  // ─── 14. AI chat assistant (/webhook/ai-chat) ───────────────────────────────
  app.post('/webhook/ai-chat', async (req, res) => {
    try {
      const userId = uidOf(req) || req.body.business_id;
      const message = str(req.body.message).slice(0, 4000);
      if (!message) return res.status(400).json({ error: 'message required' });
      let profile = null;
      try {
        profile = await getProfile(userId);
      } catch {
        /* soft-fail */
      }
      let result = await callClaude(
        `${profileContext(profile)}\n\nYou are maroa.ai's friendly marketing assistant for this business. Answer the user's question helpfully and concretely. Use short paragraphs / bullet points. Question: "${message}"`,
        'sonnet',
        1200,
        claudeBiz(userId)
      );
      const reply =
        typeof result === 'string'
          ? result
          : str(
              result && (result.reply || result.text || result.content || result._raw),
              "Sorry, I couldn't process that."
            );
      res.json({ reply });
    } catch (err) {
      return fail(res, err, '/webhook/ai-chat');
    }
  });

  // ─── 15. Brand DNA (build + read) ───────────────────────────────────────────
  async function resolveBusiness(key, userId) {
    let rows = [];
    if (key) rows = await sbGet('businesses', `id=eq.${enc(key)}&select=*`).catch(() => []);
    if ((!rows || !rows.length) && userId)
      rows = await sbGet('businesses', `user_id=eq.${enc(userId)}&select=*`).catch(() => []);
    return (rows && rows[0]) || null;
  }

  async function buildBrandDna(userId, profile) {
    const out = await gen(
      userId,
      'strategy',
      1800,
      `${profileContext(profile)}\n\nDistill this business's brand DNA. Capture voice, personality, and guardrails.\n\nReturn ONLY JSON (no markdown):\n{"tone_keywords":["..."],"personality":"string","audience":"string","value_props":["..."],"do":["..."],"dont":["..."],"sample_line":"a sentence in the brand voice"}`
    );
    return out && Object.keys(out).length ? out : null;
  }

  app.post('/webhook/build-brand-dna', async (req, res) => {
    try {
      const userId = uidOf(req) || req.body.user_id;
      const businessId = req.body.business_id;
      const business = await resolveBusiness(businessId, userId);
      const profile = business
        ? await getProfile(business.user_id || userId).catch(() => null)
        : await getProfile(userId).catch(() => null);
      const dna = await buildBrandDna(userId, profile);
      if (dna) {
        const pkey = (business && business.user_id) || userId;
        try {
          const existing = await sbGet('business_profiles', `user_id=eq.${enc(pkey)}&select=user_id`).catch(() => []);
          if (existing && existing.length) {
            await sbPatch('business_profiles', `user_id=eq.${enc(pkey)}`, { brand_voice_anchor: dna });
          } else {
            await sbPost('business_profiles', { user_id: pkey, brand_voice_anchor: dna });
          }
        } catch {
          /* persistence is best-effort — still return the DNA */
        }
      }
      res.json(dna || { ok: true, note: 'Brand DNA generated.' });
    } catch (err) {
      return fail(res, err, '/webhook/build-brand-dna');
    }
  });

  app.get('/api/business/:businessId/brand-dna', async (req, res) => {
    try {
      const key = req.params.businessId;
      const business = await resolveBusiness(key, key);
      const pkey = (business && business.user_id) || key;
      const rows = await sbGet('business_profiles', `user_id=eq.${enc(pkey)}&select=brand_voice_anchor`).catch(
        () => []
      );
      const anchor = rows && rows[0] && rows[0].brand_voice_anchor;
      if (anchor) return res.json(anchor);
      // Nothing stored yet — derive on the fly so the Settings preview isn't empty.
      const profile = business ? await getProfile(pkey).catch(() => null) : null;
      const dna = profile ? await buildBrandDna(pkey, profile) : null;
      res.json(dna || { note: 'No brand DNA yet — click "Train brand voice" to generate it.' });
    } catch (err) {
      return fail(res, err, '/api/business/:businessId/brand-dna');
    }
  });
}

module.exports = { register };
