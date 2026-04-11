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
  const HIGGSFIELD_API_BASE = clean(process.env.HIGGSFIELD_API_BASE) || 'https://platform.higgsfield.ai';

  const PATH_SOUL = '/higgsfield-ai/soul/standard';
  const PATH_KLING = '/higgsfield-ai/kling/standard';
  const PATH_SORA = '/higgsfield-ai/sora/standard';

  const POLL_INTERVAL_MS = 5000;
  const IMAGE_JOB_TIMEOUT_MS = 3 * 60 * 1000;
  const VIDEO_JOB_TIMEOUT_MS = 5 * 60 * 1000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Full URL for a path on HIGGSFIELD_API_BASE (debug logging). */
  function higgsfieldUrl(path) {
    return path.startsWith('http') ? path : `${HIGGSFIELD_API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  /** Authorization: Key id:abcd**** (first 4 chars of secret only). */
  function logAuthHeaderPreview() {
    const id = HIGGSFIELD_API_KEY_ID || '(missing)';
    const sec = HIGGSFIELD_API_KEY_SECRET || '';
    const pre = sec.length >= 4 ? sec.slice(0, 4) : sec || '****';
    return `Key ${id}:${pre}****`;
  }

  function safeStringify(obj, maxLen = 65536) {
    try {
      const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
      return s.length > maxLen ? `${s.slice(0, maxLen)}...[truncated ${s.length - maxLen} chars]` : s;
    } catch {
      return String(obj);
    }
  }

  function keyAuthHeaders() {
    if (!HIGGSFIELD_API_KEY_ID || !HIGGSFIELD_API_KEY_SECRET) {
      throw new Error('Higgsfield credentials not configured (HIGGSFIELD_API_KEY_ID / HIGGSFIELD_API_KEY_SECRET)');
    }
    return {
      Authorization: `Key ${HIGGSFIELD_API_KEY_ID}:${HIGGSFIELD_API_KEY_SECRET}`,
      'Content-Type': 'application/json'
    };
  }

  function parseJsonBody(body) {
    if (body == null) return {};
    if (typeof body === 'object') return body;
    if (typeof body === 'string') {
      try { return JSON.parse(body); } catch { return {}; }
    }
    return {};
  }

  function extractRequestId(resBody) {
    const b = parseJsonBody(resBody);
    return b.request_id || b.requestId || b.id || b.data?.request_id || b.data?.id || null;
  }

  function statusNorm(body) {
    const s = body.status || body.state || body.request_status;
    return s ? String(s).toLowerCase() : '';
  }

  function extractImageResultUrl(body) {
    const b = parseJsonBody(body);
    const result = b.result !== undefined ? b.result : b;
    const u = result?.images?.[0]?.url;
    return u && String(u).startsWith('http') ? u : null;
  }

  function extractVideoResultUrl(body) {
    const b = parseJsonBody(body);
    const result = b.result !== undefined ? b.result : b;
    const u = result?.video?.url;
    return u && String(u).startsWith('http') ? u : null;
  }

  async function hfPost(path, body, timeoutMs = 120000) {
    const headers = keyAuthHeaders();
    const url = higgsfieldUrl(path);
    return apiRequest('POST', url, headers, body, timeoutMs);
  }

  async function hfGet(path, timeoutMs = 60000) {
    const headers = keyAuthHeaders();
    const url = higgsfieldUrl(path);
    return apiRequest('GET', url, headers, null, timeoutMs);
  }

  /**
   * Poll GET /requests/{request_id}/status until completed, failed, nsfw, or timeout.
   * @param {'image'|'video'} kind
   */
  async function pollRequestStatus(requestId, kind, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const statusPath = `/requests/${requestId}/status`;
    const statusUrl = higgsfieldUrl(statusPath);
    let lastHttp = null;
    let lastBodySnapshot = null;
    await sleep(POLL_INTERVAL_MS);
    while (Date.now() < deadline) {
      let r;
      try {
        r = await hfGet(statusPath);
      } catch (err) {
        console.error('[higgsfield:pollRequestStatus] hfGet threw', { statusUrl, requestId, message: err.message });
        console.error(err.stack);
        throw err;
      }
      lastHttp = r.status;
      const body = parseJsonBody(r.body);
      lastBodySnapshot = body;

      if (r.status < 200 || r.status >= 300) {
        console.error('[higgsfield:pollRequestStatus] GET non-success', {
          statusUrl,
          requestId,
          httpStatus: r.status,
          body: safeStringify(r.body)
        });
        throw new Error(`Higgsfield status poll HTTP ${r.status}`);
      }

      const st = statusNorm(body);

      if (st === 'failed' || st === 'nsfw') {
        console.error('[higgsfield:pollRequestStatus] terminal status', {
          statusUrl,
          requestId,
          jobStatus: st,
          body: safeStringify(body)
        });
        const err = new Error(body.message || body.error || `Higgsfield job ${st}`);
        err.code = st;
        throw err;
      }

      if (st === 'completed') {
        const url = kind === 'image' ? extractImageResultUrl(body) : extractVideoResultUrl(body);
        if (url) return url;
        const fallback =
          kind === 'image' ? extractImageResultUrl(body.result || body) : extractVideoResultUrl(body.result || body);
        if (fallback) return fallback;
        console.error('[higgsfield:pollRequestStatus] completed but no result URL', {
          statusUrl,
          requestId,
          kind,
          body: safeStringify(body)
        });
        throw new Error('Higgsfield completed but no result URL in response');
      }

      await sleep(POLL_INTERVAL_MS);
    }
    console.error('[higgsfield:pollRequestStatus] TIMEOUT', {
      statusUrl,
      requestId,
      timeoutMs,
      lastHttp,
      lastBody: safeStringify(lastBodySnapshot)
    });
    throw new Error('Higgsfield job timeout');
  }

  async function submitSoulAndWait(payload) {
    const postUrl = higgsfieldUrl(PATH_SOUL);
    console.error('[higgsfield:submitSoulAndWait] POST', postUrl);
    console.error('[higgsfield:submitSoulAndWait] Authorization (masked):', logAuthHeaderPreview());
    console.error('[higgsfield:submitSoulAndWait] request body:', safeStringify(payload));

    let r;
    try {
      r = await hfPost(PATH_SOUL, payload);
    } catch (err) {
      console.error('[higgsfield:submitSoulAndWait] hfPost exception:', err && err.message);
      console.error(err && err.stack);
      throw err;
    }

    if (r.status < 200 || r.status >= 300) {
      console.error('[higgsfield:submitSoulAndWait] HTTP error status:', r.status);
      console.error('[higgsfield:submitSoulAndWait] HTTP error body:', safeStringify(r.body));
      const detail = typeof r.body === 'object' ? JSON.stringify(r.body).slice(0, 400) : String(r.body);
      throw new Error(`Higgsfield Soul submit failed: HTTP ${r.status} ${detail}`);
    }

    const body = parseJsonBody(r.body);
    const rid = extractRequestId(body);
    const doneUrl = extractImageResultUrl(body);
    if (statusNorm(body) === 'completed' && doneUrl) return doneUrl;
    if (!rid) {
      if (doneUrl) return doneUrl;
      console.error('[higgsfield:submitSoulAndWait] missing request_id; parsed body:', safeStringify(body));
      throw new Error('Higgsfield Soul did not return request_id');
    }

    try {
      return await pollRequestStatus(rid, 'image', IMAGE_JOB_TIMEOUT_MS);
    } catch (err) {
      console.error('[higgsfield:submitSoulAndWait] pollRequestStatus failed:', err && err.message);
      console.error(err && err.stack);
      throw err;
    }
  }

  async function submitVideoAndWait(path, payload) {
    const postUrl = higgsfieldUrl(path);
    console.error('[higgsfield:submitVideoAndWait] POST', postUrl);
    console.error('[higgsfield:submitVideoAndWait] Authorization (masked):', logAuthHeaderPreview());
    console.error('[higgsfield:submitVideoAndWait] request body:', safeStringify(payload));

    let r;
    try {
      r = await hfPost(path, payload);
    } catch (err) {
      console.error('[higgsfield:submitVideoAndWait] hfPost exception:', err && err.message);
      console.error(err && err.stack);
      throw err;
    }

    if (r.status < 200 || r.status >= 300) {
      console.error('[higgsfield:submitVideoAndWait] HTTP error status:', r.status);
      console.error('[higgsfield:submitVideoAndWait] HTTP error body:', safeStringify(r.body));
      const detail = typeof r.body === 'object' ? JSON.stringify(r.body).slice(0, 400) : String(r.body);
      throw new Error(`Higgsfield video submit failed: HTTP ${r.status} ${detail}`);
    }

    const body = parseJsonBody(r.body);
    const rid = extractRequestId(body);
    const doneUrl = extractVideoResultUrl(body);
    if (statusNorm(body) === 'completed' && doneUrl) return doneUrl;
    if (!rid) {
      if (doneUrl) return doneUrl;
      console.error('[higgsfield:submitVideoAndWait] missing request_id; parsed body:', safeStringify(body));
      throw new Error('Higgsfield video job did not return request_id');
    }

    try {
      return await pollRequestStatus(rid, 'video', VIDEO_JOB_TIMEOUT_MS);
    } catch (err) {
      console.error('[higgsfield:submitVideoAndWait] pollRequestStatus failed:', err && err.message);
      console.error(err && err.stack);
      throw err;
    }
  }

  async function cancelRequest(requestId) {
    if (!requestId) return;
    try {
      await hfPost(`/requests/${requestId}/cancel`, {});
    } catch (e) {
      console.error('[higgsfield:cancelRequest] failed', { request_id: requestId, message: e.message });
      console.error(e.stack);
      logger.warn('higgsfield', null, 'cancel failed', { request_id: requestId, message: e.message });
    }
  }

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

  async function nicheSerpContext(brandDNA) {
    const niche = brandDNA?.industry || 'marketing';
    const q1 = `best performing ${niche} Instagram content 2025`;
    const q2 = `${niche} social media visual trends`;
    const [a, b] = await Promise.all([serpSearch(q1, 5), serpSearch(q2, 5)]);
    const lines = [...(a || []), ...(b || [])].map((r) => `- ${r.title}: ${r.snippet}`).slice(0, 12);
    return lines.join('\n');
  }

  async function generateProductImage(productImageUrl, brandDNA, options = {}) {
    if (!productImageUrl) throw new Error('productImageUrl required');
    const overridePrompt = typeof options.prompt === 'string' ? options.prompt.trim() : '';

    function buildSoulPayload(promptText, aspectRatio) {
      const p = {
        prompt: promptText,
        aspect_ratio: aspectRatio,
        resolution: '1080p'
      };
      if (productImageUrl.startsWith('http')) p.image_url = productImageUrl;
      return p;
    }

    if (overridePrompt) {
      const aspects = ['1:1', '9:16', '4:5'];
      const urls = [];
      for (let i = 0; i < 3; i++) {
        try {
          const url = await submitSoulAndWait(buildSoulPayload(overridePrompt, aspects[i] || '1:1'));
          if (url) urls.push(url);
        } catch (e) {
          console.error('[higgsfield:generateProductImage] soul generation failed (prompt override)', { index: i, message: e.message });
          console.error(e.stack);
          logger.warn('higgsfield', null, 'soul generation failed (prompt override)', { message: e.message, index: i });
        }
      }
      return urls.filter(Boolean);
    }

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
    const aspects = ['1:1', '9:16', '4:5'];
    const urls = [];
    for (let i = 0; i < 3; i++) {
      const prompt = plan.three_prompts[i] || bestPrompt;
      try {
        const url = await submitSoulAndWait(buildSoulPayload(prompt, aspects[i] || '1:1'));
        if (url) urls.push(url);
      } catch (e) {
        console.error('[higgsfield:generateProductImage] soul generation failed', { index: i, message: e.message });
        console.error(e.stack);
        logger.warn('higgsfield', null, 'soul generation failed', { message: e.message, index: i });
      }
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
    const payload = {
      prompt: parsed.prompt,
      image_url: productImageUrl,
      aspect_ratio: '9:16',
      resolution: '720p'
    };
    return submitVideoAndWait(PATH_KLING, payload);
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
    const payload = {
      prompt: parsed.full_prompt || parsed.prompt,
      image_url: productImageUrl,
      aspect_ratio: '9:16',
      resolution: '720p'
    };
    return submitVideoAndWait(PATH_SORA, payload);
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
          const url = await submitSoulAndWait({
            prompt: np,
            aspect_ratio: '1:1',
            resolution: '1080p'
          });
          if (url) currentImage = url;
        } catch (e) {
          console.error('[higgsfield:scoreContent] score regen soul failed', e.message);
          console.error(e.stack);
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
          console.error('[higgsfield:processProductCatalog] generateProductImage', e.message);
          console.error(e.stack);
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
              console.error('[higgsfield:processProductCatalog] kling', e.message);
              console.error(e.stack);
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
            console.error('[higgsfield:processProductCatalog] sora', e.message);
            console.error(e.stack);
            out.errors.push({ step: 'sora', message: e.message });
          }
        }

        for (const k of kept) {
          try {
            const cap = await generateCaption(k.url, brandDNA, 'instagram', k.score, { plan });
            out.items.push({ type: 'caption', image: k.url, ...cap });
          } catch (e) {
            console.error('[higgsfield:processProductCatalog] caption', e.message);
            console.error(e.stack);
            out.errors.push({ step: 'caption', message: e.message });
          }
        }
      } catch (e) {
        console.error('[higgsfield:processProductCatalog] product_loop', e.message);
        console.error(e.stack);
        out.errors.push({ step: 'product_loop', message: e.message });
      }
    }

    out.average_score = scoreN ? Math.round((scoreSum / scoreN) * 10) / 10 : 0;
    try {
      out.schedule_preview = await schedule30DaysClaude(out.items, brandDNA);
    } catch (e) {
      console.error('[higgsfield:processProductCatalog] schedule30DaysClaude', e.message);
      console.error(e.stack);
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
    processProductCatalog,
    cancelRequest
  };
};
