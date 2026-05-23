'use strict';

/**
 * routes/video-generation.js — video script + Runway generation pipeline.
 *
 * Carved from server.js as part of the 2026-05-13 audit P4 (server.js
 * carve-up).
 *
 *   POST /webhook/video-script-generate  — AI structured script + thumbnail
 *   POST /webhook/video-generate-runway  — Runway gen3 turbo generation
 *   GET  /webhook/video-status           — async generation status
 *   GET  /webhook/videos-get             — list business videos
 *
 * Behavior unchanged. Dep injection for testability.
 */

function register({
  app,
  sbGet,
  sbPost,
  sbPatch,
  callClaude,
  apiRequest,
  sendEmail,
  log,
  logError,
  generateImage,
  saveImageToSupabase,
  RUNWAY_API_KEY,
  getBrandExamples,
}) {
  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/video-script-generate
  // Generate full structured video script + thumbnail. Saves to video_generations.
  // Body: { business_id, platform, topic }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/video-script-generate', async (req, res) => {
    const { business_id, platform = 'tiktok', topic } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!['tiktok', 'instagram_reel', 'youtube_short'].includes(platform))
      return res.status(400).json({ error: 'platform must be tiktok|instagram_reel|youtube_short' });

    // Return 200 immediately — generation (~15s) in background
    res.json({ received: true, message: 'Video script generation started — check email in ~30 seconds' });

    setImmediate(async () => {
      try {
        const bizArr = await sbGet(
          'businesses',
          `id=eq.${business_id}&select=business_name,industry,brand_tone,target_audience,marketing_goal,email,first_name`
        );
        const biz = bizArr[0];
        if (!biz) return;

        // Find topic from best performing content if not provided
        let useTopic = topic;
        if (!useTopic) {
          try {
            const latest = await sbGet(
              'generated_content',
              `business_id=eq.${business_id}&status=eq.published&order=published_at.desc&limit=1&select=content_theme`
            );
            useTopic = latest[0]?.content_theme || `${biz.industry} tips for ${biz.target_audience || 'customers'}`;
          } catch {
            useTopic = `${biz.industry} tips`;
          }
        }

        // Brand voice context
        const brandContext = await getBrandExamples(
          business_id,
          'social_post',
          `${biz.business_name} ${useTopic} video`
        );

        const platformLabel = { tiktok: 'TikTok', instagram_reel: 'Instagram Reel', youtube_short: 'YouTube Short' }[
          platform
        ];

        const prompt = `${brandContext}Write a ${platformLabel} video script for ${biz.business_name} (${biz.industry}).
  Topic: "${useTopic}"
  Tone: ${biz.brand_tone || 'energetic and authentic'} | Audience: ${biz.target_audience || 'general consumers'}
  
  Return ONLY valid JSON:
  {
    "scenes": [
      { "name": "hook",     "text": "...", "duration_sec": 3  },
      { "name": "problem",  "text": "...", "duration_sec": 7  },
      { "name": "solution", "text": "...", "duration_sec": 20 },
      { "name": "proof",    "text": "...", "duration_sec": 10 },
      { "name": "cta",      "text": "...", "duration_sec": 5  }
    ],
    "caption": "150 chars max, punchy",
    "hashtags": ["#tag1","#tag2","#tag3","#tag4","#tag5","#tag6","#tag7"],
    "thumbnail_text": "5 words max for overlay"
  }`;

        const script = await callClaude(prompt, 'strategy', 1000);

        // Generate thumbnail via Flux → save to Supabase Storage
        let thumbnail_url = null;
        const thumbPrompt = `${script.thumbnail_text || useTopic} — ${biz.business_name}, vibrant ${platform} thumbnail, bold text overlay, 9:16 vertical`;
        try {
          const img = await generateImage(thumbPrompt, `${biz.industry} social media`);
          thumbnail_url = img?.url ? await saveImageToSupabase(img.url, business_id) : null;
        } catch {
          /* soft-fail */
        }

        // Save to video_generations
        const row = await sbPost('video_generations', {
          business_id,
          platform,
          script: script,
          caption: script.caption || '',
          hashtags: script.hashtags || [],
          thumbnail_url,
          status: 'script_ready',
        });

        // Send email notification
        if (biz.email) {
          const html = `<h2>Your ${platformLabel} script is ready!</h2>
  <p><strong>Topic:</strong> ${useTopic}</p>
  <p><strong>Hook:</strong> "${(script.scenes || [])[0]?.text || ''}"</p>
  <p><strong>Caption:</strong> ${script.caption || ''}</p>
  ${thumbnail_url ? `<img src="${thumbnail_url}" style="max-width:300px;border-radius:8px"><br>` : ''}
  <p><a href="https://maroa.ai/video" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">View & Film</a></p>`;
          await sendEmail(
            biz.email,
            `Your ${platformLabel} script is ready: "${script.thumbnail_text || useTopic}"`,
            html
          ).catch(() => {});
        }

        log('/webhook/video-script-generate', `✅ ${platform} script saved | id: ${row?.id} | topic: ${useTopic}`);
      } catch (err) {
        console.error('[video-script-generate ERROR]', err.message);
        await logError(business_id, 'video-script-generate', err.message, req.body).catch(() => {});
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/video-generate-runway
  // Submit scenes to Runway Gen-3 Alpha for video generation.
  // Body: { business_id, video_id }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/video-generate-runway', async (req, res) => {
    const { business_id, video_id } = req.body;
    if (!video_id) return res.status(400).json({ error: 'video_id required' });

    if (!RUNWAY_API_KEY)
      return res.json({ skipped: true, reason: 'RUNWAY_API_KEY not set — set it in Railway environment variables' });

    try {
      const rows = await sbGet('video_generations', `id=eq.${video_id}&select=*`);
      const vid = rows[0];
      if (!vid) return res.status(404).json({ error: 'video not found' });

      const scenes = (vid.script?.scenes || []).slice(0, 5);
      const taskIds = [];

      for (const scene of scenes) {
        try {
          const r = await apiRequest(
            'POST',
            'https://api.dev.runwayml.com/v1/image_to_video',
            {
              Authorization: `Bearer ${RUNWAY_API_KEY}`,
              'Content-Type': 'application/json',
              'X-Runway-Version': '2024-11-06',
            },
            {
              promptText: `${scene.text} — cinematic, vertical 9:16 format, professional quality`,
              duration: Math.min(scene.duration_sec || 4, 10),
              ratio: '720:1280',
              ...(vid.thumbnail_url ? { promptImage: vid.thumbnail_url } : {}),
            }
          );
          if (r.body?.id) taskIds.push({ scene: scene.name, task_id: r.body.id });
        } catch (e) {
          log('/webhook/video-generate-runway', `scene "${scene.name}" error: ${e.message}`);
        }
      }

      await sbPatch('video_generations', `id=eq.${video_id}`, {
        runway_task_id: JSON.stringify(taskIds),
        status: taskIds.length ? 'generating' : 'failed',
      });

      res.json({
        task_ids: taskIds,
        status: taskIds.length ? 'generating' : 'failed',
        check_back_in: '2 minutes',
        video_id,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /webhook/video-status?video_id=X
  // Poll Runway task status; update DB when complete.
  // ─────────────────────────────────────────────────────────────────────────────
  app.get('/webhook/video-status', async (req, res) => {
    const { video_id } = req.query;
    if (!video_id) return res.status(400).json({ error: 'video_id required' });
    try {
      const rows = await sbGet('video_generations', `id=eq.${video_id}&select=*`);
      const vid = rows[0];
      if (!vid) return res.status(404).json({ error: 'video not found' });

      // If no runway task or already done, return current state
      if (!vid.runway_task_id || vid.status === 'ready' || vid.status === 'published') {
        return res.json({ video_id, status: vid.status, video_url: vid.video_url, thumbnail_url: vid.thumbnail_url });
      }

      if (!RUNWAY_API_KEY) return res.json({ video_id, status: vid.status, note: 'RUNWAY_API_KEY not configured' });

      // Poll each task (handle single string or JSON array)
      let taskIds = [];
      try {
        taskIds = JSON.parse(vid.runway_task_id);
      } catch {
        taskIds = vid.runway_task_id ? [vid.runway_task_id] : [];
      }
      if (!Array.isArray(taskIds)) taskIds = [taskIds];
      const completedUrls = [];

      for (const t of taskIds) {
        try {
          const r = await apiRequest('GET', `https://api.dev.runwayml.com/v1/tasks/${t.task_id}`, {
            Authorization: `Bearer ${RUNWAY_API_KEY}`,
            'X-Runway-Version': '2024-11-06',
          });
          if (r.body?.status === 'SUCCEEDED' && r.body?.output?.[0]) {
            completedUrls.push({ scene: t.scene, url: r.body.output[0] });
          }
        } catch {
          /* soft-fail */
        }
      }

      const allDone = completedUrls.length === taskIds.length && taskIds.length > 0;
      if (allDone) {
        const videoUrl = completedUrls[0]?.url || null;
        await sbPatch('video_generations', `id=eq.${video_id}`, { video_url: videoUrl, status: 'ready' });
        return res.json({
          video_id,
          status: 'ready',
          video_url: videoUrl,
          thumbnail_url: vid.thumbnail_url,
          scenes_ready: completedUrls,
        });
      }

      res.json({
        video_id,
        status: vid.status,
        completed_scenes: completedUrls.length,
        total_scenes: taskIds.length,
        check_back_in: '60 seconds',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /webhook/videos-get?business_id=X
  // ─────────────────────────────────────────────────────────────────────────────
  app.get('/webhook/videos-get', async (req, res) => {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    try {
      const videos = await sbGet('video_generations', `business_id=eq.${business_id}&order=created_at.desc&limit=20`);

      // Add hook preview to each video
      const enriched = videos.map((v) => ({
        ...v,
        hook_preview: v.script?.scenes?.[0]?.text || '',
        scene_count: (v.script?.scenes || []).length,
      }));

      const summary = {
        total: videos.length,
        script_ready: videos.filter((v) => v.status === 'script_ready').length,
        generating: videos.filter((v) => v.status === 'generating').length,
        ready: videos.filter((v) => v.status === 'ready').length,
        published: videos.filter((v) => v.status === 'published').length,
        by_platform: videos.reduce((acc, v) => {
          acc[v.platform] = (acc[v.platform] || 0) + 1;
          return acc;
        }, {}),
      };

      res.json({ videos: enriched, summary });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { register };
