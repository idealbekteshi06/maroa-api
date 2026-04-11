'use strict';

/**
 * Higgsfield + Claude orchestration for product creatives.
 * Factory receives server deps to avoid circular requires.
 */
module.exports = function createHiggsfieldService(deps) {
  const {
    apiRequest,
    serpSearch,
    logger,
    extractJSON,
    sbGet,
    sbPost,
    ANTHROPIC_KEY,
    SERPAPI_KEY,
    SUPABASE_URL
  } = deps;

  const clean = (v) => (v || '').replace(/[^\x20-\x7E]/g, '').trim();
  const HIGGSFIELD_API_KEY_ID = clean(process.env.HIGGSFIELD_API_KEY_ID || '');
  const HIGGSFIELD_API_KEY_SECRET = clean(process.env.HIGGSFIELD_API_KEY_SECRET || '');
  const HIGGSFIELD_AUTH_URL = clean(process.env.HIGGSFIELD_AUTH_URL) || 'https://cloud.higgsfield.ai/v1/auth/token';
  const HIGGSFIELD_API_BASE = clean(process.env.HIGGSFIELD_API_BASE) || 'https://platform.higgsfield.ai';
  const HIGGSFIELD_SOUL_PATH = process.env.HIGGSFIELD_SOUL_PATH || '/v1/text2image/soul';
  const HIGGSFIELD_KLING_PATH = process.env.HIGGSFIELD_KLING_PATH || '/v1/video/kling';
  const HIGGSFIELD_SORA_PATH = process.env.HIGGSFIELD_SORA_PATH || '/v1/video/sora2';
  const HIGGSFIELD_POLL_PATH = process.env.HIGGSFIELD_POLL_PATH || '/v1/jobs'; // GET /v1/jobs/:id

  let tokenCache = { accessToken: null, expiresAt: 0 };

  function brandText(brandDNA) {
    const b = brandDNA || {};
    return [
      b.industry && `Industry: ${b.industry}`,
      b.tone && `Brand tone: ${b.tone}`,
      b.audience && `Audience: ${b.audience}`,
      Array.isArray(b.competitors) && b.competitors.length && `Competitors: ${b.competitors.join(', ')}`,
      b.trends && `Trends: ${b.trends}`
    ].filter(Boolean).join('\n');
  }

  async function claudeVision(prompt, imageUrls, opts = {}) {
    if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_KEY not configured');
    const model = opts.model || 'claude-sonnet-4-5';
    const max_tokens = opts.max_tokens || 4096;
    const content = [];
    for (const url of imageUrls || []) {
      if (!url || typeof url !== 'string') continue;
      content.push({
        type: 'image',
        source: { type: 'url', url }
      });
    }
    content.push({ type: 'text', text: prompt });
    const body = { model, max_tokens, messages: [{ role: 'user', content }] };
    if (opts.system) body.system = opts.system;
    const r = await apiRequest('POST', 'https://api.anthropic.com/v1/messages', {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    }, body, opts.timeoutMs || 120000);
    if (r.status !== 200) {
      const err = new Error(`Claude vision ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
      err.status = r.status;
      throw err;
    }
    return r.body?.content?.[0]?.text || '';
  }

  async function claudeText(prompt, taskType, maxTok, extra = {}) {
    if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_KEY not configured');
    const body = {
      model: extra.model || 'claude-sonnet-4-5',
      max_tokens: maxTok || 4096,
      messages: [{ role: 'user', content: prompt }]
    };
    if (extra.system) body.system = extra.system;
    const r = await apiRequest('POST', 'https://api.anthropic.com/v1/messages', {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    }, body, extra.timeoutMs || 120000);
    if (r.status !== 200) throw new Error(`Claude ${r.status}`);
    const raw = r.body?.content?.[0]?.text || '';
    if (extra.returnRaw) return raw;
    return extractJSON(raw) || { _raw: raw };
  }

  async function refreshBearerToken() {
    if (!HIGGSFIELD_API_KEY_ID || !HIGGSFIELD_API_KEY_SECRET) return null;
    const bodies = [
      { api_key_id: HIGGSFIELD_API_KEY_ID, api_key_secret: HIGGSFIELD_API_KEY_SECRET },
      { client_id: HIGGSFIELD_API_KEY_ID, client_secret: HIGGSFIELD_API_KEY_SECRET },
      { key_id: HIGGSFIELD_API_KEY_ID, secret: HIGGSFIELD_API_KEY_SECRET }
    ];
    for (const b of bodies) {
      try {
        const r = await apiRequest('POST', HIGGSFIELD_AUTH_URL, { 'Content-Type': 'application/json' }, b, 30000);
        if (r.status >= 200 && r.status < 300 && r.body) {
          const tok = r.body.access_token || r.body.token || r.body.accessToken;
          const expSec = r.body.expires_in || r.body.expiresIn || 3600;
          if (tok) {
            tokenCache = {
              accessToken: tok,
              expiresAt: Date.now() + Math.max(60, expSec - 60) * 1000
            };
            return tok;
          }
        }
      } catch (e) {
        logger.warn('higgsfield', null, 'token attempt failed', { message: e.message });
      }
    }
    return null;
  }

  async function getAuthHeaders() {
    if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt) {
      return { Authorization: `Bearer ${tokenCache.accessToken}`, 'Content-Type': 'application/json' };
    }
    const t = await refreshBearerToken();
    if (t) return { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' };
    if (HIGGSFIELD_API_KEY_ID && HIGGSFIELD_API_KEY_SECRET) {
      return {
        'hf-api-key': HIGGSFIELD_API_KEY_ID,
        'hf-secret': HIGGSFIELD_API_KEY_SECRET,
        'Content-Type': 'application/json'
      };
    }
    throw new Error('Higgsfield credentials not configured');
  }

  async function hfPost(path, body, timeoutMs = 120000) {
    const headers = await getAuthHeaders();
    const url = path.startsWith('http') ? path : `${HIGGSFIELD_API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
    return apiRequest('POST', url, headers, body, timeoutMs);
  }

  async function hfGet(path, timeoutMs = 60000) {
    const headers = await getAuthHeaders();
    const url = path.startsWith('http') ? path : `${HIGGSFIELD_API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
    return apiRequest('GET', url, headers, null, timeoutMs);
  }

  function extractJobId(resBody) {
    if (!resBody || typeof resBody !== 'object') return null;
    return resBody.id || resBody.job_id || resBody.jobId || resBody.data?.id || resBody.job?.id;
  }

  function extractImageUrls(resBody) {
    const out = [];
    const scan = (o) => {
      if (!o) return;
      if (typeof o === 'string' && o.startsWith('http')) out.push(o);
      if (Array.isArray(o)) o.forEach(scan);
      if (typeof o === 'object') {
        if (o.url && typeof o.url === 'string' && o.url.startsWith('http')) out.push(o.url);
        if (o.raw?.url) out.push(o.raw.url);
        ['results', 'images', 'outputs', 'jobs', 'data'].forEach((k) => o[k] && scan(o[k]));
      }
    };
    scan(resBody);
    return [...new Set(out)];
  }

  function extractVideoUrl(resBody) {
    if (!resBody) return null;
    const tryKeys = (o) => {
      if (!o || typeof o !== 'object') return null;
      for (const k of ['video_url', 'videoUrl', 'url', 'output_url', 'result_url']) {
        if (o[k] && String(o[k]).startsWith('http')) return o[k];
      }
      if (o.raw?.url && String(o.raw.url).startsWith('http')) return o.raw.url;
      if (o.result?.url) return o.result.url;
      return null;
    };
    let v = tryKeys(resBody);
    if (v) return v;
    if (resBody.jobs?.[0]) v = tryKeys(resBody.jobs[0]);
    if (v) return v;
    if (resBody.data) v = tryKeys(resBody.data);
    return v || null;
  }

  async function pollJob(jobId, intervalMs, timeoutMs, extractFn) {
    const start = Date.now();
    let path = `${HIGGSFIELD_POLL_PATH}/${jobId}`;
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, intervalMs));
      try {
        const r = await hfGet(path);
        let body = r.body;
        if (typeof body === 'string') {
          try { body = JSON.parse(body); } catch { /* ignore */ }
        }
        const done = body?.status === 'completed' || body?.state === 'completed' || body?.done === true;
        const failed = body?.status === 'failed' || body?.state === 'failed';
        if (failed) throw new Error(body?.error || 'Higgsfield job failed');
        const url = extractFn(body);
        if (done && url) return url;
        if (url && (body?.progress === 1 || body?.percent === 100)) return url;
      } catch (e) {
        if (String(e.message).includes('failed')) throw e;
      }
    }
    throw new Error('Higgsfield job timeout');
  }

  async function nicheSerpContext(brandDNA) {
    const niche = brandDNA?.industry || 'marketing';
    const q1 = `best performing ${niche} Instagram content 2025`;
    const q2 = `${niche} social media visual trends`;
    const [a, b] = await Promise.all([serpSearch(q1, 5), serpSearch(q2, 5)]);
    const lines = [...(a || []), ...(b || [])].map((r) => `- ${r.title}: ${r.snippet}`).slice(0, 12);
    return lines.join('\n');
  }

  async function generateProductImage(productImageUrl, brandDNA) {
    if (!productImageUrl) throw new Error('productImageUrl required');
    const serpCtx = await nicheSerpContext(brandDNA || {});
    const analysisPrompt =
      `You are a senior art director. Analyze the product reference image (attached) and this brand DNA:\n${brandText(brandDNA)}\n\n` +
      `Top SERP signals in niche:\n${serpCtx}\n\n` +
      `Return ONLY valid JSON with keys: product_summary (string), three_prompts (array of 3 strings) for Soul image-to-image. ` +
      `Each prompt must optimize for: professional studio lighting, brand-consistent style, and these aspect intents: square 1:1, vertical 9:16, feed 4:5. ` +
      `Mention lighting, backdrop, and trend-aware styling.`;

    const raw = await claudeVision(analysisPrompt, [productImageUrl], { max_tokens: 4096 });
    let plan = extractJSON(raw);
    if (!plan?.three_prompts?.length) {
      plan = {
        three_prompts: [
          `${brandDNA?.industry || 'product'} hero shot, soft studio light, 1:1, ultra clean`,
          `${brandDNA?.industry || 'product'} lifestyle, rim light, 9:16 vertical, editorial`,
          `${brandDNA?.industry || 'product'} premium still life, softbox, 4:5, muted palette`
        ]
      };
    }
    const bestPrompt = plan.three_prompts[0];
    const sizes = ['1536x1536', '1080x1920', '1080x1350'];
    const urls = [];
    for (let i = 0; i < 3; i++) {
      const prompt = plan.three_prompts[i] || bestPrompt;
      const width_and_height = sizes[i] || '1536x1536';
      const payload = {
        prompt,
        width_and_height,
        quality: 'hd',
        batch_size: 1,
        input_image: { url: productImageUrl }
      };
      const r = await hfPost(HIGGSFIELD_SOUL_PATH, payload).catch(() => ({ status: 500, body: {} }));
      let jobId = extractJobId(r.body);
      let collected = extractImageUrls(r.body);
      if (jobId && !collected.length) {
        try {
          await pollJob(jobId, 3000, 120000, (b) => extractImageUrls(b)[0] || extractVideoUrl(b));
          const st = await hfGet(`${HIGGSFIELD_POLL_PATH}/${jobId}`);
          let stBody = st.body;
          if (typeof stBody === 'string') {
            try { stBody = JSON.parse(stBody); } catch { /* ignore */ }
          }
          collected = extractImageUrls(stBody);
        } catch { /* use sync urls */ }
      }
      if (!collected.length && r.status === 200) collected = extractImageUrls(r.body);
      urls.push(...collected.slice(0, 1));
    }
    return urls.filter(Boolean);
  }

  async function generateProductVideo(productImageUrl, brandDNA) {
    if (!productImageUrl) throw new Error('productImageUrl required');
    const motionPrompt = await claudeVision(
      `Analyze the product image. Brand: ${brandText(brandDNA)}\n\n` +
      'Write ONE cinematic motion prompt for image-to-video (Kling 3.0). ' +
      'Respect product type (food/fashion/tech), brand tone, and trending short-form pacing. ' +
      'Return JSON only: {"prompt":"...","duration_sec":8}',
      [productImageUrl],
      { max_tokens: 1500 }
    );
    const parsed = extractJSON(motionPrompt) || { prompt: 'Slow cinematic camera orbit, soft highlights, premium feel', duration_sec: 8 };
    const r = await hfPost(HIGGSFIELD_KLING_PATH, {
      prompt: parsed.prompt,
      input_image: productImageUrl,
      duration: parsed.duration_sec || 8,
      model: 'kling-3.0'
    });
    const jobId = extractJobId(r.body) || extractJobId(r.body?.data);
    if (!jobId) {
      const direct = extractVideoUrl(r.body);
      if (direct) return direct;
      throw new Error('Kling job did not return an id');
    }
    return pollJob(jobId, 5000, 180000, extractVideoUrl);
  }

  async function generateHeroAd(productImageUrl, brandDNA) {
    if (!productImageUrl) throw new Error('productImageUrl required');
    const script = await claudeVision(
      `You are a commercial director. Using the product image and brand DNA:\n${brandText(brandDNA)}\n\n` +
      'Write a 15s cinematic ad script with sections: hook 0-3s, reveal 3-8s, benefits 8-12s, CTA 12-15s. ' +
      'Return JSON only: {"full_prompt":"single paragraph combining all beats for video generation"}',
      [productImageUrl],
      { max_tokens: 2000 }
    );
    const parsed = extractJSON(script) || { full_prompt: 'Cinematic product ad, premium lighting, bold CTA endcard' };
    const r = await hfPost(HIGGSFIELD_SORA_PATH, {
      prompt: parsed.full_prompt || parsed.prompt,
      input_image: productImageUrl,
      model: 'sora-2',
      duration: 15
    });
    const jobId = extractJobId(r.body) || extractJobId(r.body?.data);
    if (!jobId) {
      const direct = extractVideoUrl(r.body);
      if (direct) return direct;
      throw new Error('Sora job did not return an id');
    }
    return pollJob(jobId, 10000, 300000, extractVideoUrl);
  }

  async function runScoreDimensions(imageUrl, videoUrl, caption, brandDNA, platformData) {
    const platformHint = typeof platformData === 'object' ? JSON.stringify(platformData) : String(platformData || '');
    const images = [imageUrl, videoUrl].filter((u) => u && u.startsWith('http'));
    const prompt =
      `Score this social asset for performance. Caption: ${caption || 'N/A'}\nBrand DNA:\n${brandText(brandDNA)}\nPlatform data: ${platformHint}\n\n` +
      `Return ONLY valid JSON with numeric dimensions (use half increments where needed):\n` +
      `{"hook_strength":0-2,"visual_quality":0-2,"brand_alignment":0-1,"trend_relevance":0-2,"cta_clarity":0-1,"engagement_potential":0-2,` +
      `"total":0-10,"notes":"short"}`;

    const rawText = images.length
      ? await claudeVision(prompt, images, { max_tokens: 1500 })
      : await claudeText(prompt, 'social_post', 1500, { returnRaw: true });

    const s = extractJSON(rawText) || {};
    const total =
      Number(s.total) ||
      (Number(s.hook_strength || 0) +
        Number(s.visual_quality || 0) +
        Number(s.brand_alignment || 0) +
        Number(s.trend_relevance || 0) +
        Number(s.cta_clarity || 0) +
        Number(s.engagement_potential || 0));
    return {
      hook_strength: Number(s.hook_strength) || 0,
      visual_quality: Number(s.visual_quality) || 0,
      brand_alignment: Number(s.brand_alignment) || 0,
      trend_relevance: Number(s.trend_relevance) || 0,
      cta_clarity: Number(s.cta_clarity) || 0,
      engagement_potential: Number(s.engagement_potential) || 0,
      total: Math.min(10, Math.max(0, total)),
      notes: s.notes || '',
      breakdown: s
    };
  }

  async function scoreContent(imageUrl, videoUrl, caption, brandDNA, platformData) {
    let currentImage = imageUrl;
    let last = await runScoreDimensions(currentImage, videoUrl, caption, brandDNA, platformData);
    const flags = { regeneration_attempts: 0, manual_review: false };
    let regenerationCount = 0;

    while (last.total < 7 && regenerationCount < 3) {
      regenerationCount++;
      flags.regeneration_attempts = regenerationCount;
      const fix = await claudeText(
        `Prior scores: ${JSON.stringify(last.breakdown || last)}. Improve the creative for a still image. ` +
          `Return JSON only: {"new_prompt":"...","focus":"which dimensions to fix"}`,
        'social_post',
        1200
      );
      const np = fix.new_prompt || fix.prompt;
      if (currentImage && np) {
        try {
          const r = await hfPost(HIGGSFIELD_SOUL_PATH, {
            prompt: np,
            width_and_height: '1536x1536',
            quality: 'hd',
            batch_size: 1,
            input_image: { url: currentImage }
          });
          const urls = extractImageUrls(r.body);
          if (urls[0]) currentImage = urls[0];
        } catch (e) {
          logger.warn('higgsfield', null, 'score regen soul failed', { message: e.message });
        }
      }
      last = await runScoreDimensions(currentImage, videoUrl, caption, brandDNA, platformData);
    }

    if (last.total < 7) flags.manual_review = true;

    let recommendation = 'post_immediately';
    if (last.total >= 9) recommendation = 'post_immediately';
    else if (last.total >= 7) recommendation = 'post_scheduled';
    else if (last.total >= 5) recommendation = 'regenerate';
    else recommendation = 'manual_review';

    return {
      imageUrl: currentImage,
      videoUrl,
      score: last,
      total: last.total,
      recommendation,
      flags
    };
  }

  async function generateCaption(imageUrl, brandDNA, platform, score, opts = {}) {
    const plan = (opts.plan || 'starter').toLowerCase();
    if (platform === 'linkedin' && plan !== 'agency') {
      const e = new Error('LinkedIn captions require Agency plan');
      e.status = 403;
      e.code = 'upgrade_required';
      throw e;
    }
    const serpCtx = await nicheSerpContext(brandDNA || {});
    const platformRules = {
      instagram: 'Instagram: one-line hook + 3-4 line story + CTA + 15-20 hashtags.',
      tiktok: 'TikTok: 1-2 punchy lines + exactly 5 trending hashtags.',
      facebook: 'Facebook: 4-6 line story + soft CTA.',
      linkedin: 'LinkedIn: professional insight + value + CTA (Agency tone).'
    };
    const pr = platformRules[platform] || platformRules.instagram;
    const prompt =
      `Create a ${platform} caption for this brand. Rules: ${pr}\n${brandText(brandDNA)}\n` +
      `Score context: ${JSON.stringify(score || {})}\nSERP niche hints:\n${serpCtx}\n\n` +
      `Return JSON only:\n` +
      `{"caption":"...","hashtags":["#..."],"suggested_posting_time":"ISO or description","hook":"..."}`;

    const raw = imageUrl
      ? await claudeVision(prompt, [imageUrl], { max_tokens: 2000 })
      : await claudeText(prompt, 'caption', 2000, { returnRaw: true });

    const c = extractJSON(raw) || { caption: String(raw).slice(0, 2000), hashtags: [], suggested_posting_time: '18:00 local' };
    return {
      caption: c.caption || '',
      hashtags: Array.isArray(c.hashtags) ? c.hashtags : [],
      suggested_posting_time: c.suggested_posting_time || 'evening',
      hook: c.hook || ''
    };
  }

  async function schedule30DaysClaude(pieces, brandDNA) {
    const raw = await claudeText(
      `Given these content pieces metadata ${JSON.stringify(pieces).slice(0, 12000)} and brand ${brandText(brandDNA)}, ` +
        `produce a 30-day posting schedule (one entry per day). Return JSON array only: [{day:1-30, platform:string, slot:string, content_index:number}].`,
      'strategy',
      4096,
      { returnRaw: true }
    );
    const parsed = extractJSON(raw);
    const arr = Array.isArray(parsed) ? parsed : parsed?.schedule;
    return Array.isArray(arr) ? arr : [];
  }

  function normalizePlan(plan) {
    const p = (plan || 'starter').toLowerCase();
    if (p === 'free') return 'starter';
    return p;
  }

  async function processProductCatalog(userId, businessId, productImages, brandDNA, options = {}) {
    const limits = options.planLimits || {};
    const plan = normalizePlan(options.plan || 'starter');
    const rem = {
      images: options.remaining?.images != null ? options.remaining.images : 999,
      kling: options.remaining?.kling != null ? options.remaining.kling : (limits.kling || 0),
      sora: options.remaining?.sora != null ? options.remaining.sora : (limits.sora || 0)
    };
    const out = {
      total_pieces: 0,
      average_score: 0,
      schedule_preview: [],
      items: [],
      errors: []
    };

    let scoreSum = 0;
    let scoreN = 0;

    for (const productImageUrl of productImages || []) {
      try {
        if (rem.images <= 0) {
          out.errors.push({ step: 'limit', message: 'Monthly image quota exhausted' });
          break;
        }
        const styled = await generateProductImage(productImageUrl, brandDNA).catch((e) => {
          out.errors.push({ step: 'generateProductImage', message: e.message });
          return [];
        });
        rem.images = Math.max(0, rem.images - (styled?.length || 0));
        const kept = [];
        for (const url of styled) {
          const sc = await scoreContent(url, null, '', brandDNA, {}).catch(() => null);
          if (sc && sc.total >= 7) {
            kept.push({ url, score: sc });
            scoreSum += sc.total;
            scoreN++;
            await sbPost('content_library', {
              user_id: userId,
              business_id: businessId,
              content_type: 'image',
              file_url: url,
              content_score: sc.total,
              score_breakdown: sc.score?.breakdown || sc.score,
              status: 'scheduled'
            }).catch(() => {});
            out.total_pieces++;
          }
        }

        if (['growth', 'agency'].includes(plan) && rem.kling > 0) {
          for (const k of kept.slice(0, 1)) {
            try {
              const vid = await generateProductVideo(k.url, brandDNA);
              rem.kling = Math.max(0, rem.kling - 1);
              out.total_pieces++;
              await sbPost('content_library', {
                user_id: userId,
                business_id: businessId,
                content_type: 'video_kling',
                file_url: vid,
                content_score: k.score?.total,
                status: 'scheduled'
              }).catch(() => {});
            } catch (e) {
              out.errors.push({ step: 'kling', message: e.message });
            }
          }
        }

        if (plan === 'agency' && kept[0] && rem.sora > 0) {
          try {
            const hero = await generateHeroAd(kept[0].url, brandDNA);
            rem.sora = Math.max(0, rem.sora - 1);
            out.total_pieces++;
            await sbPost('content_library', {
              user_id: userId,
              business_id: businessId,
              content_type: 'video_sora',
              file_url: hero,
              status: 'scheduled'
            }).catch(() => {});
          } catch (e) {
            out.errors.push({ step: 'sora', message: e.message });
          }
        }

        for (const k of kept) {
          try {
            const cap = await generateCaption(k.url, brandDNA, 'instagram', k.score, { plan });
            out.items.push({ type: 'caption', image: k.url, ...cap });
          } catch (e) {
            out.errors.push({ step: 'caption', message: e.message });
          }
        }
      } catch (e) {
        out.errors.push({ step: 'product_loop', message: e.message });
      }
    }

    out.average_score = scoreN ? Math.round((scoreSum / scoreN) * 10) / 10 : 0;
    try {
      out.schedule_preview = await schedule30DaysClaude(out.items, brandDNA);
    } catch {
      out.schedule_preview = [];
    }

    return out;
  }

  return {
    generateProductImage,
    generateProductVideo,
    generateHeroAd,
    scoreContent,
    generateCaption,
    processProductCatalog
  };
};
