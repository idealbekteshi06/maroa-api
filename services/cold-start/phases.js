'use strict';

/**
 * services/cold-start/phases.js
 * ---------------------------------------------------------------------------
 * Cold-start phase functions. Each phase:
 *   - takes ({ businessId, run, deps }) and returns { ok, data?, awaitingInput? }
 *   - is idempotent: re-running with the same inputs produces the same result
 *   - persists its slice of phase_results into the run row (caller does this)
 *   - never throws on user-recoverable errors; sets ok:false + reason instead
 *
 * `deps` is the dependency container injected from the route/Inngest layer:
 *   { sbGet, sbPost, sbPatch, callClaude, brandVoice, creativeDirector,
 *     higgsfield, adOptimizer, ai_seo, wf1, logger, sentry }
 *
 * Why a single deps object: makes phases unit-testable with mocks, and lets
 * the Inngest function inject the real services without tight coupling.
 * ---------------------------------------------------------------------------
 */

const PHASES = [
  'classify_industry',
  'detect_competitors',
  'build_brand_voice_anchor',
  'train_soul_id',
  'generate_concepts',
  'await_concept_approval',
  'launch_initial_campaigns',
  'schedule_first_content',
  'ship_ai_seo_baseline',
  'complete',
];

const PHASE_PCT = {
  classify_industry: 5,
  detect_competitors: 15,
  build_brand_voice_anchor: 25,
  train_soul_id: 40,
  generate_concepts: 55,
  await_concept_approval: 60,
  launch_initial_campaigns: 75,
  schedule_first_content: 85,
  ship_ai_seo_baseline: 95,
  complete: 100,
};

// ─── Phase 1: classify industry ──────────────────────────────────────────

async function classifyIndustry({ businessId, deps }) {
  const { sbGet, callClaude, logger } = deps;
  const rows = await sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []);
  const business = rows?.[0];
  if (!business) return { ok: false, reason: 'business not found' };

  // If business already has an industry classified by the user, skip the LLM
  // call and trust customer input. We only override when the field is empty.
  if (business.industry && business.industry.length > 2) {
    return {
      ok: true,
      data: {
        industry: business.industry,
        sub_industry: business.sub_industry || null,
        source: 'customer_provided',
      },
    };
  }

  const system = [
    'You classify SMBs into a single primary industry + optional sub-industry.',
    'Output JSON only: { "industry": "...", "sub_industry": "..." | null, "confidence": 0..1 }.',
    'Use canonical short labels: "dental clinic", "plumber", "real estate agent",',
    '"e-commerce apparel", "saas b2b", "restaurant", "fitness studio", "law firm", etc.',
    'If the input is ambiguous or empty, set confidence < 0.5 and pick the best guess.',
  ].join('\n');

  const userTask = JSON.stringify({
    business_name: business.business_name || null,
    description: business.description || business.about || null,
    website: business.website || null,
    location: business.location || null,
    target_audience: business.target_audience || null,
  });

  let parsed;
  try {
    const r = await callClaude({
      model: 'sonnet',
      system,
      messages: [{ role: 'user', content: userTask }],
      maxTokens: 200,
      cacheSystem: true,
    });
    const text = r?.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : null;
  } catch (e) {
    logger?.error?.('cold-start.classify_industry', businessId, 'llm failed', e);
    return { ok: false, reason: `classification failed: ${e.message}` };
  }

  if (!parsed?.industry) {
    return { ok: false, reason: 'classification produced no industry' };
  }

  return {
    ok: true,
    data: {
      industry: parsed.industry,
      sub_industry: parsed.sub_industry || null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
      source: 'llm',
    },
  };
}

// ─── Phase 2: detect competitors via SerpAPI ─────────────────────────────

async function detectCompetitors({ businessId, deps, prevPhaseData }) {
  const { sbGet, sbPatch, logger } = deps;
  const rows = await sbGet(
    'businesses',
    `id=eq.${businessId}&select=business_name,location,industry,competitors`
  ).catch(() => []);
  const business = rows?.[0];
  if (!business) return { ok: false, reason: 'business not found' };

  const industry = prevPhaseData?.industry || business.industry || 'business';
  const location = business.location || '';

  // If the business already has competitors loaded (manual or prior run), skip the API hit.
  const existing = Array.isArray(business.competitors) ? business.competitors : [];
  if (existing.length >= 3) {
    return { ok: true, data: { competitors: existing, source: 'cached' } };
  }

  if (!process.env.SERPAPI_KEY) {
    logger?.warn?.('cold-start.detect_competitors', businessId, 'SERPAPI_KEY missing — skipping with empty list');
    return { ok: true, data: { competitors: [], source: 'skipped_no_key' } };
  }

  const query = `top ${industry}${location ? ` in ${location}` : ''}`.slice(0, 100);
  let competitors = [];
  try {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('q', query);
    url.searchParams.set('engine', 'google');
    url.searchParams.set('num', '10');
    url.searchParams.set('api_key', process.env.SERPAPI_KEY);

    const res = await fetch(url.toString(), { method: 'GET' });
    if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`);
    const j = await res.json();

    const fromOrganic = (j.organic_results || [])
      .map((r) => ({ name: r.title, url: r.link, snippet: r.snippet || '' }))
      .filter((r) => r.url && !/google|wikipedia|yelp|reddit/i.test(r.url))
      .slice(0, 5);
    competitors = fromOrganic;
  } catch (e) {
    logger?.warn?.('cold-start.detect_competitors', businessId, 'serpapi failed', { error: e.message });
    return { ok: true, data: { competitors: [], source: 'serpapi_error', error: e.message } };
  }

  // Persist to businesses for downstream services (ad-optimizer reads this)
  if (competitors.length > 0) {
    await sbPatch?.('businesses', `id=eq.${businessId}`, { competitors }).catch(() => {});
  }

  return { ok: true, data: { competitors, source: 'serpapi' } };
}

// ─── Phase 3: build brand voice anchor ───────────────────────────────────

async function buildBrandVoiceAnchor({ businessId, deps }) {
  const { sbGet, sbPost, sbPatch, brandVoice, logger } = deps;
  if (!brandVoice?.buildAnchor) {
    return { ok: false, reason: 'brand-voice service not available' };
  }

  const rows = await sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []);
  const business = rows?.[0];
  if (!business) return { ok: false, reason: 'business not found' };

  // VOC may not exist yet for a brand-new business — that's fine, anchor falls
  // back to industry defaults.
  const vocRows = await sbGet(
    'voc_analyses',
    `business_id=eq.${businessId}&order=created_at.desc&limit=1&select=*`
  ).catch(() => []);
  const vocAnalysis = vocRows?.[0] || null;

  let anchor;
  try {
    anchor = brandVoice.buildAnchor({ business, vocAnalysis });
  } catch (e) {
    logger?.error?.('cold-start.build_brand_voice_anchor', businessId, 'build failed', e);
    return { ok: false, reason: e.message };
  }

  // Persist anchor to brand_voice_anchors table (per migration 043)
  await sbPost?.('brand_voice_anchors', {
    business_id: businessId,
    anchor,
    source: 'cold_start',
  }).catch((e) =>
    logger?.warn?.('cold-start.build_brand_voice_anchor', businessId, 'persist failed', { error: e.message })
  );

  return { ok: true, data: { anchor_summary: { tone: anchor.tone_descriptors, audience: anchor.audience_summary } } };
}

// ─── Phase 4: train Soul ID (gated on 3-angle photos uploaded) ───────────

/**
 * Soul ID character training phase — graceful Cloud-only fallback.
 *
 * Verified empirically (2026-05-10): Higgsfield CLOUD API
 * (platform.higgsfield.ai with Key auth) does NOT expose Soul ID
 * character training endpoints. Those live only on the consumer FNF API
 * (fnf.higgsfield.ai with Bearer token). Most Maroa deployments have
 * Cloud credentials only — that's where the credits live.
 *
 * Decision tree:
 *
 *   FNF Bearer token configured?
 *     ├─ NO (Cloud-only account)         → SKIP gracefully, set
 *     │                                    generation_mode=prompt_driven.
 *     │                                    Cold-start completes normally.
 *     ├─ YES + customer has 5+ photos    → train (full character-lock)
 *     └─ YES but customer has 0–4 photos → awaitingInput (collect more)
 *
 * Skipping is the A+++ default — it never blocks onboarding. Brand
 * consistency is maintained downstream via the brand voice anchor's
 * visual descriptors (palette, mood, style) baked into every prompt.
 */
async function trainSoulId({ businessId, deps }) {
  const { sbGet, sbPatch, higgsfield, logger } = deps;

  const hasFnfToken = !!(process.env.HIGGSFIELD_BEARER_TOKEN || '').trim();

  // ── Cloud-only path: graceful skip, never block onboarding ──
  if (!hasFnfToken) {
    await sbPatch?.('businesses', `id=eq.${businessId}`, {
      soul_id: null,
      soul_id_trained_at: null,
    }).catch(() => {});

    logger?.info?.('cold-start.train_soul_id', businessId, 'cloud-only — using prompt-driven generation', {
      reason: 'soul_id_training_endpoint_not_on_cloud_api',
      degradation: 'graceful',
      brand_consistency_via: 'brand_voice_anchor_visual_descriptors',
    });

    return {
      ok: true,
      data: {
        soul_id: null,
        used_cloud_only: true,
        generation_mode: 'prompt_driven',
        message:
          'Standard tier — your content uses prompt-driven generation anchored to your brand voice. Character-lock is available on Premium upgrade (separate Higgsfield consumer-flow account).',
      },
    };
  }

  // ── FNF path: Soul ID character lock available ──
  const photoRows = await sbGet(
    'business_photos',
    `business_id=eq.${businessId}&photo_type=eq.character_sheet&is_active=eq.true&select=id,photo_url`
  ).catch(() => []);

  const minImages = Number(process.env.HIGGSFIELD_SOUL_ID_MIN_IMAGES) || 5;
  if (!photoRows || photoRows.length < minImages) {
    return {
      ok: true,
      awaitingInput: true,
      data: {
        next_user_action: 'upload_character_sheet',
        message: `Upload ${minImages} photos of yourself (front, 3/4, profile, two more angles) to unlock Soul ID character lock`,
        uploaded: photoRows?.length ?? 0,
        required: minImages,
      },
    };
  }

  if (!higgsfield?.trainSoulCharacter) {
    logger?.warn?.('cold-start.train_soul_id', businessId, 'higgsfield.trainSoulCharacter not available');
    return { ok: true, data: { soul_id: null, source: 'higgsfield_unavailable' } };
  }

  let soulId;
  let modelUsed;
  let apiUsed;
  try {
    const r = await higgsfield.trainSoulCharacter({
      characterId: `biz_${businessId}`,
      sourceImageUrls: photoRows.slice(0, 10).map((p) => p.photo_url),
      name: `business_${businessId}`,
      model: 'soul_2',
    });
    soulId = r?.higgsfield_character_id || r?.soul_id || r?.id || null;
    modelUsed = r?.model_used || 'soul_2';
    apiUsed = r?.api_used || 'fnf';
  } catch (e) {
    // A+++ rule: training failure NEVER kills onboarding. Log + fall back
    // to prompt-driven generation. Customer's first content still ships.
    logger?.error?.('cold-start.train_soul_id', businessId, 'training failed — falling back to prompt-driven', {
      error: e.message,
    });
    return {
      ok: true,
      data: {
        soul_id: null,
        used_cloud_only: false,
        generation_mode: 'prompt_driven_fallback',
        training_error: e.message,
        message:
          'Character training had an issue — your content uses prompt-driven generation while we investigate. Brand consistency preserved via brand voice anchor.',
      },
    };
  }

  if (!soulId) {
    return {
      ok: true,
      data: {
        soul_id: null,
        used_cloud_only: false,
        generation_mode: 'prompt_driven_fallback',
        message: 'Character training did not return an id — using prompt-driven generation.',
      },
    };
  }

  await sbPatch?.('businesses', `id=eq.${businessId}`, {
    soul_id: soulId,
    soul_id_trained_at: new Date().toISOString(),
  }).catch(() => {});

  return {
    ok: true,
    data: {
      soul_id: soulId,
      model_used: modelUsed,
      api_used: apiUsed,
      generation_mode: 'character_locked',
    },
  };
}

// ─── Phase 5: generate creative concepts (3 variants) ────────────────────

async function generateConcepts({ businessId, run, deps }) {
  const { sbGet, sbPost, creativeDirector, callClaude, logger } = deps;

  // Skip if concepts already proposed for this run (idempotency).
  const existing = await sbGet(
    'cold_start_concepts',
    `run_id=eq.${run.id}&select=id,variant_index,status&limit=10`
  ).catch(() => []);
  if (existing && existing.length >= 3) {
    return {
      ok: true,
      awaitingInput: existing.every((c) => c.status === 'proposed'),
      data: { concept_count: existing.length, source: 'existing' },
    };
  }

  if (!creativeDirector?.buildCreativeBrief) {
    return { ok: false, reason: 'creative-director service not available' };
  }

  const businessRows = await sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []);
  const business = businessRows?.[0];
  if (!business) return { ok: false, reason: 'business not found' };

  // Pull stored anchor for brandDNA
  const anchorRows = await sbGet(
    'brand_voice_anchors',
    `business_id=eq.${businessId}&order=created_at.desc&limit=1&select=anchor`
  ).catch(() => []);
  const brandDNA = anchorRows?.[0]?.anchor || {};

  const businessGoal = business.marketing_goal || 'awareness';
  const contentGoal = `Launch creative concepts for ${business.industry || 'business'} — first impression that converts`;

  const concepts = [];
  for (let variant = 1; variant <= 3; variant += 1) {
    let concept;
    try {
      const { system, userTask } = creativeDirector.buildCreativeBrief({
        brandDNA,
        businessGoal,
        contentGoal,
        ideaLevel: variant === 1 ? 'safe' : variant === 2 ? 'balanced' : 'bold',
        rotation: variant,
      });
      const r = await callClaude({
        model: 'opus',
        system,
        messages: [{ role: 'user', content: userTask }],
        maxTokens: 2000,
        cacheSystem: true,
      });
      const text = r?.content?.[0]?.text || '';
      const match = text.match(/\{[\s\S]*\}/);
      concept = match ? JSON.parse(match[0]) : null;
    } catch (e) {
      logger?.warn?.('cold-start.generate_concepts', businessId, `variant ${variant} failed`, { error: e.message });
      continue;
    }
    if (!concept) continue;
    concepts.push({ variant, concept });
  }

  if (concepts.length === 0) {
    return { ok: false, reason: 'no concepts generated' };
  }

  // Persist atomically when the migration-071 RPC is available; otherwise
  // fall back to the legacy two-call loop. The RPC wraps the runs upsert
  // and every concept insert in a single transaction so a partial failure
  // can't leave orphan rows — audit 2026-05-18 H4.
  const sbRpc = deps.sbRpc;
  const conceptsJson = concepts.map((c) => ({
    run_id: run.id,
    business_id: businessId,
    variant_index: c.variant,
    concept: c.concept,
    status: 'proposed',
  }));
  let used = 'rpc';
  if (typeof sbRpc === 'function') {
    try {
      await sbRpc('cold_start_initialize', {
        p_business_id: businessId,
        p_phase: 'generate_concepts',
        p_concepts: conceptsJson,
      });
    } catch (e) {
      // RPC_NOT_FOUND (404) → fall back. Anything else → log and fall back
      // too; the legacy path still works.
      used = 'legacy';
      logger?.warn?.('cold-start.generate_concepts', businessId, 'rpc fallback', {
        error: e.message,
      });
    }
  } else {
    used = 'legacy';
  }
  if (used === 'legacy') {
    for (const c of concepts) {
      await sbPost?.('cold_start_concepts', {
        run_id: run.id,
        business_id: businessId,
        variant_index: c.variant,
        concept: c.concept,
        status: 'proposed',
      }).catch((e) =>
        logger?.warn?.('cold-start.generate_concepts', businessId, 'persist failed', { error: e.message }),
      );
    }
  }

  return {
    ok: true,
    awaitingInput: true,
    data: {
      concept_count: concepts.length,
      next_user_action: 'approve_concept',
      message: `Review ${concepts.length} concepts and tap to approve one`,
    },
  };
}

// ─── Phase 6: wait for concept approval (no-op; orchestrator pauses) ─────

async function awaitConceptApproval({ businessId, run, deps }) {
  const { sbGet } = deps;
  const approved = await sbGet(
    'cold_start_concepts',
    `run_id=eq.${run.id}&status=eq.approved&select=id,variant_index,concept&limit=1`
  ).catch(() => []);
  if (!approved || approved.length === 0) {
    return {
      ok: true,
      awaitingInput: true,
      data: { next_user_action: 'approve_concept', message: 'Waiting for concept approval' },
    };
  }
  return { ok: true, data: { approved_concept: approved[0] } };
}

// ─── Phase 7: launch initial campaigns ───────────────────────────────────

async function launchInitialCampaigns({ businessId, run, deps, prevPhaseData }) {
  const { adOptimizer, logger } = deps;
  if (!adOptimizer?.coldStartLaunch) {
    logger?.warn?.('cold-start.launch_initial_campaigns', businessId, 'ad-optimizer coldStartLaunch not available');
    return { ok: true, data: { launched: 0, source: 'launcher_unavailable' } };
  }

  let result;
  try {
    result = await adOptimizer.coldStartLaunch({
      businessId,
      approvedConcept: prevPhaseData?.approved_concept,
      coldStartRunId: run.id,
    });
  } catch (e) {
    logger?.error?.('cold-start.launch_initial_campaigns', businessId, 'launch failed', e);
    return { ok: false, reason: `campaign launch failed: ${e.message}` };
  }

  return {
    ok: true,
    data: {
      campaigns_launched: result?.launched ?? 0,
      campaign_ids: result?.campaign_ids ?? [],
      platforms: result?.platforms ?? [],
    },
  };
}

// ─── Phase 8: schedule first content batch (week 1 calendar) ─────────────

async function scheduleFirstContent({ businessId, deps }) {
  const { wf1, logger } = deps;
  if (!wf1?.dailyRun?.runForBusiness) {
    logger?.warn?.('cold-start.schedule_first_content', businessId, 'wf1.dailyRun not available');
    return { ok: true, data: { scheduled: 0, source: 'wf1_unavailable' } };
  }

  let result;
  try {
    result = await wf1.dailyRun.runForBusiness({ businessId, force: true });
  } catch (e) {
    logger?.error?.('cold-start.schedule_first_content', businessId, 'wf1 run failed', e);
    return { ok: false, reason: `content scheduling failed: ${e.message}` };
  }

  return {
    ok: true,
    data: { processed: result?.processed ?? null, status: result?.status ?? null },
  };
}

// ─── Phase 9: ship AI-SEO baseline ───────────────────────────────────────

async function shipAiSeoBaseline({ businessId, deps }) {
  const { aiSeo, logger } = deps;
  if (!aiSeo?.runBaseline) {
    logger?.warn?.('cold-start.ship_ai_seo_baseline', businessId, 'aiSeo.runBaseline not available');
    return { ok: true, data: { source: 'ai_seo_unavailable' } };
  }

  let result;
  try {
    result = await aiSeo.runBaseline({ businessId });
  } catch (e) {
    logger?.warn?.('cold-start.ship_ai_seo_baseline', businessId, 'baseline failed', { error: e.message });
    return { ok: true, data: { source: 'ai_seo_failed', error: e.message } };
  }

  return {
    ok: true,
    data: {
      llms_txt_generated: !!result?.llms_txt,
      schemas_generated: result?.schema_types?.length ?? 0,
      score: result?.score ?? null,
    },
  };
}

module.exports = {
  PHASES,
  PHASE_PCT,
  classifyIndustry,
  detectCompetitors,
  buildBrandVoiceAnchor,
  trainSoulId,
  generateConcepts,
  awaitConceptApproval,
  launchInitialCampaigns,
  scheduleFirstContent,
  shipAiSeoBaseline,
};
