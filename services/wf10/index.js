/*
 * services/wf10/index.js — Higgsfield Studio engine
 *
 * Uses the existing services/higgsfield.js factory for actual generation
 * calls, adds the Claude-powered brief-building step from workflow_10_studio.
 */

'use strict';

const { buildStudioBriefPrompt } = require('../prompts/workflow_10_studio.js');
const { buildBrandContext } = require('../wf1/brandContext.js');

function createWf10(deps) {
  const { sbGet, sbPost, sbPatch, callClaude, extractJSON, higgsfieldAI, logger } = deps;

  async function resolveBrandContext(businessId) {
    const [b, p] = await Promise.all([
      sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
    ]);
    if (!b[0]) throw new Error('Business not found');
    return buildBrandContext({ business: b[0], profile: p[0] || {} });
  }

  async function createStudioJob({ businessId, request }) {
    const brandContext = await resolveBrandContext(businessId);
    const { system, user } = buildStudioBriefPrompt(brandContext, request);
    const raw = await callClaude(user, 'claude-sonnet-4-5', 2000, { system, businessId, returnRaw: true });
    const brief = extractJSON(raw) || {};

    const job = await sbPost('studio_jobs', {
      business_id: businessId,
      request_kind: brief.asset_type || request.kind || 'image',
      brief,
      provider: 'segmind',
      status: 'queued',
    });

    // Kick off async generation — use setImmediate so the response returns fast
    setImmediate(async () => {
      try {
        await sbPatch('studio_jobs', `id=eq.${job.id}`, { status: 'processing' });
        let resultUrl = null;
        let thumbnailUrl = null;

        if (higgsfieldAI?.generateImage && (brief.asset_type === 'image' || !brief.asset_type)) {
          const imagePrompt = brief.image_prompts?.[0] || request.subject;
          const result = await higgsfieldAI.generateImage({
            prompt: imagePrompt,
            businessId,
          });
          resultUrl = result?.url || result?.imageUrl;
        } else if (higgsfieldAI?.generateVideo && (brief.asset_type === 'video' || brief.asset_type === 'reel')) {
          const result = await higgsfieldAI.generateVideo({
            sourceImagePrompt: brief.video_prompt?.source_image_prompt,
            motionPrompt: brief.video_prompt?.motion_prompt,
            aspectRatio: brief.video_prompt?.aspect_ratio || '9:16',
            durationSeconds: brief.video_prompt?.duration_seconds || 5,
            businessId,
          });
          resultUrl = result?.url || result?.videoUrl;
          thumbnailUrl = result?.thumbnailUrl;
        }

        await sbPatch('studio_jobs', `id=eq.${job.id}`, {
          status: resultUrl ? 'completed' : 'failed',
          result_url: resultUrl,
          thumbnail_url: thumbnailUrl,
          completed_at: new Date().toISOString(),
          error: resultUrl ? null : 'No result URL returned from provider',
        });

        await sbPost('events', {
          business_id: businessId,
          kind: resultUrl ? 'wf10.job.completed' : 'wf10.job.failed',
          workflow: '10_studio',
          payload: { job_id: job.id, asset_type: brief.asset_type, url: resultUrl },
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

    return { jobId: job.id, brief, status: 'queued' };
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

  return { createStudioJob, getJob, listJobs, resolveBrandContext };
}

module.exports = createWf10;
