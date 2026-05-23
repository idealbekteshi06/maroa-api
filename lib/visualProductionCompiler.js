'use strict';

/**
 * lib/visualProductionCompiler.js
 * ───────────────────────────────────────────────────────────────────────
 * The Visual Production Compiler (ADR-0012).
 *
 * Turns a marketing intent + brand DNA + channel + audience + objective
 * into a deterministic Higgsfield JobSpec — a structured production
 * brief that Higgsfield can execute, with:
 *
 *   - the right model selection (Soul ID for character consistency,
 *     Seedance for image-to-video, Cinema Studio for shot lists, etc.)
 *   - brand visual DNA references (Soul ID character + brand palette +
 *     style anchors), pulled from the Marketing Graph + cached aggressively
 *   - shot list with camera, framing, motion, pacing
 *   - platform-correct aspect ratio + duration + captions
 *   - QA checklist (brand consistency, channel compliance, claim
 *     substantiation)
 *   - fallback model on primary failure
 *
 * The slogan: "Higgsfield is the engine. Maroa is the director."
 *
 * Public API:
 *
 *   const c = makeVisualProductionCompiler({
 *     marketingGraph,    // lib/marketingGraph.js
 *     decisionLog,       // lib/decisionLog.js
 *     channels,          // services/prompts/channels registry
 *     compliance,        // services/prompts/compliance registry
 *     logger, metrics,
 *   });
 *
 *   const jobSpec = await c.compileVisualBrief({
 *     businessId,
 *     workspaceId?,
 *     intent: 'meta_ad_video' | 'instagram_reel' | 'product_photo' | 'ugc_ad_video' | 'motion_graphic',
 *     channel: 'meta-ads-video',
 *     industry: 'cafe',
 *     audience: { age:[25,45], interests:['coffee','specialty'] },
 *     offer?,
 *     hookType?,          // optional override for Creative Genome's hook_type
 *     productImageUrl?,
 *     brandVisualDnaId?,  // optional override of cached DNA
 *     priority?: 'cost' | 'quality',  // routes to cheaper vs flagship models
 *   });
 *   → {
 *       jobSpec: { model, model_path, prompt, negative_prompt, image_inputs,
 *                  aspect_ratio, duration_sec, seed?, soul_id?, … },
 *       brief: { hook, shot_list:[{description, camera, motion, duration_sec}],
 *                visual_style, brand_consistency_notes, … },
 *       qa_checklist: [{ check, passed, notes }, …],
 *       fallback: { model_path, reason },
 *       brand_visual_dna_id?: uuid,
 *       reasoning_trace: [step1, step2, …]
 *     }
 *
 *   await c.cacheBrandVisualDna({ businessId, soulId, soulIdMeta, palette,
 *                                  styleAnchors, charactersTraining })
 *     → marketing_graph_entities row (entity_type=brand_visual_dna)
 *
 *   await c.getBrandVisualDna(businessId)
 *     → entity row or null
 *
 * Cost-conscious by design:
 *   - Soul ID training costs $$. We cache it as a Marketing Graph entity
 *     (entity_type='brand_visual_dna') and re-use it across every
 *     subsequent creative until the business's brand assets change.
 *   - Model routing prefers cheaper models (Nano Banana 2, Seedance) by
 *     default; opt into flagship (Cinema Studio, Veo) with priority:'quality'.
 *   - Every compilation emits a decision_logs row with cost estimate +
 *     manipulation_risk so the operator sees the spend in the War Room UI.
 *
 * Fail-safe: compilation itself never throws on bad input — returns a
 * jobSpec with `_soft: true` + reason. Higgsfield call sites can detect
 * + fall back.
 */

// ── Model routing table ───────────────────────────────────────────────────
// Each entry: { intent → preferred + fallback + cost_estimate_usd }.
// Models pulled from services/higgsfield.js path constants (verified
// against Higgsfield 2026 model lineup).
const MODEL_ROUTING = Object.freeze({
  meta_ad_image: {
    quality: {
      primary: { name: 'Seedream', path: '/bytedance/seedream/v4/text-to-image', cost: 0.04 },
      fallback: { name: 'Nano Banana Pro', path: '/higgsfield-ai/nano-banana-pro', cost: 0.02 },
    },
    cost: {
      primary: { name: 'Nano Banana', path: '/higgsfield-ai/nano-banana-2', cost: 0.012 },
      fallback: { name: 'Seedream', path: '/bytedance/seedream/v4/text-to-image', cost: 0.04 },
    },
  },
  meta_ad_video: {
    quality: {
      primary: { name: 'Veo', path: '/google/veo/v3-1', cost: 0.4 },
      fallback: { name: 'Kling v3', path: '/higgsfield-ai/kling/v3', cost: 0.25 },
    },
    cost: {
      primary: { name: 'Seedance', path: '/bytedance/seedance/v1/pro/image-to-video', cost: 0.18 },
      fallback: { name: 'Kling Image v3', path: '/higgsfield-ai/kling-image/v3', cost: 0.12 },
    },
  },
  instagram_reel: {
    quality: {
      primary: { name: 'Cinema Studio 3.5', path: '/higgsfield-ai/cinema-studio/v3-5', cost: 0.35 },
      fallback: { name: 'Kling v3', path: '/higgsfield-ai/kling/v3', cost: 0.25 },
    },
    cost: {
      primary: { name: 'Seedance', path: '/bytedance/seedance/v1/pro/image-to-video', cost: 0.18 },
      fallback: { name: 'Wan v2.7', path: '/higgsfield-ai/wan/v2-7', cost: 0.15 },
    },
  },
  tiktok_video: {
    quality: {
      primary: { name: 'Cinema Studio 3.5', path: '/higgsfield-ai/cinema-studio/v3-5', cost: 0.35 },
      fallback: { name: 'Kling v3', path: '/higgsfield-ai/kling/v3', cost: 0.25 },
    },
    cost: {
      primary: { name: 'Seedance', path: '/bytedance/seedance/v1/pro/image-to-video', cost: 0.18 },
      fallback: { name: 'Wan v2.7', path: '/higgsfield-ai/wan/v2-7', cost: 0.15 },
    },
  },
  product_photo: {
    quality: {
      primary: { name: 'Seedream Edit', path: '/bytedance/seedream/v4/edit', cost: 0.05 },
      fallback: { name: 'Flux Kontext', path: '/black-forest-labs/flux-kontext', cost: 0.04 },
    },
    cost: {
      primary: { name: 'Nano Banana Pro', path: '/higgsfield-ai/nano-banana-pro', cost: 0.02 },
      fallback: { name: 'Nano Banana 2', path: '/higgsfield-ai/nano-banana-2', cost: 0.012 },
    },
  },
  ugc_ad_video: {
    quality: {
      primary: { name: 'Cinema Studio 3.5', path: '/higgsfield-ai/cinema-studio/v3-5', cost: 0.35 },
      fallback: { name: 'Sora', path: '/higgsfield-ai/sora/standard', cost: 0.5 },
    },
    cost: {
      primary: { name: 'DOP Turbo', path: '/higgsfield-ai/dop/turbo', cost: 0.2 },
      fallback: { name: 'Seedance', path: '/bytedance/seedance/v1/pro/image-to-video', cost: 0.18 },
    },
  },
  motion_graphic: {
    quality: {
      primary: { name: 'Vibe Motion', path: '/higgsfield-ai/vibe-motion/standard', cost: 0.1 },
      fallback: { name: 'Cinema Studio 3.5', path: '/higgsfield-ai/cinema-studio/v3-5', cost: 0.35 },
    },
    cost: {
      primary: { name: 'Vibe Motion', path: '/higgsfield-ai/vibe-motion/standard', cost: 0.1 },
      fallback: { name: 'Nano Banana Pro', path: '/higgsfield-ai/nano-banana-pro', cost: 0.02 },
    },
  },
});

// ── Platform format defaults ──────────────────────────────────────────────
const PLATFORM_FORMAT = Object.freeze({
  'meta-ads-image': { aspect_ratio: '4:5', duration_sec: null, max_text_overlay_pct: 20 },
  'meta-ads-video': { aspect_ratio: '9:16', duration_sec: 15, captions: 'required' },
  'instagram-post': { aspect_ratio: '4:5', duration_sec: null },
  'instagram-reels': { aspect_ratio: '9:16', duration_sec: 21, captions: 'required' },
  'instagram-stories': { aspect_ratio: '9:16', duration_sec: 7 },
  tiktok: { aspect_ratio: '9:16', duration_sec: 24, captions: 'required' },
  'tiktok-ads': { aspect_ratio: '9:16', duration_sec: 15, captions: 'required' },
  'youtube-shorts': { aspect_ratio: '9:16', duration_sec: 36, captions: 'required' },
  'youtube-long': { aspect_ratio: '16:9', duration_sec: 720 },
  'linkedin-post': { aspect_ratio: '1:1', duration_sec: null },
  'pinterest-pin': { aspect_ratio: '2:3', duration_sec: null },
});

// ── Hook → camera/motion mapping (Creative Genome) ────────────────────────
const HOOK_DIRECTING = Object.freeze({
  pattern_interrupt: { opener: 'Sudden close-up or unexpected angle', motion: 'whip-pan or fast zoom on frame 1' },
  curiosity: { opener: 'Half-revealed visual + bold text overlay', motion: 'slow push-in' },
  social_proof: { opener: 'Real-person testimonial close-up', motion: 'static, eyeline to camera' },
  fear_relief: { opener: 'Problem shown plainly in first frame', motion: 'cut to relief moment' },
  authority: { opener: 'Confident speaker mid-statement', motion: 'subtle dolly-in' },
  aspiration: { opener: 'End-state result, beautifully lit', motion: 'orbit or slow reveal' },
  scarcity: { opener: 'Timer overlay + product hero', motion: 'subtle ticking energy' },
  reciprocity: { opener: 'Person handing/offering thing to viewer', motion: 'POV first-person' },
});

const VALID_INTENTS = Object.freeze(Object.keys(MODEL_ROUTING));

function makeVisualProductionCompiler(deps = {}) {
  const { marketingGraph, decisionLog, channels, compliance, logger, metrics } = deps;

  if (!marketingGraph || typeof marketingGraph.upsertEntity !== 'function') {
    throw new Error('visualProductionCompiler: marketingGraph dep required (lib/marketingGraph)');
  }

  function _bump(name, labels) {
    if (metrics?.increment) {
      try {
        metrics.increment(name, labels);
      } catch {
        /* best effort */
      }
    }
  }

  function _logWarn(op, err) {
    if (logger?.warn) logger.warn('visualProductionCompiler', null, op, { err: err.message || String(err) });
  }

  // ── Brand Visual DNA ────────────────────────────────────────────────────

  async function getBrandVisualDna(businessId) {
    if (!businessId) return null;
    try {
      const rows = await marketingGraph.getEntitiesByType({
        businessId,
        type: 'brand_visual_dna',
        status: 'active',
        limit: 1,
      });
      return rows[0] || null;
    } catch (e) {
      _logWarn('getBrandVisualDna', e);
      return null;
    }
  }

  async function cacheBrandVisualDna({
    businessId,
    soulId,
    soulIdMeta,
    palette,
    styleAnchors,
    charactersTraining,
    sourceAssets,
  }) {
    if (!businessId) throw new Error('cacheBrandVisualDna: businessId required');
    if (!soulId && !palette && !styleAnchors) {
      throw new Error('cacheBrandVisualDna: provide at least one of soulId/palette/styleAnchors');
    }

    const attrs = {
      soul_id: soulId || null,
      soul_id_meta: soulIdMeta || null,
      palette: palette || null,
      style_anchors: styleAnchors || null,
      characters_training: charactersTraining || null,
      source_assets: sourceAssets || null,
      cached_at: new Date().toISOString(),
    };

    // Upsert via externalId='brand_visual_dna' so subsequent calls update
    // the same row rather than creating duplicates.
    const entity = await marketingGraph.upsertEntity({
      businessId,
      type: 'brand_visual_dna',
      title: `Brand Visual DNA — business ${businessId}`,
      attrs,
      externalId: `brand_visual_dna:${businessId}`,
      source: 'visualProductionCompiler.cacheBrandVisualDna',
    });
    _bump('visual_production_brand_dna_cached_total');
    return entity;
  }

  // ── Compilation ─────────────────────────────────────────────────────────

  function _pickModel(intent, priority = 'quality') {
    const r = MODEL_ROUTING[intent];
    if (!r) return null;
    const bucket = r[priority] || r.quality;
    return { primary: bucket.primary, fallback: bucket.fallback };
  }

  function _platformFormatFor(channel, intent) {
    if (channel && PLATFORM_FORMAT[channel]) return PLATFORM_FORMAT[channel];
    // Sensible defaults by intent
    if (intent && intent.includes('video')) return { aspect_ratio: '9:16', duration_sec: 21 };
    if (intent && intent.includes('reel')) return { aspect_ratio: '9:16', duration_sec: 21 };
    return { aspect_ratio: '4:5', duration_sec: null };
  }

  function _buildHookOpener(hookType) {
    return HOOK_DIRECTING[hookType] || HOOK_DIRECTING.curiosity;
  }

  function _buildShotList({ intent, format, hookDirecting }) {
    if (!format.duration_sec) {
      return [
        {
          description: 'Single hero frame — product centered, brand-consistent lighting',
          camera: 'medium-close',
          motion: 'static',
          duration_sec: null,
        },
      ];
    }
    const total = format.duration_sec;
    // Three-beat structure for short-form video: hook → demonstration → CTA
    if (total <= 30) {
      return [
        {
          description: `Hook (${hookDirecting.opener})`,
          camera: 'close-up',
          motion: hookDirecting.motion,
          duration_sec: Math.min(3, total),
        },
        {
          description: 'Demonstration — product in use with on-screen benefit text',
          camera: 'medium',
          motion: 'subtle push-in',
          duration_sec: Math.max(7, total - 6),
        },
        {
          description: 'CTA — clear single action, product hero, brand logo subtle',
          camera: 'medium-close',
          motion: 'static or slow zoom',
          duration_sec: 3,
        },
      ];
    }
    // Longer: hook + 3 beats + CTA
    return [
      {
        description: `Hook (${hookDirecting.opener})`,
        camera: 'close-up',
        motion: hookDirecting.motion,
        duration_sec: 3,
      },
      {
        description: 'Beat 1 — problem framing',
        camera: 'medium',
        motion: 'static',
        duration_sec: Math.floor((total - 6) / 3),
      },
      {
        description: 'Beat 2 — solution reveal',
        camera: 'medium-close',
        motion: 'reveal/orbit',
        duration_sec: Math.floor((total - 6) / 3),
      },
      {
        description: 'Beat 3 — proof / benefit on screen',
        camera: 'medium',
        motion: 'subtle motion',
        duration_sec: Math.floor((total - 6) / 3),
      },
      { description: 'CTA', camera: 'medium-close', motion: 'static', duration_sec: 3 },
    ];
  }

  function _buildPromptFromBrief({ industry, intent, hookType, offer, audience, brandDna, hookDirecting }) {
    const lines = [];
    lines.push(`Subject: ${industry || 'small business'} marketing creative.`);
    lines.push(`Intent: ${intent}.`);
    if (hookDirecting) {
      lines.push(`Opening: ${hookDirecting.opener}.`);
      lines.push(`Motion: ${hookDirecting.motion}.`);
    }
    if (offer)
      lines.push(`Offer to highlight: ${typeof offer === 'string' ? offer : offer.name || offer.description || ''}.`);
    if (audience?.interests) lines.push(`Audience signals: ${audience.interests.slice(0, 4).join(', ')}.`);
    if (brandDna?.attrs?.style_anchors) {
      const sa = brandDna.attrs.style_anchors;
      if (Array.isArray(sa)) lines.push(`Brand style anchors: ${sa.slice(0, 4).join(', ')}.`);
      else if (typeof sa === 'string') lines.push(`Brand style: ${sa}.`);
    }
    if (brandDna?.attrs?.palette) {
      const palette = brandDna.attrs.palette;
      if (Array.isArray(palette)) lines.push(`Brand palette: ${palette.slice(0, 5).join(', ')}.`);
    }
    lines.push('Composition: clean, scroll-stopping, premium-feeling.');
    lines.push(`Hook type: ${hookType || 'curiosity'}.`);
    return lines.join(' ');
  }

  function _buildNegativePrompt() {
    return (
      'low quality, distorted faces, mangled hands, blurry, watermark, ' +
      'stock-photo feel, busy background, text artifacts, oversaturated, ' +
      'cliché AI aesthetic, plastic skin, deformed product, double exposure'
    );
  }

  function _buildQaChecklist({ channel, industry, hookType, format }) {
    const checks = [];
    checks.push({ check: 'Aspect ratio matches platform', expected: format.aspect_ratio, passed: null });
    if (format.duration_sec)
      checks.push({ check: 'Duration within window', expected: `${format.duration_sec}s`, passed: null });
    if (format.captions === 'required') checks.push({ check: 'Captions burned in', passed: null });
    checks.push({ check: 'Brand visual consistency vs cached DNA', passed: null });
    checks.push({ check: 'No personal-attribute claims', passed: null });
    checks.push({ check: 'No AI-tell phrasing (e.g. "unleash the power of")', passed: null });
    checks.push({ check: 'Hook visible in first 1-2 seconds', passed: null });
    if (industry) {
      // Compliance gates per industry (services/prompts/compliance)
      checks.push({
        check: `Industry compliance — ${industry}`,
        regulator: 'see services/prompts/compliance',
        passed: null,
      });
    }
    if (hookType === 'scarcity') checks.push({ check: 'Real deadline (not vague urgency)', passed: null });
    if (channel === 'meta-ads-image' || channel === 'meta-ads-video') {
      checks.push({ check: 'No banned Meta personal-attribute language', passed: null });
    }
    return checks;
  }

  function _checkComplianceUpfront({ industry, draftDescription }) {
    if (!industry || !compliance || typeof compliance.applyCompliance !== 'function') {
      return { ok: true, violations: [], rulesets_applied: [] };
    }
    try {
      return compliance.applyCompliance({
        draft: String(draftDescription || ''),
        industry,
      });
    } catch (e) {
      _logWarn('compliance check', e);
      return { ok: true, violations: [], rulesets_applied: [], _soft: true };
    }
  }

  async function compileVisualBrief(args = {}) {
    const trace = [];
    const log = (m) => trace.push(m);

    try {
      const {
        businessId,
        workspaceId,
        intent,
        channel,
        industry,
        audience,
        offer,
        hookType,
        productImageUrl,
        brandVisualDnaId,
        priority = 'quality',
        seed,
      } = args;

      if (!businessId || !intent) {
        return {
          _soft: true,
          reason: 'businessId + intent required',
          jobSpec: null,
        };
      }
      if (!VALID_INTENTS.includes(intent)) {
        return {
          _soft: true,
          reason: `intent must be one of ${VALID_INTENTS.join(',')}`,
          jobSpec: null,
        };
      }

      // 1. Pick model (with fallback)
      const modelChoice = _pickModel(intent, priority);
      if (!modelChoice) {
        return { _soft: true, reason: `no model routing for intent=${intent}`, jobSpec: null };
      }
      log(`model: ${modelChoice.primary.name} (fallback: ${modelChoice.fallback.name})`);

      // 2. Resolve brand visual DNA
      let brandDna = null;
      if (brandVisualDnaId) {
        try {
          const rows = await marketingGraph.getEntitiesByType({
            businessId,
            type: 'brand_visual_dna',
            limit: 50,
          });
          brandDna = rows.find((r) => r.id === brandVisualDnaId) || null;
        } catch (e) {
          _logWarn('lookup dna by id', e);
        }
      }
      if (!brandDna) {
        brandDna = await getBrandVisualDna(businessId);
      }
      if (brandDna) {
        log(`brand DNA loaded (soul_id=${brandDna.attrs?.soul_id ? 'yes' : 'no'})`);
      } else {
        log('no brand DNA cached — generation will be brand-neutral');
      }

      // 3. Format + hook directing
      const format = _platformFormatFor(channel, intent);
      const hookDirecting = _buildHookOpener(hookType);
      log(`format: ${format.aspect_ratio} ${format.duration_sec ? format.duration_sec + 's' : 'image'}`);

      // 4. Shot list
      const shotList = _buildShotList({ intent, format, hookDirecting });
      log(`shot list: ${shotList.length} shots`);

      // 5. Prompt + negative prompt
      const prompt = _buildPromptFromBrief({
        industry,
        intent,
        hookType,
        offer,
        audience,
        brandDna,
        hookDirecting,
      });
      const negativePrompt = _buildNegativePrompt();

      // 6. Compliance pre-check (early refusal if industry has hard refusals)
      const complianceResult = _checkComplianceUpfront({ industry, draftDescription: prompt });
      if (!complianceResult.ok) {
        log(`compliance pre-check BLOCKED: ${(complianceResult.violations[0] || {}).issue || 'unspecified'}`);
        return {
          _soft: true,
          reason: 'compliance_block',
          violations: complianceResult.violations,
          rulesets_applied: complianceResult.rulesets_applied,
          jobSpec: null,
          reasoning_trace: trace,
        };
      }
      if (complianceResult.rulesets_applied?.length) {
        log(`compliance rulesets active: ${complianceResult.rulesets_applied.join(',')}`);
      }

      // 7. QA checklist
      const qaChecklist = _buildQaChecklist({ channel, industry, hookType, format });

      // 8. JobSpec — the canonical structure the Higgsfield service consumes
      const jobSpec = {
        intent,
        model: modelChoice.primary.name,
        model_path: modelChoice.primary.path,
        prompt,
        negative_prompt: negativePrompt,
        aspect_ratio: format.aspect_ratio,
        duration_sec: format.duration_sec,
        seed: typeof seed === 'number' ? seed : null,
        image_inputs: productImageUrl ? [productImageUrl] : [],
        soul_id: brandDna?.attrs?.soul_id || null,
        captions_required: format.captions === 'required',
        max_text_overlay_pct: format.max_text_overlay_pct || null,
        cost_estimate_usd: modelChoice.primary.cost,
        priority,
      };

      const brief = {
        hook: hookDirecting,
        shot_list: shotList,
        visual_style: brandDna?.attrs?.style_anchors || 'clean, premium, brand-consistent',
        brand_consistency_notes: brandDna
          ? `Use cached brand DNA (soul_id=${brandDna.attrs?.soul_id ? 'set' : 'none'}, palette=${Array.isArray(brandDna.attrs?.palette) ? brandDna.attrs.palette.join('/') : 'unset'}).`
          : 'No brand DNA cached. Generation will be brand-neutral. Recommend caching brand DNA first.',
      };

      const fallback = {
        model: modelChoice.fallback.name,
        model_path: modelChoice.fallback.path,
        cost_estimate_usd: modelChoice.fallback.cost,
        reason: 'primary model failure or timeout',
      };

      // 9. Decision log — every compilation is a decision worth auditing
      let decisionId = null;
      if (decisionLog && typeof decisionLog.proposeDecision === 'function') {
        try {
          const d = await decisionLog.proposeDecision({
            businessId,
            agentName: 'visual-production-compiler',
            decisionType: 'compile_visual_brief',
            decisionSubtype: intent,
            inputs: { intent, channel, industry, hookType, priority, workspaceId },
            trigger: 'user-request',
            recommendationText:
              `Compile ${intent} for ${channel || 'unspecified channel'} using ` +
              `${modelChoice.primary.name} (~$${modelChoice.primary.cost.toFixed(2)}). ` +
              `Fallback: ${modelChoice.fallback.name}.`,
            confidence: 0.85,
            expectedUpside: { text: `Channel-native ${intent} ready to run` },
            risk: brandDna ? 'Low — brand DNA cached' : 'Medium — no brand DNA yet',
            costUsd: modelChoice.primary.cost,
            autoSafeBand: 'green',
          });
          decisionId = d?.id || null;
          if (decisionId) log(`decision_logs row=${decisionId}`);
        } catch (e) {
          _logWarn('decisionLog.proposeDecision', e);
        }
      }

      _bump('visual_production_compiled_total', { intent, model: modelChoice.primary.name });

      return {
        jobSpec,
        brief,
        qa_checklist: qaChecklist,
        fallback,
        brand_visual_dna_id: brandDna?.id || null,
        decision_log_id: decisionId,
        compliance: complianceResult,
        reasoning_trace: trace,
      };
    } catch (e) {
      _logWarn('compileVisualBrief', e);
      return { _soft: true, reason: e.message, jobSpec: null, reasoning_trace: trace };
    }
  }

  return {
    compileVisualBrief,
    cacheBrandVisualDna,
    getBrandVisualDna,
    MODEL_ROUTING,
    PLATFORM_FORMAT,
    HOOK_DIRECTING,
    VALID_INTENTS,
  };
}

module.exports = {
  makeVisualProductionCompiler,
  MODEL_ROUTING,
  PLATFORM_FORMAT,
  HOOK_DIRECTING,
  VALID_INTENTS,
};
