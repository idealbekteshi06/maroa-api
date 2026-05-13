'use strict';

/**
 * services/creative-engine/index.js
 * ---------------------------------------------------------------------------
 * Daily Creative Engine — the "humans physically can't compete" layer.
 *
 * Every 24h per business:
 *   1. Generate 3-5 new creative variants (copy + image + video) using
 *      Higgsfield + Anthropic + cross-account patterns
 *   2. Auto-route 1% of daily budget to test the new variants
 *   3. After 72h, promote winners (z-score CTR > +1.5σ vs cohort mean)
 *      and kill losers (z-score CTR < -1.5σ for 3+ consecutive days)
 *
 * Why a separate service:
 *   - ad-optimizer is about audit/decision on EXISTING ads
 *   - creative-engine is about CREATING new ads at scale
 *   - Different cadences, different observability, different cost profile
 *
 * Public API:
 *   generateDailyVariants({ businessId })      — produce 3-5 new variants
 *   evaluateTestingVariants({ businessId })    — promote/kill testing variants
 *   selectFatigueRefresh({ businessId, campaignId }) — pick a fresh variant when an old one fatigues
 * ---------------------------------------------------------------------------
 */

const VARIANTS_PER_DAY_BY_PLAN = {
  free: 0, // free tier doesn't get the engine
  growth: 3, // 3/day — solid velocity
  agency: 5, // 5/day — full velocity
};

const TEST_BUDGET_PCT = 0.01; // route 1% of daily budget to new variants
const MIN_TEST_HOURS = 72; // minimum 3 days before promoting
const PROMOTE_Z_SCORE = 1.5; // CTR z-score > +1.5σ → promote
const KILL_Z_SCORE = -1.5; // CTR z-score < -1.5σ → kill
const KILL_CONSECUTIVE_DAYS = 3;

// ─── Variant generation ──────────────────────────────────────────────────

/**
 * Build a creative variant payload using:
 *  - The business's brand voice anchor
 *  - The approved cold-start concept (or last winning variant)
 *  - Cross-account patterns for the cohort (industry+region+budget tier)
 *
 * Returns the row to insert into ad_creative_variants (status='queued').
 */
async function generateDailyVariants({ businessId, deps }) {
  const { sbGet, sbPost, callClaude, higgsfield, brandVoice, logger, metrics } = deps;
  const groundingContext = deps.groundingContext || require('../../lib/groundingContext');
  const nBestReranker = deps.nBestReranker || require('../../lib/nBestReranker');
  const adversarialCritic = deps.adversarialCritic || require('../../lib/adversarialCritic');

  const businessRows = await sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []);
  const business = businessRows?.[0];
  if (!business) return { ok: false, reason: 'business not found' };

  const plan = (business.plan || 'free').toLowerCase();
  const variantsPerDay = VARIANTS_PER_DAY_BY_PLAN[plan] ?? 0;
  if (variantsPerDay === 0) {
    return { ok: true, generated: 0, reason: 'plan tier not eligible' };
  }

  // Skip if we've already generated today's batch (idempotency)
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const recent = await sbGet(
    'ad_creative_variants',
    `business_id=eq.${businessId}&source=eq.daily_engine&created_at=gte.${todayStart.toISOString()}&select=id&limit=10`
  ).catch(() => []);
  if (recent && recent.length >= variantsPerDay) {
    return { ok: true, generated: 0, reason: 'already generated for today' };
  }

  // Pull the brand voice anchor
  const anchorRows = await sbGet(
    'brand_voice_anchors',
    `business_id=eq.${businessId}&order=created_at.desc&limit=1&select=anchor`
  ).catch(() => []);
  const brandDNA = anchorRows?.[0]?.anchor || (brandVoice?.buildAnchor?.({ business }) ?? {});

  // Pull cross-account patterns for the cohort. We seed variants from the
  // top-3 patterns by lift confidence — gives us a starting point that's
  // already proven to work for similar businesses.
  const budgetTier = bucketBudgetTier(business.daily_budget);
  const patterns = await sbGet(
    'cross_account_patterns',
    `industry=eq.${encodeURIComponent(business.industry || '')}&budget_tier=eq.${budgetTier}&order=median_roas_lift.desc&limit=3&select=*`
  ).catch(() => []);

  // ─── Closed-loop creative system: stage route → grounding → oversample → N-best → critic ──
  //
  // STEP 0 (Wave 60 S2): route through the awareness × funnel matrix.
  // Creative engine produces BOFU ad copy by default; awareness comes
  // from the business's segmentation if available, otherwise defaults to
  // product_aware (the most common ad-targeting tier).
  const stageRouter = deps.stageRouter || require('../../lib/stageRouter');
  const route = stageRouter.routeContent({
    awareness: business.default_awareness_stage || 'product_aware',
    funnel: business.default_funnel_stage || 'bofu',
    channel: 'meta-ads-image',
    industry: business.industry,
  });
  if (!route.ok) {
    logger?.warn?.('creative-engine.stage-router', businessId, 'invalid cell — falling back', {
      refusal: route.refusal,
    });
  }

  // STEP 1: Build grounding context ONCE for this business. The library
  // caches for 5min, so subsequent variant calls in this batch are free.
  // Surface = ad_copy because that's what the engine produces.
  const grounding = await groundingContext.buildGroundingContext({
    sbGet,
    businessId,
    surface: 'ad_copy',
    intent: 'conversion',
    limit: 3,
    // Wave 59 S3: tier-gate the corpus section (free=0, growth=2, agency=5).
    // `plan` was fetched as part of the business row above.
    plan,
  });

  // STEP 2: OVERSAMPLE candidates 2×. Generate without critic — we'll
  // critic only the picks. This gives 2× creative diversity to the judge
  // without paying the 2× critic cost on candidates that won't ship.
  const oversample = Math.min(variantsPerDay * 2, 10); // hard cap at 10 to bound cost
  const candidates = [];
  const candidateTasks = Array.from({ length: oversample }, (_, i) =>
    generateOneVariantCandidate({
      business,
      brandDNA,
      grounding,
      seedPattern: patterns[i % Math.max(1, patterns.length)] || null,
      variantIndex: i,
      deps,
    }).catch((e) => {
      logger?.warn?.('creative-engine.generate', businessId, `candidate ${i} failed`, { error: e.message });
      return null;
    })
  );
  const candidateResults = await Promise.all(candidateTasks);
  for (const c of candidateResults) {
    if (c) candidates.push(c);
  }

  // STEP 3: N-best — Haiku judges all candidate bodies, picks top variantsPerDay.
  // Failure mode: judge unavailable → first variantsPerDay candidates ship
  // (insertion order). Still better than no judge ranking.
  let picked = [];
  if (candidates.length <= variantsPerDay) {
    picked = candidates;
  } else {
    let bodyIdx = 0;
    const indexedDrafts = candidates.map((c) => String(c.body || ''));
    const winners = await nBestReranker.nBestPick({
      callClaude,
      generateDraft: async () => indexedDrafts[bodyIdx++] || null,
      n: indexedDrafts.length,
      topK: variantsPerDay,
      role: 'ad_copy',
      judgeCriteria: [
        '- Specificity (real numbers, real customer phrases from the grounding)',
        '- Hook strength: do the first 5 words earn the rest?',
        '- Avoidance of clichés / corporate / AI-coded phrasing',
        "- Match to the brand voice (don't drift)",
        '- Match to the active VoC pain points if any are present',
      ].join('\n'),
      businessId,
      skill: 'creative_engine_body_judge',
      metrics,
      logger,
    });
    // Map winning bodies back to the full variant JSONs.
    for (const w of winners) {
      const match = candidates.find((c) => c.body === w.draft);
      if (match) {
        match._judge_score = w.score;
        match._judge_rationale = w.rationale;
        picked.push(match);
      }
    }
    // Fallback if mapping somehow lost candidates — fill from insertion order
    if (picked.length < variantsPerDay) {
      for (const c of candidates) {
        if (picked.length >= variantsPerDay) break;
        if (!picked.includes(c)) picked.push(c);
      }
    }
  }

  // STEP 4: Critic loop on the picks. Plan-gated as before:
  //   growth = body only, agency = body + headline, free already filtered.
  const variants = [];
  for (const v of picked) {
    const finalized = await applyCriticLoop({ variant: v, business, deps, adversarialCritic }).catch((e) => {
      logger?.warn?.('creative-engine.critic-loop', business.id, 'critic loop failed', { error: e.message });
      return v;
    });
    variants.push(finalized);
  }

  // Persist
  for (const v of variants) {
    await sbPost('ad_creative_variants', {
      business_id: businessId,
      source: 'daily_engine',
      format: v.format,
      headline: v.headline,
      body: v.body,
      cta: v.cta,
      asset_url: v.asset_url || null,
      higgsfield_model: v.higgsfield_model || null,
      higgsfield_request_id: v.higgsfield_request_id || null,
      status: 'queued',
      spend_test_pct: TEST_BUDGET_PCT,
      decision_reason: v.decision_reason || null,
    }).catch((e) => logger?.warn?.('creative-engine.generate', businessId, 'persist failed', { error: e.message }));
  }

  return { ok: true, generated: variants.length, plan_tier: plan };
}

/**
 * Generate a single VARIANT CANDIDATE. No critic here — the orchestrator runs
 * critic only on the candidates the N-best judge picks, to avoid paying for
 * critic-on-losers. Returns the JSON variant or null on parse failure.
 */
async function generateOneVariantCandidate({ business, brandDNA, grounding, seedPattern, variantIndex, deps }) {
  const { callClaude } = deps;

  // Compose the LLM prompt for copy.
  // The grounding block (if non-empty) is prepended to the system prompt
  // so the model has wins/losses/VoC/cohort/brand all in front of it
  // BEFORE it generates a single token.
  const groundingBlock = grounding?.toPromptBlock?.() || '';
  const systemParts = [
    groundingBlock ? `${groundingBlock}\n` : '',
    'You produce a single ad variant for an SMB. Output JSON only:',
    '{ "format": "image|video|carousel|text_only",',
    '  "headline": "≤ 40 chars",',
    '  "body": "≤ 125 chars",',
    '  "cta": "≤ 20 chars",',
    '  "creative_brief": "what to show in the visual" }',
    '',
    'Anchor every choice to the brand voice from the grounding context above.',
    'Apply ONE explicit psychological principle (Cialdini, Kahneman, or Ariely).',
    'Reference the seed pattern if provided.',
    'Imitate the structural patterns from WINS. Avoid the patterns in LOSSES.',
  ];
  const system = systemParts.filter(Boolean).join('\n');

  const userTask = JSON.stringify({
    business_name: business.business_name,
    industry: business.industry,
    audience: business.target_audience,
    brand_voice: {
      tone: brandDNA?.tone_descriptors,
      audience_summary: brandDNA?.audience_summary,
      never_say: brandDNA?.never_say,
    },
    seed_pattern: seedPattern
      ? {
          type: seedPattern.pattern_type,
          signature: seedPattern.pattern_signature,
          payload: seedPattern.pattern_payload,
        }
      : null,
    variant_index: variantIndex,
  });

  let copyVariant;
  try {
    const r = await callClaude({
      model: 'sonnet',
      system,
      messages: [{ role: 'user', content: userTask }],
      maxTokens: 600,
      cacheSystem: true,
    });
    const text = r?.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    copyVariant = match ? JSON.parse(match[0]) : null;
  } catch (e) {
    return null;
  }
  if (!copyVariant) return null;

  // For visual formats, request Higgsfield asset generation. Fire-and-forget —
  // the asset polls back via the existing Higgsfield request status path.
  const { higgsfield } = deps;
  let assetUrl = null;
  let modelUsed = null;
  let requestId = null;
  if (copyVariant.format !== 'text_only' && higgsfield?.generateWithModel) {
    try {
      const cap = copyVariant.format === 'video' ? 'short_reel' : 'product_photo_4k';
      modelUsed = higgsfield.modelForCapability?.(cap) || 'soul 2.0';
    } catch (e) {
      /* soft-fail — see ADR-0003 */
    }
  }

  return {
    format: copyVariant.format || 'image',
    headline: copyVariant.headline,
    body: copyVariant.body,
    cta: copyVariant.cta,
    asset_url: assetUrl,
    higgsfield_model: modelUsed,
    higgsfield_request_id: requestId,
    decision_reason: seedPattern
      ? `Seeded from cohort pattern "${seedPattern.pattern_signature}" (lift ${seedPattern.median_roas_lift ?? '?'})`
      : `Variant ${variantIndex + 1} — grounded + brand voice + industry baseline`,
  };
}

/**
 * Run the Adversarial Critic loop on a picked variant. Plan-gated:
 *   growth → body critique only
 *   agency → body + headline critique
 *   free   → never reached (filtered upstream)
 *
 * Critic failure ships the original copy untouched.
 */
async function applyCriticLoop({ variant, business, deps, adversarialCritic }) {
  const { callClaude, logger, metrics } = deps;
  const critic = adversarialCritic || require('../../lib/adversarialCritic');
  const copyVariant = variant;
  const plan = (business.plan || 'free').toLowerCase();
  const critiqueBody = plan === 'growth' || plan === 'agency';
  const critiqueHeadline = plan === 'agency';

  if (critiqueBody && copyVariant.body) {
    try {
      const result = await critic.reflexion({
        callClaude,
        draft: String(copyVariant.body),
        role: 'ad_copy',
        businessId: business.id,
        skill: 'creative_engine_body_critic',
        criticModel: 'claude-haiku-4-5',
        rewriteModel: 'claude-sonnet-4-5',
        maxRewriteRounds: 1,
        rewriteMaxTokens: 200,
        metrics,
        logger,
      });
      if (result.improved && result.final) {
        copyVariant.body = result.final.slice(0, 125);
        copyVariant._critic_severity = result.criticVerdict?.severity;
      }
    } catch (e) {
      logger?.warn?.('creative-engine.critic', business.id, 'body critique failed (kept original)', {
        error: e.message,
      });
    }
  }

  if (critiqueHeadline && copyVariant.headline) {
    try {
      const result = await critic.reflexion({
        callClaude,
        draft: String(copyVariant.headline),
        role: 'ad_copy',
        extraCriteria: 'Headline only — must be ≤40 characters and earn the click in 5 words or fewer.',
        businessId: business.id,
        skill: 'creative_engine_headline_critic',
        criticModel: 'claude-haiku-4-5',
        rewriteModel: 'claude-sonnet-4-5',
        maxRewriteRounds: 1,
        rewriteMaxTokens: 80,
        metrics,
        logger,
      });
      if (result.improved && result.final) {
        copyVariant.headline = result.final.slice(0, 40);
      }
    } catch (e) {
      logger?.warn?.('creative-engine.critic', business.id, 'headline critique failed (kept original)', {
        error: e.message,
      });
    }
  }

  return copyVariant;
}

function bucketBudgetTier(daily) {
  const b = Number(daily) || 5;
  if (b < 20) return '5';
  if (b < 50) return '20';
  if (b < 100) return '50';
  if (b < 500) return '100';
  return '500';
}

// ─── Z-score evaluator ───────────────────────────────────────────────────

/**
 * mean + sample standard deviation. Returns 0/0 on degenerate inputs.
 */
function meanStd(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (xs.length === 0) return { mean: 0, std: 0, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (xs.length < 2) return { mean, std: 0, n: 1 };
  const variance = xs.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (xs.length - 1);
  return { mean, std: Math.sqrt(variance), n: xs.length };
}

function zScore(value, mean, std) {
  if (!Number.isFinite(value) || std <= 0) return 0;
  return (value - mean) / std;
}

/**
 * evaluateTestingVariants — for a business, look at all variants in
 * status='testing' for at least MIN_TEST_HOURS. Promote/kill based on z-score.
 */
async function evaluateTestingVariants({ businessId, deps }) {
  const { sbGet, sbPatch, logger } = deps;

  const cutoff = new Date(Date.now() - MIN_TEST_HOURS * 60 * 60 * 1000).toISOString();
  const testing = await sbGet(
    'ad_creative_variants',
    `business_id=eq.${businessId}&status=eq.testing&test_started_at=lte.${cutoff}&select=*`
  ).catch(() => []);

  if (!testing || testing.length === 0) return { ok: true, evaluated: 0, promoted: 0, killed: 0 };

  // Compute cohort mean/std from ALL variants (testing + recently promoted/killed)
  // for this business — gives us a stable baseline.
  const cohortRows = await sbGet(
    'ad_creative_variants',
    `business_id=eq.${businessId}&status=in.(testing,promoted,killed)&select=ctr,roas&limit=200`
  ).catch(() => []);
  const ctrStats = meanStd(cohortRows.map((r) => Number(r.ctr)).filter((x) => x > 0));
  const roasStats = meanStd(cohortRows.map((r) => Number(r.roas)).filter((x) => x > 0));

  let promoted = 0,
    killed = 0;
  for (const v of testing) {
    const ctr = Number(v.ctr);
    const roas = Number(v.roas);
    const zCtr = zScore(ctr, ctrStats.mean, ctrStats.std);
    const zRoas = zScore(roas, roasStats.mean, roasStats.std);

    let nextStatus = null;
    let reason = null;

    if (zCtr >= PROMOTE_Z_SCORE && zRoas >= 0) {
      nextStatus = 'promoted';
      reason = `CTR z-score +${zCtr.toFixed(2)}σ above cohort + ROAS not negative`;
      promoted += 1;
    } else if (zCtr <= KILL_Z_SCORE) {
      nextStatus = 'killed';
      reason = `CTR z-score ${zCtr.toFixed(2)}σ — below kill threshold`;
      killed += 1;
    }

    if (nextStatus) {
      await sbPatch('ad_creative_variants', `id=eq.${v.id}`, {
        status: nextStatus,
        test_ended_at: new Date().toISOString(),
        z_score_ctr: zCtr,
        z_score_roas: zRoas,
        decision_reason: reason,
      }).catch((e) =>
        logger?.warn?.('creative-engine.evaluate', businessId, 'patch failed', { id: v.id, error: e.message })
      );
    }
  }

  return {
    ok: true,
    evaluated: testing.length,
    promoted,
    killed,
    cohort_n: ctrStats.n,
  };
}

module.exports = {
  generateDailyVariants,
  evaluateTestingVariants,
  meanStd,
  zScore,
  bucketBudgetTier,
  VARIANTS_PER_DAY_BY_PLAN,
  PROMOTE_Z_SCORE,
  KILL_Z_SCORE,
  TEST_BUDGET_PCT,
};
