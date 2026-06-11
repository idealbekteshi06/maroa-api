/*
 * services/wf1/engine.js
 * ----------------------------------------------------------------------------
 * The core of Workflow #1. Runs the 5 phases of the Daily Content Engine:
 *
 *   Phase 1: gather context bundle            (contextBundle.gatherBundle)
 *   Phase 2: strategic decision via Claude Opus  (prompts/workflow_1_daily_content.buildStrategicDecisionPrompt)
 *   Phase 3: per-concept platform generation via Sonnet (buildPlatformGenerationPrompt)
 *   Phase 4: quality gate via Haiku             (scoreAsset)
 *   Phase 5: publish vs approve-queue per autonomy mode
 *
 * Each phase is independently callable so the frontend can trigger them
 * individually (e.g. on-demand "generate now" button).
 * ----------------------------------------------------------------------------
 */

'use strict';

const { randomUUID } = require('node:crypto');
const {
  buildStrategicDecisionPrompt,
  buildPlatformGenerationPrompt,
  AUTONOMY_MODES,
} = require('../prompts/workflow_1_daily_content.js');
const { FOUNDATION_SYSTEM_PROMPT } = require('../prompts/foundation.js');
const creativeDirector = require('../prompts/creative-director');
const trendingHooks = require('../prompts/trending-hooks');
const { callMarketingClaude } = require('../../lib/marketingClaude');

// Higgsfield is the ONLY image provider for maroa.ai — no Replicate, no Flux,
// no fallback. Builds the image prompt from the structured visualBrief the
// generation prompt returns ({ style, shots[], thumbnailGuidance, brandAssets[] }).
function visualBriefToPrompt(vb, concept = {}) {
  if (!vb) return concept.core_idea || concept.hook || '';
  if (typeof vb === 'string') return vb;
  const parts = [];
  if (vb.style) parts.push(vb.style);
  if (Array.isArray(vb.shots) && vb.shots.length) parts.push(vb.shots.join('. '));
  if (vb.thumbnailGuidance) parts.push(vb.thumbnailGuidance);
  if (Array.isArray(vb.brandAssets) && vb.brandAssets.length) parts.push(`Brand assets: ${vb.brandAssets.join(', ')}`);
  return parts.filter(Boolean).join('. ') || concept.core_idea || concept.hook || '';
}

// Platforms that take video — these route through Higgsfield generateVideo
// (seedance / kling / wan) instead of generateImage.
const VIDEO_PLATFORMS = new Set(['instagram_reel', 'instagram_story', 'tiktok', 'youtube_shorts', 'social_reel']);

// Pick the right Higgsfield video model from concept signal. Mirrors the
// content_type intent: UGC → wan, cinematic/product → kling, social reel
// default → seedance. Explicit override beats routing so WF1 isn't at the
// mercy of modelRouter changes.
function videoModelForConcept(concept = {}) {
  const fmt = String(concept.format || '').toLowerCase();
  const pillar = String(concept.pillar || '').toLowerCase();
  if (/ugc|testimonial|lipsync/.test(fmt) || /ugc/.test(pillar)) return 'wan-2.5';
  if (/cinematic|hero/.test(fmt) || /cinematic|hero/.test(pillar)) return 'kling-3.0';
  return 'seedance-2.0';
}

// Normalize businesses.product_image_urls (JSONB array, possibly a JSON
// string or null) into a clean list of http(s) URLs.
function referenceImageList(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      arr = [raw];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
}

// Deterministic per-concept rotation so multiple concepts in one day don't
// all reference the same product photo.
function rotationIndex(seed, length) {
  if (length <= 1) return 0;
  const s = String(seed || '');
  let sum = 0;
  for (let i = 0; i < s.length; i += 1) sum = (sum + s.charCodeAt(i)) % length;
  return sum;
}

// Pure helper: portrait for feeds, vertical for reels/stories.
function aspectRatioForPlatform(platform) {
  switch (String(platform || '').toLowerCase()) {
    case 'instagram_reel':
    case 'instagram_story':
    case 'youtube_shorts':
    case 'tiktok':
      return '9:16';
    case 'instagram_feed':
      return '4:5';
    case 'facebook':
    case 'linkedin':
    case 'gbp_post':
    default:
      return '1:1';
  }
}

function createEngine({
  sbGet,
  sbPost,
  sbPatch,
  callClaude,
  extractJSON,
  logger,
  contextBundleBuilder,
  guardrails,
  buildBrandContext,
  // Higgsfield image/video service (services/higgsfield). Optional in unit
  // tests; required in production so generated assets get a real media_url.
  higgsfield,
  // Closed-loop creative system libraries — injected for testability.
  // See ADR-0005. Fall back to require() so production wiring just works.
  groundingContext,
  adversarialCritic,
  viralityPredictor,
  metrics,
}) {
  const _grounding = groundingContext || require('../../lib/groundingContext');
  const _critic = adversarialCritic || require('../../lib/adversarialCritic');
  const _strategicThinking = require('../../lib/strategicThinking');
  const _virality = viralityPredictor || require('../../lib/viralityPredictor');
  // ── Resolve brand context for a given business_id ─────────────────────
  async function resolveBrandContext(businessId) {
    const [bizRows, profileRows] = await Promise.all([
      sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
    ]);
    let business = bizRows[0];
    if (!business) {
      // Fallback: businesses keyed by user_id
      const alt = await sbGet('businesses', `user_id=eq.${businessId}&select=*`).catch(() => []);
      business = alt[0];
    }
    const profile = profileRows[0] || {};
    if (!business) throw new Error(`Business not found: ${businessId}`);
    return buildBrandContext({ business, profile });
  }

  // ── Resolve local date in business timezone ───────────────────────────
  async function resolveLocalDate(businessId) {
    const profileRows = await sbGet('business_profiles', `user_id=eq.${businessId}&select=timezone,country`).catch(
      () => []
    );
    const tz = profileRows[0]?.timezone || 'Europe/Belgrade';
    try {
      const d = new Date();
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      return fmt.format(d); // YYYY-MM-DD
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }

  // ── Fetch current autonomy mode + window from businesses row ──────────
  async function getAutonomyMode(businessId) {
    const rows = await sbGet(
      'businesses',
      `id=eq.${businessId}&select=wf1_autonomy_mode,wf1_hybrid_window_hours`
    ).catch(() => []);
    const mode = rows[0]?.wf1_autonomy_mode || 'hybrid';
    const windowHours = Number(rows[0]?.wf1_hybrid_window_hours || 4);
    return { mode, windowHours, config: AUTONOMY_MODES[mode] || AUTONOMY_MODES.hybrid };
  }

  // ── Phase 2: strategic decision ───────────────────────────────────────
  async function runStrategicDecision({ businessId, forceReplan = false }) {
    const brandContext = await resolveBrandContext(businessId);
    const todayLocalDate = await resolveLocalDate(businessId);

    // Idempotency: one plan per business per date unless forceReplan
    const existing = await sbGet(
      'content_plans',
      `business_id=eq.${businessId}&plan_date=eq.${todayLocalDate}&select=id,status`
    ).catch(() => []);
    if (existing[0] && !forceReplan) {
      logger?.info('/wf1/engine', businessId, 'plan already exists for today', {
        plan_id: existing[0].id,
        status: existing[0].status,
      });
      // Return the existing plan + concepts
      const concepts = await sbGet('content_concepts', `plan_id=eq.${existing[0].id}&select=*`).catch(() => []);
      return {
        runId: existing[0].id,
        planId: existing[0].id,
        analysis: existing[0].analysis,
        concepts,
        reused: true,
      };
    }

    const bundle = await contextBundleBuilder.gatherBundle({
      businessId,
      brandContext,
      todayLocalDate,
    });

    let { system, user } = buildStrategicDecisionPrompt(brandContext, bundle);
    user = trendingHooks.appendTrendingHooksToUserMessage(user, brandContext, bundle);

    // Agency tier gets the upstream Cannes-grade creative-director pass FIRST,
    // then folds the chosen concept into the daily-content prompt for richer
    // downstream concepts. Free/Growth tiers go straight to the existing path.
    const businessRow =
      (await sbGet('businesses', `id=eq.${businessId}&select=plan,plan_price`).catch(() => []))[0] || {};
    const isAgency = String(businessRow.plan || '').toLowerCase() === 'agency';

    let creativeConcept = null;
    let creativeConceptId = null;
    let augmentedSystem = system;
    let augmentedUser = user;

    if (isAgency) {
      try {
        const cdBrief = creativeDirector.buildCreativeBrief({
          brandDNA: {
            business_name: brandContext.businessName,
            industry: brandContext.industry,
            brand_tone: brandContext.toneOfVoice,
            target_audience: brandContext.idealCustomer,
            location: brandContext.country,
            marketing_goal: brandContext.northStarMetric,
            visualPalette: brandContext.visualPalette,
            compositionRules: brandContext.compositionRules,
            motionIdentity: brandContext.motionIdentity,
          },
          businessGoal: brandContext.northStarMetric || 'increase awareness',
          contentGoal: `Daily content theme for ${todayLocalDate}`,
          ideaLevel: 'campaign',
        });
        const cdRaw = await callMarketingClaude({
          callClaude,
          sbGet,
          sbPost,
          logger,
          system: cdBrief.system,
          user: cdBrief.userTask,
          task: 'creative',
          planTier: 'agency',
          businessId,
          skill: 'creative_director_wf1',
          max_tokens: 4000,
          webSearch: 3,
          cacheSystem: true,
          budget: 'deep',
          returnRaw: true,
        });
        creativeConcept = extractJSON(cdRaw) || {};
        if (creativeConcept?.top_concept) {
          // Persist as a creative_concepts row
          const ccRow = await sbPost('creative_concepts', {
            business_id: businessId,
            content_goal: `Daily content theme for ${todayLocalDate}`,
            idea_level: 'campaign',
            insight: creativeConcept.insight || null,
            tension_type: creativeConcept.tension_type || null,
            top_concept: creativeConcept.top_concept,
            runner_up: creativeConcept.runner_up || null,
            ideas_considered: creativeConcept.ideas_considered || [],
            weighted_score: Number(creativeConcept.top_concept?.scores?.weighted) || null,
            humankind_score: Number(creativeConcept.top_concept?.scores?.humankind) || null,
            grey_score: Number(creativeConcept.top_concept?.scores?.grey) || null,
            pattern: creativeConcept.top_concept?.pattern || null,
            comparable_canon: creativeConcept.top_concept?.comparable_canon || null,
            status: 'used',
            decided_at: new Date().toISOString(),
            model_used: 'claude-opus-4-7',
          }).catch(() => null);
          creativeConceptId = ccRow?.[0]?.id || ccRow?.id || null;
          // Inject the concept as additional context for the daily-content strategic prompt
          augmentedUser = `${user}\n\n---\nUPSTREAM CREATIVE-DIRECTOR CONCEPT (Cannes-grade Agency tier):\nInsight: ${creativeConcept.insight}\nTop concept: ${creativeConcept.top_concept?.name} — ${creativeConcept.top_concept?.one_sentence}\nPattern: ${creativeConcept.top_concept?.pattern}\nWhy it matters: ${creativeConcept.top_concept?.rationale || ''}\n\nLock the daily concepts to this strategic direction. Do not invent contradictory themes.`;
          logger?.info('/wf1/engine', businessId, 'creative-director concept locked', {
            concept_id: creativeConceptId,
            pattern: creativeConcept.top_concept?.pattern,
            weighted: creativeConcept.top_concept?.scores?.weighted,
          });
        }
      } catch (e) {
        logger?.warn('/wf1/engine', businessId, 'creative-director pass failed, falling back to standard path', {
          error: e.message,
        });
      }
    }

    // Claude Opus call with strategic-thinking wrapper.
    // wf1 Phase 2 is the highest-stakes generation in the system — it
    // sets the day's content theme for every downstream concept + asset.
    // Native extended-thinking on Opus 4.7 has the model plan before
    // generating. Falls back to <strategy> tag prompting if the API
    // rejects the param. See lib/strategicThinking.js + ADR-0005.
    const startedAt = Date.now();
    const thinkingResult = await _strategicThinking.strategize({
      callClaude,
      system: augmentedSystem,
      user: augmentedUser,
      model: 'claude-opus-4-7',
      max_tokens: 3500,
      businessId,
      skill: 'wf1_strategic_decision',
      thinkingBudget: 2000,
    });
    const raw = thinkingResult.output || thinkingResult.raw || '';
    const durationMs = Date.now() - startedAt;

    const parsed = extractJSON(raw) || {};
    const analysis = parsed.analysis || {};
    const conceptsIn = Array.isArray(parsed.concepts) ? parsed.concepts : [];

    if (!conceptsIn.length) {
      logger?.info('/wf1/engine', businessId, 'Claude returned empty concepts — skipping day', {
        raw_snippet: String(raw).slice(0, 400),
      });
    }

    // Persist the plan
    const planRow = await sbPost('content_plans', {
      business_id: businessId,
      plan_date: todayLocalDate,
      status: conceptsIn.length ? 'awaiting_approval' : 'skipped',
      analysis,
      context_snapshot: bundle,
      model_used: 'claude-opus-4-7',
    });

    // Persist concepts
    const concepts = [];
    for (const c of conceptsIn) {
      const row = await sbPost('content_concepts', {
        business_id: businessId,
        plan_id: planRow.id,
        platform: c.platform,
        format: c.format,
        pillar: c.pillar,
        funnel_stage: c.funnelStage,
        emotion: c.emotion,
        core_idea: c.coreIdea,
        hook: c.hook,
        hook_pattern: c.hookPattern || null,
        story_arc: c.storyArc || null,
        cta: c.cta,
        framework: c.framework,
        why_this_why_now: c.whyThisWhyNow,
        predicted_engagement_low: Array.isArray(c.predictedEngagementRange) ? c.predictedEngagementRange[0] : null,
        predicted_engagement_high: Array.isArray(c.predictedEngagementRange) ? c.predictedEngagementRange[1] : null,
        risk_level: c.riskLevel || 'low',
        cost_estimate_usd: c.costEstimate || 0,
        status: 'pending',
        creative_concept_id: creativeConceptId,
      }).catch((e) => {
        logger?.error('/wf1/engine', businessId, 'concept insert failed', e);
        return null;
      });
      if (row) concepts.push(row);
    }

    // Log event
    await sbPost('events', {
      business_id: businessId,
      kind: 'wf1.plan.created',
      workflow: '1_daily_content',
      payload: {
        plan_id: planRow.id,
        plan_date: todayLocalDate,
        concepts_count: concepts.length,
        reasoning_preview: (analysis.reasoning || '').slice(0, 200),
        duration_ms: durationMs,
      },
      severity: 'info',
    }).catch(() => {});

    return {
      runId: planRow.id,
      planId: planRow.id,
      planDate: todayLocalDate,
      analysis,
      concepts,
      reused: false,
    };
  }

  // ── Phase 3: platform-native asset generation for one concept ─────────
  async function generateAssetForConcept({ businessId, conceptId }) {
    const [conceptRows, brandContextReady] = await Promise.all([
      sbGet('content_concepts', `id=eq.${conceptId}&select=*`),
      resolveBrandContext(businessId),
    ]);
    const concept = conceptRows[0];
    if (!concept) throw new Error(`Concept not found: ${conceptId}`);
    if (concept.business_id !== businessId) {
      throw new Error(`Concept ${conceptId} does not belong to business ${businessId}`);
    }

    // Guardrails — pre-generation check
    const currentLocalTime = new Date();
    const guardResult = await guardrails.checkAll({
      businessId,
      concept,
      brandContext: brandContextReady,
      currentLocalTime,
    });
    if (!guardResult.allowed) {
      logger?.info('/wf1/engine', businessId, 'generation blocked by guardrails', {
        conceptId,
        reasons: guardResult.reasons,
      });
      // Mark concept rejected-by-guardrails
      await sbPatch('content_concepts', `id=eq.${conceptId}`, {
        status: 'rejected',
        rejection_reason: `Guardrails: ${guardResult.reasons.join('; ')}`,
        updated_at: new Date().toISOString(),
      }).catch((e) => logger?.warn('/wf1/engine', businessId, 'concept rejection patch failed', { error: e.message }));
      return { assetId: null, qualityScore: 0, blocked: true, reasons: guardResult.reasons };
    }

    // Map our DB-column concept to the foundation type shape
    const conceptBrief = {
      platform: concept.platform,
      format: concept.format,
      pillar: concept.pillar,
      funnelStage: concept.funnel_stage,
      emotion: concept.emotion,
      coreIdea: concept.core_idea,
      hook: concept.hook,
      storyArc: concept.story_arc || undefined,
      cta: concept.cta,
      framework: concept.framework,
      whyThisWhyNow: concept.why_this_why_now,
      predictedEngagementRange: [
        Number(concept.predicted_engagement_low || 0),
        Number(concept.predicted_engagement_high || 0),
      ],
      riskLevel: concept.risk_level || 'low',
      costEstimate: Number(concept.cost_estimate_usd || 0),
    };

    let { system, user } = buildPlatformGenerationPrompt(brandContextReady, conceptBrief);

    // ─── Closed-loop creative system grounding ────────────────────────
    // Prepend the business's own wins+losses+VoC+cohort+brand-voice to
    // the system prompt. The model writes from real signal, not a generic
    // template. Cached 5min so concepts in the same daily batch share work.
    // See ADR-0005 + CLAUDE.md Rule 6.
    let groundingSchedule = null;
    try {
      const surface = concept.platform === 'email' ? 'email' : 'social_post';
      const grounding = await _grounding.buildGroundingContext({
        sbGet,
        businessId,
        surface,
        intent: concept.funnel_stage === 'consideration' ? 'awareness' : 'conversion',
        limit: 3,
      });
      const block = grounding.toPromptBlock();
      groundingSchedule = grounding.postingSchedule;
      if (block) {
        system = `${block}\n${system}`;
      }
    } catch (e) {
      logger?.warn?.('/wf1/engine.grounding', businessId, 'grounding skipped', { error: e.message });
    }

    // If this concept came from an Agency-tier creative-director run, thread the
    // upstream visual/audio/camera direction into the Sonnet prompt so the
    // platform-native asset honours the strategic concept.
    if (concept.creative_concept_id) {
      const ccRows = await sbGet(
        'creative_concepts',
        `id=eq.${concept.creative_concept_id}&select=top_concept,insight,pattern,comparable_canon`
      ).catch(() => []);
      const cc = ccRows[0];
      const downstream = cc?.top_concept?.downstream_brief_for_higgsfield;
      if (downstream) {
        user = `${user}\n\n---\nUPSTREAM CREATIVE DIRECTION (lock the asset to this — do not invent contradictory visuals):\nInsight: ${cc.insight || ''}\nPattern: ${cc.pattern || ''} (${cc.comparable_canon || 'no canon match'})\nVisualization (subject the camera sees): ${downstream.subject || ''}\nAction (what happens): ${downstream.action || ''}\nLook (style + grade + lighting): ${downstream.look || ''}\nCamera (named preset): ${downstream.camera || ''}\nNative aspect: ${downstream.platform_native_aspect || ''}\n${downstream.audio_cue ? 'Audio cue: ' + downstream.audio_cue : ''}\n\nThe visual brief you generate must align with these directions. Caption + hook tone should reflect the insight.`;
      }
    }

    const defaultPostTime = groundingSchedule?.best_times?.length
      ? groundingSchedule.best_times[concept.id.charCodeAt(0) % groundingSchedule.best_times.length]
      : null;

    const raw = await callClaude(user, 'claude-sonnet-4-5', 3000, {
      system,
      businessId,
      returnRaw: true,
      skipGrounding: true,
    });
    const parsed = extractJSON(raw) || {};
    // Must come AFTER `parsed` is declared — referencing it earlier is a
    // temporal-dead-zone ReferenceError that crashed every asset generation.
    const postRationale =
      parsed.postingTime?.rationale ||
      (defaultPostTime ? `Industry benchmark best time (${defaultPostTime} local)` : null);

    // ─── Adversarial Critic on the caption ────────────────────────────
    // Captions are the highest-stakes text we ship — they're what users
    // actually read. Run the Critic loop with role='caption' (tuned to
    // social-media first-line discipline). Plan-gated:
    //   free   → skip (cost discipline)
    //   growth → critic body only
    //   agency → critic body + hook
    // Failures keep the original caption (fail-safe). See ADR-0005.
    try {
      const planRows = await sbGet('businesses', `id=eq.${businessId}&select=plan`).catch(() => []);
      const plan = (planRows[0]?.plan || 'free').toLowerCase();
      if ((plan === 'growth' || plan === 'agency') && parsed.caption) {
        const result = await _critic.reflexion({
          callClaude,
          draft: String(parsed.caption),
          role: 'caption',
          businessId,
          skill: 'wf1_caption_critic',
          criticModel: 'claude-haiku-4-5',
          rewriteModel: 'claude-sonnet-4-5',
          maxRewriteRounds: 1,
          rewriteMaxTokens: 600,
          metrics,
          logger,
        });
        if (result.improved && result.final) {
          parsed.caption = result.final;
          parsed._critic_severity = result.criticVerdict?.severity;
        }
      }
      if (plan === 'agency' && parsed.hook) {
        const result = await _critic.reflexion({
          callClaude,
          draft: String(parsed.hook),
          role: 'social_post',
          extraCriteria: 'Hook only — first 7 words must earn the rest of the caption.',
          businessId,
          skill: 'wf1_hook_critic',
          criticModel: 'claude-haiku-4-5',
          rewriteModel: 'claude-sonnet-4-5',
          maxRewriteRounds: 1,
          rewriteMaxTokens: 200,
          metrics,
          logger,
        });
        if (result.improved && result.final) {
          parsed.hook = result.final;
        }
      }
    } catch (e) {
      logger?.warn?.('/wf1/engine.critic', businessId, 'critic loop failed (kept original)', { error: e.message });
    }

    // Phase 4: quality gate — second Claude call (Haiku) to score the asset.
    const qualityResult = await scoreAsset({
      businessId,
      brandContext: brandContextReady,
      concept,
      asset: parsed,
    });

    // ─── Phase 4.5: render the visual via Higgsfield ───────────────────────
    // The visual_brief is the art-direction; Higgsfield turns it into a real
    // image OR video so the asset carries a media_url to publish. Higgsfield
    // is the ONLY provider — no Replicate, no Flux, no fallback. Behavior:
    //   • Reels / TikTok / Story / Shorts → generateVideo (9:16, 6s default)
    //   • Feeds / Facebook / LinkedIn / GBP → generateImage
    //   • Email concepts → skip (no visual asset needed)
    //   • Soul ID (businesses.higgsfield_soul_id) is attached when present so
    //     every generation carries a consistent brand identity.
    //   • Credit guard: if businesses.higgsfield_credits is known and <100,
    //     skip generation (low-balance email is sent by the daily cron).
    let mediaUrl = null;
    let imageModelUsed = null;
    let generationType = null;
    const visualPrompt = visualBriefToPrompt(parsed.visualBrief, concept);
    const platformLower = String(concept.platform || '').toLowerCase();
    const isVideoPlatform = VIDEO_PLATFORMS.has(platformLower);
    const isImagePlatform = !isVideoPlatform && platformLower !== 'email';

    const bizCfgRows = await sbGet(
      'businesses',
      `id=eq.${businessId}&select=higgsfield_soul_id,higgsfield_credits,product_image_urls,logo_url`
    ).catch(() => []);
    const bizCfg = bizCfgRows[0] || {};
    const soulId = bizCfg.higgsfield_soul_id || null;
    const credits = typeof bizCfg.higgsfield_credits === 'number' ? bizCfg.higgsfield_credits : null;
    const creditsBlocked = credits != null && credits < 100;

    // Customer-supplied product/shop photos → Higgsfield reference image, so
    // generated visuals riff on their REAL products instead of generic stock.
    // Rotate across the day's concepts (deterministic per-concept) for variety.
    const productImages = referenceImageList(bizCfg.product_image_urls);
    const referenceImageUrl = productImages.length
      ? productImages[rotationIndex(conceptId, productImages.length)]
      : null;

    // Logo is folded into the prompt as a brand-asset cue. NOTE: this is a
    // soft reference, NOT a pixel-accurate overlay — true logo placement needs
    // a compositing step (documented in migration 088).
    const logoUrl = bizCfg.logo_url || null;
    const promptWithBrand = logoUrl
      ? `${visualPrompt}. Tastefully incorporate the brand's logo/identity where natural.`
      : visualPrompt;

    if (creditsBlocked) {
      await sbPost('events', {
        business_id: businessId,
        kind: 'higgsfield.credits.low.blocked',
        workflow: '1_daily_content',
        payload: { concept_id: conceptId, credits, threshold: 100 },
        severity: 'warning',
      }).catch(() => {});
      logger?.warn?.('/wf1/engine.image', businessId, 'higgsfield generation blocked — low credits', {
        credits,
        threshold: 100,
      });
    } else if (higgsfield && visualPrompt) {
      if (isVideoPlatform && typeof higgsfield.generateVideo === 'function') {
        try {
          const vid = await higgsfield.generateVideo({
            prompt: promptWithBrand,
            aspect_ratio: '9:16',
            resolution: '720p',
            durationSeconds: 6,
            model: videoModelForConcept(concept),
            soul_id: soulId,
            sourceImageUrl: referenceImageUrl || undefined,
            businessId,
          });
          mediaUrl = vid?.url || vid?.videoUrl || null;
          imageModelUsed = vid?.model_used || vid?.model_slug || null;
          if (mediaUrl) generationType = 'video';
        } catch (e) {
          logger?.error?.('/wf1/engine.video', businessId, 'higgsfield video generation failed', {
            conceptId,
            error: e.message,
          });
        }
      } else if (isImagePlatform && typeof higgsfield.generateImage === 'function') {
        try {
          const img = await higgsfield.generateImage({
            prompt: promptWithBrand,
            aspect_ratio: aspectRatioForPlatform(concept.platform),
            soul_id: soulId,
            image_url: referenceImageUrl || undefined,
            businessId,
          });
          mediaUrl = img?.url || img?.imageUrl || null;
          imageModelUsed = img?.model_used || img?.model_slug || null;
          if (mediaUrl) generationType = 'image';
          // Pixel-accurate logo placement: overlay the logo PNG onto the
          // finished image (Higgsfield's reference is only a style hint).
          // Soft-fails to the un-overlaid image. Image-only. Runs before the
          // generation-history mirror so the recorded media_url is the final
          // (composited) URL.
          if (mediaUrl && logoUrl && typeof higgsfield.applyLogoOverlay === 'function') {
            mediaUrl = await higgsfield.applyLogoOverlay({ imageUrl: mediaUrl, logoUrl, businessId });
          }
        } catch (e) {
          logger?.error?.('/wf1/engine.image', businessId, 'higgsfield image generation failed', {
            conceptId,
            error: e.message,
          });
        }
      }
    }

    // ─── Generation-history mirror (migration 087) ─────────────────────────
    // Record every successful Higgsfield generation so cost attribution +
    // analytics have a per-asset ledger independent of content_assets. This
    // is a pure internal write on a call we already made — no external API.
    // Soft-fails: a mirror miss must never sink the content pipeline.
    if (mediaUrl && generationType) {
      await sbPost('higgsfield_generations', {
        business_id: businessId,
        job_id: null,
        model: imageModelUsed || null,
        prompt: visualPrompt ? visualPrompt.slice(0, 2000) : null,
        media_url: mediaUrl,
        generation_type: generationType,
        cost_credits: null,
      }).catch((e) =>
        logger?.warn?.('/wf1/engine', businessId, 'higgsfield_generations mirror failed', {
          conceptId,
          error: e.message,
        })
      );
    }

    const assetRow = await sbPost('content_assets', {
      business_id: businessId,
      concept_id: conceptId,
      platform: concept.platform,
      caption: parsed.caption || '',
      hook: parsed.hook || concept.hook,
      hook_pattern: parsed.hookPattern || null,
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
      cta: parsed.cta || concept.cta,
      visual_brief: parsed.visualBrief || null,
      media_url: mediaUrl,
      accessibility_alt_text: parsed.accessibilityAltText || null,
      burned_in_captions: parsed.burnedInCaptions || null,
      posting_time_local: parsed.postingTime?.localTime || defaultPostTime || null,
      posting_time_rationale: postRationale,
      framework_justification: parsed.frameworkJustification || null,
      predicted_quality_score: Number(parsed.predictedQualityScore || 0),
      confidence: Number(parsed.confidence || 0),
      quality_score: qualityResult.score,
      quality_breakdown: qualityResult.breakdown,
      model_used: imageModelUsed ? `claude-sonnet-4-5+${imageModelUsed}` : 'claude-sonnet-4-5',
      status: qualityResult.score >= 80 ? 'awaiting_approval' : 'generated',
    });

    // ─── Virality prediction (migration 089 content_virality_predictions) ──
    // Internal Claude-based predictor (lib/viralityPredictor) — scores the
    // finished asset for predicted organic performance and records a row in
    // content_virality_predictions keyed to the asset. NOTE: this used to
    // write `content_performance`, but that name collides with migration 024's
    // post-publish measurement table (post_id/asset_id NOT NULL), so every
    // insert silently failed. Migration 089 gives predictions their own table.
    // Soft-fails: a prediction miss returns a neutral band and never blocks.
    try {
      const prediction = await _virality.predictVirality({
        content: {
          platform: concept.platform,
          hook: parsed.hook || concept.hook,
          caption: parsed.caption || '',
          media_url: mediaUrl,
          format: concept.format,
        },
        deps: { callClaude, extractJSON, logger },
        businessId,
      });
      await sbPost('content_virality_predictions', {
        business_id: businessId,
        content_id: assetRow.id,
        virality_score: prediction.virality_score,
        predicted_engagement: prediction.predicted_engagement,
        hook_strength: prediction.hook_strength,
        retention_risk: prediction.retention_risk,
        raw: prediction.raw,
      }).catch((e) =>
        logger?.warn?.('/wf1/engine', businessId, 'content_virality_predictions insert failed', {
          conceptId,
          error: e.message,
        })
      );
    } catch (e) {
      logger?.warn?.('/wf1/engine', businessId, 'virality prediction failed', { conceptId, error: e.message });
    }

    // Update concept with latest quality score
    await sbPatch('content_concepts', `id=eq.${conceptId}`, {
      quality_score: qualityResult.score,
      quality_breakdown: qualityResult.breakdown,
      updated_at: new Date().toISOString(),
    }).catch((e) => logger?.warn('/wf1/engine', businessId, 'concept quality patch failed', { error: e.message }));

    // Log event
    await sbPost('events', {
      business_id: businessId,
      kind: 'wf1.asset.generated',
      workflow: '1_daily_content',
      payload: {
        concept_id: conceptId,
        asset_id: assetRow.id,
        quality_score: qualityResult.score,
        platform: concept.platform,
      },
      severity: 'info',
    }).catch(() => {});

    return {
      assetId: assetRow.id,
      qualityScore: qualityResult.score,
      asset: assetRow,
    };
  }

  // ── Phase 4: quality score via Haiku ──────────────────────────────────

  /**
   * Pre-screening checks that run BEFORE the Haiku call.
   * Fast-fail on obvious violations to save API cost and latency.
   */
  function preScreenAsset({ brandContext, concept, asset }) {
    const flags = [];

    // ── Banned word check ──
    const bannedWords = [...(brandContext.brandVoice?.bannedWords || []), ...(brandContext.bannedWords || [])]
      .map((w) => w.toLowerCase().trim())
      .filter(Boolean);

    if (bannedWords.length) {
      const textToScan = [asset.caption || '', asset.hook || '', asset.cta || '', ...(asset.hashtags || [])]
        .join(' ')
        .toLowerCase();

      for (const word of bannedWords) {
        if (textToScan.includes(word)) {
          flags.push({ type: 'banned_word', severity: 'auto_fail', detail: `Banned word violation: "${word}"` });
        }
      }
    }

    // ── Platform-native check ──
    const videoFormats = ['instagram_reel', 'tiktok', 'youtube_shorts'];
    if (videoFormats.includes(concept.platform)) {
      const hasMotionBrief = asset.visualBrief?.shots?.length > 1 || asset.burnedInCaptions;
      if (!hasMotionBrief) {
        flags.push({
          type: 'platform_native',
          severity: 'warning',
          detail: `${concept.platform} expects video/motion brief but asset has no multi-shot or burned-in captions`,
        });
      }
    }

    return flags;
  }

  async function scoreAsset({ businessId, brandContext, concept, asset }) {
    // ── Pre-screening: fast-fail on banned words ──
    const preFlags = preScreenAsset({ brandContext, concept, asset });
    const autoFailFlags = preFlags.filter((f) => f.severity === 'auto_fail');

    if (autoFailFlags.length) {
      logger?.info('/wf1/engine', businessId, 'asset auto-failed pre-screening', {
        flags: autoFailFlags.map((f) => f.detail),
      });
      return {
        score: 0,
        breakdown: { compliance: 0 },
        verdict: 'fail',
        notes: autoFailFlags.map((f) => f.detail).join('; '),
        preScreenFlags: preFlags,
      };
    }

    // ── Build pre-screening context for Haiku ──
    const warningFlags = preFlags.filter((f) => f.severity === 'warning');
    const preScreenContext = warningFlags.length
      ? `\nPRE-SCREENING WARNINGS (factor these into your score):\n${warningFlags.map((f) => `  ⚠ ${f.detail}`).join('\n')}\n`
      : '';

    const prompt = `You are the quality gate for a senior-agency content pipeline.
Score this generated asset against the 6 dimensions of the spec.

BRAND
  Name: ${brandContext.businessName}
  Industry: ${brandContext.industry}
  Tone: ${brandContext.brandVoice?.tone || 'unknown'}
  Banned words: ${[...(brandContext.brandVoice?.bannedWords || []), ...(brandContext.bannedWords || [])].join(', ') || 'none'}

CONCEPT
  Platform: ${concept.platform}
  Pillar: ${concept.pillar}
  Core idea: ${concept.core_idea}
  Strategist hook direction: ${concept.hook}
  Psychology framework: ${concept.framework}

ASSET
  Caption: ${asset.caption || ''}
  Hook: ${asset.hook || ''}
  Hook pattern: ${asset.hookPattern || ''}
  Hashtags: ${(asset.hashtags || []).join(' ')}
  CTA: ${asset.cta || ''}
  Visual brief: ${JSON.stringify(asset.visualBrief || {}).slice(0, 400)}
${preScreenContext}
SCORING RUBRIC (total 100)
  brand_voice_match     (0-20)
  hook_strength         (0-20)
  visual_brief_quality  (0-20)
  pattern_freshness     (0-15)
  prediction_confidence (0-15)
  compliance            (0-10)

Compliance rules (auto-fail if any violated):
  - No banned words (check against the banned words list above)
  - No copyright claims ("best", "#1", "award-winning") without proof
  - No medical/financial claims
  - Caption length appropriate for platform
  - For video platforms (reels/tiktok/shorts): visual brief must include multi-shot motion description

If any compliance rule fails, set total_score to max(0, score - 30).

Return ONLY valid JSON:
{
  "total_score": 0-100,
  "breakdown": {
    "brand_voice_match": number,
    "hook_strength": number,
    "visual_brief_quality": number,
    "pattern_freshness": number,
    "prediction_confidence": number,
    "compliance": number
  },
  "verdict": "pass" | "fail",
  "notes": "1-2 sentences explaining the score"
}`;

    try {
      const raw = await callClaude(prompt, 'claude-haiku-4-5', 800, {
        businessId,
        returnRaw: true,
        skipBudget: false,
      });
      const parsed = extractJSON(raw) || {};
      const score = Number(parsed.total_score || 0);
      return {
        score,
        breakdown: parsed.breakdown || {},
        verdict: parsed.verdict || (score >= 80 ? 'pass' : 'fail'),
        notes: parsed.notes || '',
        preScreenFlags: preFlags,
      };
    } catch (e) {
      logger?.warn('/wf1/engine', businessId, 'quality score failed, defaulting to 70', { error: e.message });
      return { score: 70, breakdown: {}, verdict: 'pass', notes: 'scoring failed — defaulted' };
    }
  }

  return {
    resolveBrandContext,
    resolveLocalDate,
    getAutonomyMode,
    runStrategicDecision,
    generateAssetForConcept,
    scoreAsset,
  };
}

module.exports = createEngine;
