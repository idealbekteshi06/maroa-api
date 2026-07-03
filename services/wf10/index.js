/*
 * services/wf10/index.js — Higgsfield Studio engine
 *
 * Uses the existing services/higgsfield.js factory for actual generation
 * calls, adds the Claude-powered brief-building step from workflow_10_studio.
 * Agency plan: video A/B variants, Soul ID, Mr. Higgs director shot lists.
 */

'use strict';

const { buildStudioBriefPrompt } = require('../prompts/workflow_10_studio.js');
const { buildBrandContext } = require('../wf1/brandContext.js');
const { estimateModelCost } = require('../higgsfield/costTracking');

function createWf10(deps) {
  const { sbGet, sbPost, sbPatch, callClaude, extractJSON, higgsfieldAI, logger } = deps;

  async function getBusinessPlan(businessId) {
    const rows = await sbGet('businesses', `id=eq.${encodeURIComponent(businessId)}&select=plan,is_active`).catch(
      () => []
    );
    return String(rows[0]?.plan || 'starter').toLowerCase();
  }

  async function resolveBrandContext(businessId) {
    const [b, p] = await Promise.all([
      sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
    ]);
    if (!b[0]) throw new Error('Business not found');
    return buildBrandContext({ business: b[0], profile: p[0] || {} });
  }

  function shotListContext(shotList) {
    if (!shotList?.shot_list?.length) return null;
    return shotList.shot_list
      .map((s, i) => {
        const desc = typeof s === 'string' ? s : s.description || '';
        return `Shot ${i + 1}: ${desc}`;
      })
      .join(' ');
  }

  async function recordAbTestResult({ businessId, abTestId, winnerVariant, metaExperimentId }) {
    if (!businessId || !abTestId || !winnerVariant) {
      throw new Error('businessId, abTestId, and winnerVariant required');
    }
    await sbPatch('video_ab_tests', `id=eq.${encodeURIComponent(abTestId)}`, {
      winner_variant: String(winnerVariant).toLowerCase(),
      meta_experiment_id: metaExperimentId || null,
      status: 'completed',
    });
    return { ok: true, ab_test_id: abTestId, winner_variant: winnerVariant };
  }

  async function uploadSoulIdForBusiness({ businessId, imageUrl, characterName, plan }) {
    const resolvedPlan = plan || (await getBusinessPlan(businessId));
    return higgsfieldAI.uploadSoulId(businessId, imageUrl, {
      plan: resolvedPlan,
      character_name: characterName,
    });
  }

  async function getSoulIdForBusiness({ businessId, plan }) {
    const resolvedPlan = plan || (await getBusinessPlan(businessId));
    return higgsfieldAI.getSoulId(businessId, { plan: resolvedPlan });
  }

  async function createStudioJob({ businessId, request, plan: planOverride }) {
    const brandContext = await resolveBrandContext(businessId);
    const plan = planOverride || request?.plan || (await getBusinessPlan(businessId));
    const isAgency = plan === 'agency';

    const { system, user } = buildStudioBriefPrompt(brandContext, request);
    const raw = await callClaude(user, 'claude-sonnet-5', 2000, { system, businessId, returnRaw: true });
    const brief = extractJSON(raw) || {};

    const job = await sbPost('studio_jobs', {
      business_id: businessId,
      request_kind: brief.asset_type || request.kind || 'image',
      brief,
      provider: 'higgsfield',
      status: 'queued',
    });

    setImmediate(async () => {
      try {
        await sbPatch('studio_jobs', `id=eq.${job.id}`, { status: 'processing' });
        let resultUrl = null;
        let thumbnailUrl = null;
        let genMeta = {};
        let abTestId = null;

        const contentType =
          brief.content_type ||
          request.content_type ||
          (brief.asset_type === 'reel' ? 'social_reel' : null) ||
          (brief.asset_type === 'video' ? 'product_video' : null);
        const cameraPreset = brief.camera_preset || request.preset || request.camera_preset || 'ugc';

        const isVideo = brief.asset_type === 'video' || brief.asset_type === 'reel';
        let soulId = null;
        if (isAgency && isVideo) {
          const soulRow = await higgsfieldAI.getSoulId(businessId, { plan });
          if (soulRow?.higgsfield_soul_id) soulId = soulRow.higgsfield_soul_id;
        }

        let shotList = null;
        if (isAgency && isVideo && higgsfieldAI.generateShotList) {
          const scene =
            brief.video_prompt?.motion_prompt ||
            request.subject ||
            brief.video_prompt?.source_image_prompt ||
            'Brand video scene';
          shotList = await higgsfieldAI.generateShotList(scene, { plan, businessId });
          if (shotList?.skipped) shotList = null;
        }

        const videoOpts = {
          businessId,
          content_type: shotList?.suggested_model ? undefined : contentType,
          model: shotList?.suggested_model,
          preset: cameraPreset,
          aspectRatio: brief.video_prompt?.aspect_ratio || '9:16',
          durationSeconds: brief.video_prompt?.duration_seconds || 5,
          motionPrompt: brief.video_prompt?.motion_prompt,
          sourceImageUrl: brief.video_prompt?.source_image_prompt,
          soul_id: soulId,
          shot_list_context: shotListContext(shotList),
          plan,
        };

        if (higgsfieldAI?.generateImage && (brief.asset_type === 'image' || !brief.asset_type)) {
          const imagePrompt = brief.image_prompts?.[0] || request.subject;
          const result = await higgsfieldAI.generateImage({
            prompt: imagePrompt,
            businessId,
            content_type: contentType,
            preset: cameraPreset,
          });
          resultUrl = result?.url || result?.imageUrl;
          genMeta = result || {};
        } else if (isVideo) {
          if (isAgency && higgsfieldAI.generateVideoVariants) {
            const ab = await higgsfieldAI.generateVideoVariants(brief, videoOpts);
            if (ab?.skipped) {
              throw new Error(ab.reason || 'agency_plan_required');
            }
            genMeta = ab.variant_a || {};
            resultUrl = ab.variant_a?.url || ab.variant_a?.videoUrl;
            thumbnailUrl = ab.variant_a?.thumbnailUrl;

            const abRow = await sbPost('video_ab_tests', {
              business_id: businessId,
              post_id: request.post_id || null,
              variant_a_job_id: ab.variant_a_job_id,
              variant_b_job_id: ab.variant_b_job_id,
              variant_c_job_id: ab.variant_c_job_id,
              variant_a_model: ab.variant_a_model,
              variant_b_model: ab.variant_b_model,
              variant_c_model: ab.variant_c_model,
              status: 'pending',
            });
            abTestId = abRow?.id || abRow?.[0]?.id;

            await sbPatch('studio_jobs', `id=eq.${job.id}`, {
              brief: {
                ...brief,
                ab_test_id: abTestId,
                variants: ab.variants,
                shot_list: shotList,
              },
            }).catch(() => {});
          } else if (higgsfieldAI?.generateVideo) {
            const result = await higgsfieldAI.generateVideo(videoOpts);
            resultUrl = result?.url || result?.videoUrl;
            thumbnailUrl = result?.thumbnailUrl;
            genMeta = result || {};
          }
        }

        const costUsd =
          genMeta.credits_used != null ? estimateModelCost(genMeta.model_slug || genMeta.model_version).cost_usd : null;

        await sbPatch('studio_jobs', `id=eq.${job.id}`, {
          status: resultUrl ? 'completed' : 'failed',
          result_url: resultUrl,
          thumbnail_url: thumbnailUrl,
          provider: 'higgsfield',
          model_used: genMeta.model_used || null,
          camera_preset: genMeta.camera_preset || cameraPreset,
          credits_used: genMeta.credits_used ?? null,
          model_version: genMeta.model_version || genMeta.model_slug || null,
          cost_usd: costUsd,
          completed_at: new Date().toISOString(),
          error: resultUrl ? null : 'No result URL returned from provider',
        });

        await sbPost('events', {
          business_id: businessId,
          kind: resultUrl ? 'wf10.job.completed' : 'wf10.job.failed',
          workflow: '10_studio',
          payload: {
            job_id: job.id,
            asset_type: brief.asset_type,
            url: resultUrl,
            ab_test_id: abTestId,
            agency_features: isAgency,
          },
          severity: resultUrl ? 'success' : 'error',
        }).catch(() => {});
      } catch (e) {
        await sbPatch('studio_jobs', `id=eq.${job.id}`, {
          status: 'failed',
          error: e.message,
          completed_at: new Date().toISOString(),
        }).catch(() => {});
      }
    });

    return { jobId: job.id, brief, status: 'queued', plan };
  }

  async function getJob({ businessId, jobId }) {
    const rows = await sbGet('studio_jobs', `id=eq.${jobId}&business_id=eq.${businessId}&select=*`).catch(() => []);
    return rows[0] || null;
  }

  async function listJobs({ businessId, status, limit = 30 }) {
    let query = `business_id=eq.${businessId}&order=created_at.desc&limit=${limit}&select=*`;
    if (status) query += `&status=eq.${encodeURIComponent(status)}`;
    const rows = await sbGet('studio_jobs', query).catch(() => []);
    return { items: rows };
  }

  return {
    createStudioJob,
    getJob,
    listJobs,
    resolveBrandContext,
    getBusinessPlan,
    recordAbTestResult,
    uploadSoulIdForBusiness,
    getSoulIdForBusiness,
  };
}

module.exports = createWf10;
