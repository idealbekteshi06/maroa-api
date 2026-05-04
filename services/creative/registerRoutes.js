/*
 * services/creative/registerRoutes.js
 * ----------------------------------------------------------------------------
 * Mounts endpoints for the Creative Director (strategic concept) layer,
 * the Soul ID character consistency layer, and the Image Vetter layer.
 *
 * Every route is hardened with:
 *   - x-webhook-secret auth (inherited from app.use('/webhook', requireAuthOrWebhookSecret))
 *   - Per-route express-rate-limit (configurable; defaults are conservative)
 *   - 60s idempotency guard via checkOrchestrationIdempotency where the call is expensive
 *   - Sentry breadcrumbs + spans (when @sentry/node is wired)
 *   - Plan gate via PLAN_LIMITS for the Opus-grade creative-director path
 *
 * Endpoints:
 *   POST /webhook/develop-creative-concept   (rate-limited 30/min/IP, plan-gated, idempotent 60s)
 *   POST /webhook/creative-concept-decision  (rate-limited 60/min/IP)
 *   GET  /webhook/creative-concepts-list     (rate-limited 120/min/IP)
 *   POST /webhook/character-create           (rate-limited 20/min/IP, idempotent 30s)
 *   POST /webhook/character-train            (rate-limited 10/min/IP, idempotent 30s — training is expensive)
 *   GET  /webhook/characters-list            (rate-limited 120/min/IP)
 *   POST /webhook/character-set-default      (rate-limited 30/min/IP)
 *   POST /webhook/vet-customer-asset         (rate-limited 60/min/IP, idempotent 60s same image+theme)
 *   POST /webhook/vet-customer-asset-batch   (rate-limited 10/min/IP)
 *   POST /webhook/smart-process-asset        (rate-limited 30/min/IP, idempotent 60s)
 * ----------------------------------------------------------------------------
 */

'use strict';

const expressRateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const Sentry = (() => { try { return require('@sentry/node'); } catch { return null; } })();

const PLAN_OPUS_LIMIT = { starter: 5, growth: 25, agency: 200 };  // monthly creative-director calls
const PLAN_VETTER_LIMIT = { starter: 50, growth: 300, agency: 2000 };  // monthly vetter calls
const PLAN_CHARACTER_LIMIT = { starter: 1, growth: 5, agency: 25 };  // total trained characters

function makeLimiter(windowMs, max, keyName) {
  return expressRateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const bizKey = req.body?.businessId || req.body?.business_id || req.query?.businessId || req.query?.business_id;
      return `${keyName}:${bizKey || ipKeyGenerator(req.ip)}`;
    },
    message: { error: 'rate_limited', message: `Too many ${keyName} requests; slow down.` },
  });
}

const limiters = {
  develop: makeLimiter(60 * 1000, 30, 'develop_concept'),
  decide: makeLimiter(60 * 1000, 60, 'concept_decide'),
  list: makeLimiter(60 * 1000, 120, 'list'),
  charCreate: makeLimiter(60 * 1000, 20, 'char_create'),
  charTrain: makeLimiter(60 * 1000, 10, 'char_train'),
  charDefault: makeLimiter(60 * 1000, 30, 'char_default'),
  vet: makeLimiter(60 * 1000, 60, 'vet'),
  vetBatch: makeLimiter(60 * 1000, 10, 'vet_batch'),
  smart: makeLimiter(60 * 1000, 30, 'smart_process'),
};

function trace(name, fn) {
  return async function tracedHandler(req, res) {
    const businessId = req.body?.businessId || req.body?.business_id || req.query?.businessId || req.query?.business_id;
    if (Sentry) {
      Sentry.addBreadcrumb({
        category: 'creative.route',
        message: name,
        data: { business_id: businessId, ip: req.ip },
        level: 'info',
      });
    }
    const transaction = Sentry?.startTransaction ? Sentry.startTransaction({ op: 'http.server', name: `POST ${name}` }) : null;
    try {
      await fn(req, res);
    } catch (e) {
      Sentry?.captureException?.(e, { tags: { route: name, business_id: businessId } });
      throw e;
    } finally {
      transaction?.finish();
    }
  };
}

async function getBrandDNAFor(businessId, sbGet) {
  const [bizRows, profileRows] = await Promise.all([
    sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
    sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
  ]);
  const business = bizRows[0];
  if (!business) return null;
  const profile = profileRows[0] || {};
  return {
    business,
    brandDNA: {
      business_name: business.business_name,
      industry: business.industry,
      brand_tone: business.brand_tone,
      target_audience: business.target_audience,
      location: business.location,
      marketing_goal: business.marketing_goal,
      competitors: business.competitors || [],
      visualPalette: profile.visual_palette || null,
      compositionRules: profile.composition_rules || null,
      motionIdentity: profile.motion_identity || null,
    },
  };
}

async function checkMonthlyLimit(sbGet, userId, action, plan, planTable) {
  const limit = planTable[(plan || 'starter').toLowerCase()] ?? planTable.starter;
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const rows = await sbGet('usage_logs', `user_id=eq.${userId}&action=eq.${action}&created_at=gte.${monthStart}&select=id`).catch(() => []);
  const count = Array.isArray(rows) ? rows.length : 0;
  return { allowed: count < limit, count, limit };
}

function logUsage(sbPost, userId, action, businessId) {
  // Fire-and-forget — never blocks the response
  setImmediate(() => {
    sbPost('usage_logs', { user_id: userId, action, business_id: businessId, created_at: new Date().toISOString() }).catch(() => {});
  });
}

function registerCreativeRoutes({ app, hfService, sbGet, sbPost, sbPatch, apiError, logger, checkOrchestrationIdempotency }) {

  // ─── POST /webhook/develop-creative-concept ────────────────────────
  app.post('/webhook/develop-creative-concept', limiters.develop, trace('/webhook/develop-creative-concept', async (req, res) => {
    const { businessId, businessGoal, contentGoal, ideaLevel, abVariant } = req.body || {};
    if (!businessId || !contentGoal) return apiError(res, 400, 'INVALID_REQUEST', 'businessId + contentGoal required');

    try {
      // Idempotency
      if (checkOrchestrationIdempotency) {
        const isDup = await checkOrchestrationIdempotency(businessId, `creative_concept:${(contentGoal || '').slice(0, 50)}`, 60000);
        if (isDup) return apiError(res, 429, 'IDEMPOTENT_DUPLICATE', 'duplicate request within 60s window');
      }

      const ctx = await getBrandDNAFor(businessId, sbGet);
      if (!ctx) return apiError(res, 404, 'BUSINESS_NOT_FOUND', `Business not found: ${businessId}`);
      const { business, brandDNA } = ctx;
      const userId = business.user_id || businessId;

      // Plan gate — Opus calls are expensive
      const planCheck = await checkMonthlyLimit(sbGet, userId, 'creative_concept', business.plan, PLAN_OPUS_LIMIT);
      if (!planCheck.allowed) {
        return apiError(res, 429, 'PLAN_LIMIT_REACHED', `Monthly creative-director limit reached (${planCheck.limit}). Current: ${planCheck.count}.`);
      }

      const goal = businessGoal || business.marketing_goal || 'increase awareness';
      // A/B variant: deterministic seed from businessId+date+contentGoal so reruns reproduce
      const variant = abVariant || pickVariant(`${businessId}|${contentGoal}|${new Date().toISOString().slice(0, 10)}`);
      const concept = await hfService.developCreativeConcept(brandDNA, goal, contentGoal, {
        ideaLevel: ideaLevel || 'campaign',
        rotation: variant === 'B' ? 1 : 0, // rotate methodologies for variant B
        businessId,
      });

      const top = concept.top_concept || {};
      const scores = top.scores || {};
      const insertRow = await sbPost('creative_concepts', {
        business_id: businessId,
        business_goal: goal,
        content_goal: contentGoal,
        idea_level: ideaLevel || 'campaign',
        insight: concept.insight || null,
        tension_type: concept.tension_type || null,
        top_concept: top,
        runner_up: concept.runner_up || null,
        ideas_considered: truncateIdeas(concept.ideas_considered),
        weighted_score: Number(scores.weighted) || null,
        humankind_score: Number(scores.humankind) || null,
        grey_score: Number(scores.grey) || null,
        pattern: top.pattern || null,
        comparable_canon: top.comparable_canon || null,
        raw_response: typeof concept._raw === 'string' ? concept._raw.slice(0, 50000) : null,
        status: 'pending_review',
        model_used: 'claude-opus-4-7',
        ab_variant: variant,
      }).catch((e) => {
        logger?.warn('/webhook/develop-creative-concept', businessId, 'persist failed', { error: e.message });
        return null;
      });

      const conceptId = insertRow?.[0]?.id || insertRow?.id || null;

      logUsage(sbPost, userId, 'creative_concept', businessId);
      await sbPost('events', {
        business_id: businessId,
        kind: 'creative.concept.developed',
        workflow: 'creative_director',
        payload: { concept_id: conceptId, pattern: top.pattern, variant, weighted: scores.weighted, humankind: scores.humankind },
        severity: 'info',
      }).catch(() => {});

      res.json({ conceptId, concept, abVariant: variant, planUsage: { count: planCheck.count + 1, limit: planCheck.limit } });
    } catch (e) {
      logger?.error('/webhook/develop-creative-concept', businessId, 'failed', e);
      apiError(res, 500, 'CREATIVE_DEVELOP_FAILED', e.message);
    }
  }));

  // ─── POST /webhook/creative-concept-decision ───────────────────────
  app.post('/webhook/creative-concept-decision', limiters.decide, trace('/webhook/creative-concept-decision', async (req, res) => {
    const { businessId, conceptId, decision, reason } = req.body || {};
    if (!businessId || !conceptId || !decision) return apiError(res, 400, 'INVALID_REQUEST', 'businessId + conceptId + decision required');
    if (!['approve', 'reject', 'use'].includes(decision)) return apiError(res, 400, 'INVALID_REQUEST', 'decision must be approve|reject|use');

    try {
      const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'used';
      await sbPatch('creative_concepts', `id=eq.${conceptId}`, {
        status,
        decision_reason: reason || null,
        decided_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await sbPost('events', {
        business_id: businessId,
        kind: `creative.concept.${decision}`,
        workflow: 'creative_director',
        payload: { concept_id: conceptId, reason },
        severity: 'info',
      }).catch(() => {});
      res.json({ ok: true, status });
    } catch (e) {
      logger?.error('/webhook/creative-concept-decision', businessId, 'failed', e);
      apiError(res, 500, 'CREATIVE_DECISION_FAILED', e.message);
    }
  }));

  // ─── GET /webhook/creative-concepts-list ───────────────────────────
  app.get('/webhook/creative-concepts-list', limiters.list, trace('/webhook/creative-concepts-list', async (req, res) => {
    const businessId = req.query?.business_id || req.query?.businessId;
    const limit = Math.min(Number(req.query?.limit) || 25, 100);
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try {
      const rows = await sbGet(
        'creative_concepts',
        `business_id=eq.${businessId}&order=created_at.desc&limit=${limit}&select=id,content_goal,idea_level,insight,top_concept,weighted_score,humankind_score,pattern,status,ab_variant,created_at`
      );
      res.json({ concepts: rows });
    } catch (e) {
      logger?.error('/webhook/creative-concepts-list', businessId, 'failed', e);
      apiError(res, 500, 'CREATIVE_LIST_FAILED', e.message);
    }
  }));

  // ─── Soul ID — POST /webhook/character-create ──────────────────────
  app.post('/webhook/character-create', limiters.charCreate, trace('/webhook/character-create', async (req, res) => {
    const { businessId, name, type, sourceImageUrls, makeDefault, metadata } = req.body || {};
    if (!businessId || !name) return apiError(res, 400, 'INVALID_REQUEST', 'businessId + name required');
    const urls = Array.isArray(sourceImageUrls) ? sourceImageUrls.filter((u) => typeof u === 'string' && u.startsWith('http')) : [];
    if (urls.length === 0) return apiError(res, 400, 'INVALID_REQUEST', 'sourceImageUrls (1-5+) required');

    try {
      // Idempotency (30s) keyed on businessId+name
      if (checkOrchestrationIdempotency) {
        const isDup = await checkOrchestrationIdempotency(businessId, `char_create:${name}`, 30000);
        if (isDup) return apiError(res, 429, 'IDEMPOTENT_DUPLICATE', 'duplicate character-create within 30s window');
      }

      // Plan gate — total trained characters per business
      const ctx = await getBrandDNAFor(businessId, sbGet);
      if (!ctx) return apiError(res, 404, 'BUSINESS_NOT_FOUND', `Business not found: ${businessId}`);
      const userId = ctx.business.user_id || businessId;
      const totalRows = await sbGet('business_characters', `business_id=eq.${businessId}&select=id`).catch(() => []);
      const totalCharacters = Array.isArray(totalRows) ? totalRows.length : 0;
      const limit = PLAN_CHARACTER_LIMIT[(ctx.business.plan || 'starter').toLowerCase()] ?? PLAN_CHARACTER_LIMIT.starter;
      if (totalCharacters >= limit) {
        return apiError(res, 429, 'PLAN_LIMIT_REACHED', `Plan ${ctx.business.plan || 'starter'} allows max ${limit} characters. Current: ${totalCharacters}.`);
      }

      const row = await sbPost('business_characters', {
        business_id: businessId,
        name,
        character_type: type || 'founder',
        source_image_urls: urls,
        source_image_count: urls.length,
        training_status: 'pending',
        is_default: !!makeDefault,
        metadata: metadata || {},
      });
      const characterId = row?.[0]?.id || row?.id || null;
      if (makeDefault && characterId) {
        await sbPatch('business_characters', `business_id=eq.${businessId}&id=neq.${characterId}`, { is_default: false }).catch(() => {});
      }
      logUsage(sbPost, userId, 'character_create', businessId);
      res.json({ characterId, trainingStatus: 'pending', creditCost: 40, planUsage: { count: totalCharacters + 1, limit } });
    } catch (e) {
      logger?.error('/webhook/character-create', businessId, 'failed', e);
      apiError(res, 500, 'CHARACTER_CREATE_FAILED', e.message);
    }
  }));

  // ─── Soul ID — POST /webhook/character-train ───────────────────────
  app.post('/webhook/character-train', limiters.charTrain, trace('/webhook/character-train', async (req, res) => {
    const { businessId, characterId } = req.body || {};
    if (!businessId || !characterId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId + characterId required');
    try {
      if (checkOrchestrationIdempotency) {
        const isDup = await checkOrchestrationIdempotency(businessId, `char_train:${characterId}`, 30000);
        if (isDup) return apiError(res, 429, 'IDEMPOTENT_DUPLICATE', 'duplicate character-train within 30s window');
      }
      const rows = await sbGet('business_characters', `id=eq.${characterId}&business_id=eq.${businessId}&select=*`);
      const character = rows[0];
      if (!character) return apiError(res, 404, 'CHARACTER_NOT_FOUND', 'character not found for this business');
      if (character.training_status === 'training') return apiError(res, 409, 'ALREADY_TRAINING', 'character already training');
      if (character.training_status === 'ready') return res.json({ ok: true, alreadyReady: true });

      await sbPatch('business_characters', `id=eq.${characterId}`, {
        training_status: 'training',
        training_started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      hfService.trainSoulCharacter({
        characterId,
        sourceImageUrls: character.source_image_urls,
        name: character.name,
      }).then(async (result) => {
        await sbPatch('business_characters', `id=eq.${characterId}`, {
          training_status: 'ready',
          higgsfield_character_id: result.higgsfield_character_id,
          trained_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        await sbPost('events', {
          business_id: businessId,
          kind: 'character.trained',
          workflow: 'soul_id',
          payload: { character_id: characterId, hf_id: result.higgsfield_character_id },
          severity: 'success',
        }).catch(() => {});
      }).catch(async (e) => {
        Sentry?.captureException?.(e, { tags: { workflow: 'soul_id', business_id: businessId, character_id: characterId } });
        logger?.error('/webhook/character-train', businessId, 'training failed', e);
        await sbPatch('business_characters', `id=eq.${characterId}`, {
          training_status: 'failed',
          training_error: e.message?.slice(0, 1000),
          updated_at: new Date().toISOString(),
        }).catch(() => {});
      });

      res.json({ ok: true, characterId, trainingStatus: 'training' });
    } catch (e) {
      logger?.error('/webhook/character-train', businessId, 'failed', e);
      apiError(res, 500, 'CHARACTER_TRAIN_FAILED', e.message);
    }
  }));

  // ─── Soul ID — GET /webhook/characters-list ────────────────────────
  app.get('/webhook/characters-list', limiters.list, trace('/webhook/characters-list', async (req, res) => {
    const businessId = req.query?.business_id || req.query?.businessId;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try {
      const rows = await sbGet(
        'business_characters',
        `business_id=eq.${businessId}&order=created_at.desc&select=id,name,character_type,training_status,higgsfield_character_id,source_image_count,is_default,created_at,trained_at`
      );
      res.json({ characters: rows });
    } catch (e) {
      logger?.error('/webhook/characters-list', businessId, 'failed', e);
      apiError(res, 500, 'CHARACTERS_LIST_FAILED', e.message);
    }
  }));

  // ─── Soul ID — POST /webhook/character-set-default ─────────────────
  app.post('/webhook/character-set-default', limiters.charDefault, trace('/webhook/character-set-default', async (req, res) => {
    const { businessId, characterId } = req.body || {};
    if (!businessId || !characterId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId + characterId required');
    try {
      await sbPatch('business_characters', `business_id=eq.${businessId}`, { is_default: false });
      await sbPatch('business_characters', `id=eq.${characterId}&business_id=eq.${businessId}`, { is_default: true, updated_at: new Date().toISOString() });
      res.json({ ok: true });
    } catch (e) {
      logger?.error('/webhook/character-set-default', businessId, 'failed', e);
      apiError(res, 500, 'CHARACTER_DEFAULT_FAILED', e.message);
    }
  }));

  // ─── Image Vetter — POST /webhook/vet-customer-asset ────────────────
  app.post('/webhook/vet-customer-asset', limiters.vet, trace('/webhook/vet-customer-asset', async (req, res) => {
    const { businessId, imageUrl, contentTheme } = req.body || {};
    if (!businessId || !imageUrl) return apiError(res, 400, 'INVALID_REQUEST', 'businessId + imageUrl required');
    try {
      // Idempotency 60s on same image+theme
      if (checkOrchestrationIdempotency) {
        const isDup = await checkOrchestrationIdempotency(businessId, `vet:${imageUrl.slice(0, 80)}|${(contentTheme || '').slice(0, 30)}`, 60000);
        if (isDup) return apiError(res, 429, 'IDEMPOTENT_DUPLICATE', 'duplicate vet within 60s window');
      }

      const ctx = await getBrandDNAFor(businessId, sbGet);
      if (!ctx) return apiError(res, 404, 'BUSINESS_NOT_FOUND', `Business not found: ${businessId}`);
      const userId = ctx.business.user_id || businessId;

      // Plan gate
      const planCheck = await checkMonthlyLimit(sbGet, userId, 'vet_asset', ctx.business.plan, PLAN_VETTER_LIMIT);
      if (!planCheck.allowed) {
        return apiError(res, 429, 'PLAN_LIMIT_REACHED', `Monthly vetter limit reached (${planCheck.limit}). Current: ${planCheck.count}.`);
      }

      const verdict = await hfService.vetCustomerAsset(imageUrl, ctx.brandDNA, { contentTheme: contentTheme || '' });

      const persisted = await sbPost('asset_vetting_results', {
        business_id: businessId,
        image_url: imageUrl,
        content_theme: contentTheme || null,
        genre: verdict.genre || null,
        verdict: verdict.verdict,
        total_100: verdict.total_100,
        borderline: !!verdict.borderline,
        scores: verdict.scores || {},
        hard_gates_fired: verdict.hard_gates_fired || [],
        manual_review_recommended: !!verdict.manual_review_recommended,
        next_action: verdict.next_action || null,
        notes: verdict.notes || null,
        subject_phrase: verdict.subject_phrase || null,
      }).catch((e) => {
        logger?.warn('/webhook/vet-customer-asset', businessId, 'persist failed', { error: e.message });
        return null;
      });
      const vettingResultId = persisted?.[0]?.id || persisted?.id || null;

      logUsage(sbPost, userId, 'vet_asset', businessId);
      await sbPost('events', {
        business_id: businessId,
        kind: `vetter.${verdict.verdict}`,
        workflow: 'image_vetter',
        payload: { image_url: imageUrl, total: verdict.total_100, genre: verdict.genre },
        severity: verdict.verdict === 'reject' ? 'warn' : 'info',
      }).catch(() => {});

      res.json({ ...verdict, vettingResultId, planUsage: { count: planCheck.count + 1, limit: planCheck.limit } });
    } catch (e) {
      logger?.error('/webhook/vet-customer-asset', businessId, 'failed', e);
      apiError(res, 500, 'VETTER_FAILED', e.message);
    }
  }));

  // ─── Image Vetter — POST /webhook/vet-customer-asset-batch ──────────
  app.post('/webhook/vet-customer-asset-batch', limiters.vetBatch, trace('/webhook/vet-customer-asset-batch', async (req, res) => {
    const { businessId, imageUrls, contentTheme } = req.body || {};
    if (!businessId || !Array.isArray(imageUrls) || imageUrls.length === 0)
      return apiError(res, 400, 'INVALID_REQUEST', 'businessId + imageUrls (non-empty array) required');
    if (imageUrls.length > 25) return apiError(res, 400, 'BATCH_TOO_LARGE', 'max 25 images per batch');

    try {
      const ctx = await getBrandDNAFor(businessId, sbGet);
      if (!ctx) return apiError(res, 404, 'BUSINESS_NOT_FOUND', `Business not found: ${businessId}`);
      const grouped = await hfService.vetCustomerAssetBatch(imageUrls, ctx.brandDNA, { contentTheme: contentTheme || '' });
      res.json(grouped);
    } catch (e) {
      logger?.error('/webhook/vet-customer-asset-batch', businessId, 'failed', e);
      apiError(res, 500, 'VETTER_BATCH_FAILED', e.message);
    }
  }));

  // ─── Image Vetter — POST /webhook/smart-process-asset ───────────────
  app.post('/webhook/smart-process-asset', limiters.smart, trace('/webhook/smart-process-asset', async (req, res) => {
    const { businessId, imageUrl, contentTheme } = req.body || {};
    if (!businessId || !imageUrl) return apiError(res, 400, 'INVALID_REQUEST', 'businessId + imageUrl required');
    try {
      if (checkOrchestrationIdempotency) {
        const isDup = await checkOrchestrationIdempotency(businessId, `smart:${imageUrl.slice(0, 80)}`, 60000);
        if (isDup) return apiError(res, 429, 'IDEMPOTENT_DUPLICATE', 'duplicate smart-process within 60s window');
      }

      const ctx = await getBrandDNAFor(businessId, sbGet);
      if (!ctx) return apiError(res, 404, 'BUSINESS_NOT_FOUND', `Business not found: ${businessId}`);
      const userId = ctx.business.user_id || businessId;

      const result = await hfService.smartProcessAsset(imageUrl, ctx.brandDNA, { contentTheme: contentTheme || '', userId });

      // Audit write-back: mark the latest matching vetting result as applied
      try {
        const recent = await sbGet(
          'asset_vetting_results',
          `business_id=eq.${businessId}&image_url=eq.${encodeURIComponent(imageUrl)}&order=created_at.desc&limit=1&select=id`
        ).catch(() => []);
        const id = recent?.[0]?.id;
        if (id) {
          await sbPatch('asset_vetting_results', `id=eq.${id}`, { applied: true }).catch(() => {});
        }
      } catch { /* audit write-back is best-effort */ }

      logUsage(sbPost, userId, 'smart_process', businessId);
      res.json(result);
    } catch (e) {
      logger?.error('/webhook/smart-process-asset', businessId, 'failed', e);
      apiError(res, 500, 'SMART_PROCESS_FAILED', e.message);
    }
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────

function pickVariant(seedStr) {
  // Deterministic A/B based on FNV-1a hash of seedStr
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h % 2) === 0 ? 'A' : 'B';
}

function truncateIdeas(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 30).map((i) => ({
    idea: typeof i?.idea === 'string' ? i.idea.slice(0, 500) : '',
    method: typeof i?.method === 'string' ? i.method.slice(0, 80) : '',
    rejected_because: typeof i?.rejected_because === 'string' ? i.rejected_because.slice(0, 500) : '',
  }));
}

module.exports = { registerCreativeRoutes, PLAN_OPUS_LIMIT, PLAN_VETTER_LIMIT, PLAN_CHARACTER_LIMIT, pickVariant };
