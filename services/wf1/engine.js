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
}) {
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
    const profileRows = await sbGet(
      'business_profiles',
      `user_id=eq.${businessId}&select=timezone,country`
    ).catch(() => []);
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
      const concepts = await sbGet(
        'content_concepts',
        `plan_id=eq.${existing[0].id}&select=*`
      ).catch(() => []);
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

    const { system, user } = buildStrategicDecisionPrompt(brandContext, bundle);

    // Claude Opus call. We pass the system prompt via `extra.system` so
    // callClaude preserves it. Expected ~3000 tokens out.
    const startedAt = Date.now();
    const raw = await callClaude(user, 'claude-opus-4-5', 3500, {
      system,
      businessId,
      returnRaw: true,
    });
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
      model_used: 'claude-opus-4-5',
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
      }).catch(e => {
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
      }).catch(() => {});
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

    const { system, user } = buildPlatformGenerationPrompt(brandContextReady, conceptBrief);
    const raw = await callClaude(user, 'claude-sonnet-4-5', 3000, {
      system,
      businessId,
      returnRaw: true,
    });
    const parsed = extractJSON(raw) || {};

    // Phase 4: quality gate — second Claude call (Haiku) to score the asset.
    const qualityResult = await scoreAsset({
      businessId,
      brandContext: brandContextReady,
      concept,
      asset: parsed,
    });

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
      accessibility_alt_text: parsed.accessibilityAltText || null,
      burned_in_captions: parsed.burnedInCaptions || null,
      posting_time_local: parsed.postingTime?.localTime || null,
      posting_time_rationale: parsed.postingTime?.rationale || null,
      framework_justification: parsed.frameworkJustification || null,
      predicted_quality_score: Number(parsed.predictedQualityScore || 0),
      confidence: Number(parsed.confidence || 0),
      quality_score: qualityResult.score,
      quality_breakdown: qualityResult.breakdown,
      model_used: 'claude-sonnet-4-5',
      status: qualityResult.score >= 80 ? 'awaiting_approval' : 'generated',
    });

    // Update concept with latest quality score
    await sbPatch('content_concepts', `id=eq.${conceptId}`, {
      quality_score: qualityResult.score,
      quality_breakdown: qualityResult.breakdown,
      updated_at: new Date().toISOString(),
    }).catch(() => {});

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
    const bannedWords = [
      ...(brandContext.brandVoice?.bannedWords || []),
      ...(brandContext.bannedWords || []),
    ].map(w => w.toLowerCase().trim()).filter(Boolean);

    if (bannedWords.length) {
      const textToScan = [
        asset.caption || '',
        asset.hook || '',
        asset.cta || '',
        ...(asset.hashtags || []),
      ].join(' ').toLowerCase();

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
        flags.push({ type: 'platform_native', severity: 'warning', detail: `${concept.platform} expects video/motion brief but asset has no multi-shot or burned-in captions` });
      }
    }

    return flags;
  }

  async function scoreAsset({ businessId, brandContext, concept, asset }) {
    // ── Pre-screening: fast-fail on banned words ──
    const preFlags = preScreenAsset({ brandContext, concept, asset });
    const autoFailFlags = preFlags.filter(f => f.severity === 'auto_fail');

    if (autoFailFlags.length) {
      logger?.info('/wf1/engine', businessId, 'asset auto-failed pre-screening', {
        flags: autoFailFlags.map(f => f.detail),
      });
      return {
        score: 0,
        breakdown: { compliance: 0 },
        verdict: 'fail',
        notes: autoFailFlags.map(f => f.detail).join('; '),
        preScreenFlags: preFlags,
      };
    }

    // ── Build pre-screening context for Haiku ──
    const warningFlags = preFlags.filter(f => f.severity === 'warning');
    const preScreenContext = warningFlags.length
      ? `\nPRE-SCREENING WARNINGS (factor these into your score):\n${warningFlags.map(f => `  ⚠ ${f.detail}`).join('\n')}\n`
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
