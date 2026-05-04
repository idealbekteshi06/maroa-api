'use strict';

const https = require('https');
const http = require('http');
const hf = require('./prompts/higgsfield');
const vetter = require('./prompts/image-vetter');
const creative = require('./prompts/creative-director');

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
    SUPABASE_URL,
    SUPABASE_KEY
  } = deps;

  const CONTENT_IMAGES_BUCKET = 'content-images';

  const clean = (v) => (v || '').replace(/[^\x20-\x7E]/g, '').trim();
  const HIGGSFIELD_API_KEY_ID = clean(process.env.HIGGSFIELD_API_KEY_ID || '');
  const HIGGSFIELD_API_KEY_SECRET = clean(process.env.HIGGSFIELD_API_KEY_SECRET || '');
  const HIGGSFIELD_API_BASE = clean(process.env.HIGGSFIELD_API_BASE) || 'https://platform.higgsfield.ai';

  const PATH_SOUL = '/higgsfield-ai/soul/standard';
  const PATH_KLING = '/higgsfield-ai/kling/standard';
  const PATH_SORA = '/higgsfield-ai/sora/standard';
  // Phase 3 model expansion
  const PATH_DOP = process.env.HIGGSFIELD_PATH_DOP || '/higgsfield-ai/dop/standard';
  const PATH_DOP_TURBO = process.env.HIGGSFIELD_PATH_DOP_TURBO || '/higgsfield-ai/dop/turbo';
  const PATH_SEEDREAM = process.env.HIGGSFIELD_PATH_SEEDREAM || '/bytedance/seedream/v4/text-to-image';
  const PATH_SEEDREAM_EDIT = process.env.HIGGSFIELD_PATH_SEEDREAM_EDIT || '/bytedance/seedream/v4/edit';
  const PATH_SEEDANCE = process.env.HIGGSFIELD_PATH_SEEDANCE || '/bytedance/seedance/v1/pro/image-to-video';
  const PATH_VEO = process.env.HIGGSFIELD_PATH_VEO || '/google/veo/v3-1';
  const PATH_NANO_BANANA = process.env.HIGGSFIELD_PATH_NANO_BANANA || '/higgsfield-ai/nano-banana-2';
  const PATH_KLING_3 = process.env.HIGGSFIELD_PATH_KLING_3 || '/higgsfield-ai/kling/v3';
  // Soul ID character training
  const PATH_CHARACTER_CREATE = process.env.HIGGSFIELD_PATH_CHARACTER_CREATE || '/higgsfield-ai/soul/characters';
  const PATH_CHARACTER_STATUS = process.env.HIGGSFIELD_PATH_CHARACTER_STATUS || '/higgsfield-ai/soul/characters';

  const PATHS_BY_MODEL = {
    'soul 2.0': PATH_SOUL,
    'soul standard': PATH_SOUL,
    'kling 3.0': PATH_KLING_3,
    'kling 2.6': PATH_KLING,
    'sora 2': PATH_SORA,
    'higgsfield dop standard': PATH_DOP,
    'higgsfield dop turbo': PATH_DOP_TURBO,
    'seedream 4.5': PATH_SEEDREAM,
    'seedream edit': PATH_SEEDREAM_EDIT,
    'seedance 2.0': PATH_SEEDANCE,
    'veo 3.1': PATH_VEO,
    'nano banana 2': PATH_NANO_BANANA,
    'nano banana pro': PATH_NANO_BANANA
  };

  function pathForModel(modelId) {
    return PATHS_BY_MODEL[(modelId || '').toLowerCase()] || PATH_SOUL;
  }

  const POLL_INTERVAL_MS = 5000;
  const IMAGE_JOB_TIMEOUT_MS = 3 * 60 * 1000;
  const VIDEO_JOB_TIMEOUT_MS = 5 * 60 * 1000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function downloadImageBuffer(sourceUrl) {
    return new Promise((resolve, reject) => {
      const proto = sourceUrl.startsWith('https') ? https : http;
      proto.get(sourceUrl, { headers: { Accept: '*/*' } }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          return downloadImageBuffer(new URL(res.headers.location, sourceUrl).href).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) return reject(new Error(`Download failed: ${res.statusCode}`));
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  async function uploadBufferToContentImages(imgBuf, userId, index) {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase storage not configured');
    const ts = Date.now();
    const objectPath = `${userId}/${ts}-${index}.png`;
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${CONTENT_IMAGES_BUCKET}/${objectPath}`;
    const uploadResp = await new Promise((resolve, reject) => {
      const u = new URL(uploadUrl);
      const req = https.request(
        {
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname,
          method: 'POST',
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'image/png',
            'Content-Length': imgBuf.length,
            'x-upsert': 'false'
          }
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        }
      );
      req.on('error', reject);
      req.write(imgBuf);
      req.end();
    });
    if (uploadResp.status >= 200 && uploadResp.status < 300) {
      return `${SUPABASE_URL}/storage/v1/object/public/${CONTENT_IMAGES_BUCKET}/${objectPath}`;
    }
    throw new Error(`Upload failed: ${uploadResp.status} ${(uploadResp.body || '').slice(0, 200)}`);
  }

  /** Download Higgsfield CDN image and persist to Supabase Storage (public URL). */
  async function mirrorHiggsfieldImageToSupabase(hfUrl, userId, index) {
    const buf = await downloadImageBuffer(hfUrl);
    return uploadBufferToContentImages(buf, userId, index);
  }

  async function persistGeneratedImageUrl(hfUrl, userId, index) {
    if (!userId || !hfUrl || !hfUrl.startsWith('http')) return hfUrl;
    try {
      return await mirrorHiggsfieldImageToSupabase(hfUrl, userId, index);
    } catch (e) {
      logger.warn('higgsfield', null, 'mirror to content-images failed', { message: e.message, index });
      return hfUrl;
    }
  }

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
    const userId = options.userId || options.user_id || null;
    const contentTheme = options.contentTheme || options.content_theme || 'product hero';

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
          if (url) urls.push(await persistGeneratedImageUrl(url, userId, i));
        } catch (e) {
          console.error('[higgsfield:generateProductImage] soul generation failed (prompt override)', { index: i, message: e.message });
          console.error(e.stack);
          logger.warn('higgsfield', null, 'soul generation failed (prompt override)', { message: e.message, index: i });
        }
      }
      return urls.filter(Boolean);
    }

    const serpCtx = await nicheSerpContext(brandDNA || {});
    const brief = hf.buildImageBrief({
      brandDNA,
      contentTheme,
      productImageUrl,
      hasReferenceImage: true,
      isI2V: true
    });
    const userPrompt = `${brief.userTask}\n\nLive niche signals (last week SERP):\n${serpCtx}`;
    const raw = await claudeVision(userPrompt, [productImageUrl], { max_tokens: 4096, system: brief.system });
    const plan = extractJSON(raw) || {};
    const promptObjs = Array.isArray(plan.prompts) && plan.prompts.length
      ? plan.prompts
      : [
          { aspect_ratio: '1:1', prompt: `Macro shot, low angle, static. Product on raw concrete with soft window side-light. Style: Cinematic commercial, warm neutral tones, soft diffused light, sharp focus throughout, 1:1.` },
          { aspect_ratio: '9:16', prompt: `Selfie angle medium shot. Product held at arm's length, natural daylight, Editorial Street Style preset. Style: Lifestyle, warm neutral, 9:16.` },
          { aspect_ratio: '4:5', prompt: `Cowboy shot, eye-level, slight handheld. Product on wooden counter at golden hour, side-light from window left. Style: Lifestyle, Kodak Portra 400 grain, lifted shadows, 4:5.` }
        ];
    const aspects = ['1:1', '9:16', '4:5'];
    const urls = [];
    // Genre router picked the right model — use the dispatcher so it routes
    // to nano-banana-pro / soul / etc. instead of always Soul.
    const modelId = (brief.model && brief.model.id) || 'soul 2.0';
    const targetPath = pathForModel(modelId);
    for (let i = 0; i < 3; i++) {
      const obj = promptObjs[i] || promptObjs[0];
      const prompt = hf.killSlop(obj.prompt);
      try {
        const payload = buildSoulPayload(prompt, obj.aspect_ratio || aspects[i] || '1:1');
        // submitSoulAndWait hard-codes PATH_SOUL; route to the right path when it differs
        const url = targetPath === PATH_SOUL
          ? await submitSoulAndWait(payload)
          : await submitImageOnPath(targetPath, payload);
        if (url) urls.push(await persistGeneratedImageUrl(url, userId, i));
      } catch (e) {
        console.error('[higgsfield:generateProductImage] gen failed', { index: i, model: modelId, message: e.message });
        console.error(e.stack);
        logger.warn('higgsfield', null, 'gen failed', { message: e.message, index: i, model: modelId });
      }
    }
    return urls.filter(Boolean);
  }

  /**
   * Generic image submit + poll for any non-Soul image path. Mirrors
   * submitSoulAndWait but accepts the path explicitly.
   */
  async function submitImageOnPath(path, payload) {
    const r = await hfPost(path, payload);
    if (r.status < 200 || r.status >= 300) {
      console.error('[higgsfield:submitImageOnPath] HTTP', r.status, safeStringify(r.body));
      throw new Error(`Higgsfield ${path} HTTP ${r.status}`);
    }
    const body = parseJsonBody(r.body);
    const rid = extractRequestId(body);
    const doneUrl = extractImageResultUrl(body);
    if (statusNorm(body) === 'completed' && doneUrl) return doneUrl;
    if (!rid) {
      if (doneUrl) return doneUrl;
      throw new Error(`Higgsfield ${path} did not return request_id`);
    }
    return await pollRequestStatus(rid, 'image', IMAGE_JOB_TIMEOUT_MS);
  }

  async function generateProductVideo(productImageUrl, brandDNA, opts = {}) {
    if (!productImageUrl) throw new Error('productImageUrl required');
    const contentTheme = opts.contentTheme || opts.content_theme || 'product video reel';
    const brief = hf.buildVideoBrief({
      brandDNA,
      contentTheme,
      productImageUrl,
      isI2V: true,
      wantsAudio: false,
      durationSec: 8
    });
    const motionPrompt = await claudeVision(
      brief.userTask,
      [productImageUrl],
      { max_tokens: 2000, system: brief.system }
    );
    const parsed = extractJSON(motionPrompt) || {};
    const promptText = hf.killSlop(parsed.prompt || 'Product on a sunlit surface. Camera: slow Macro Dolly In. Style: Cinematic commercial, warm neutral, soft diffused window light, 9:16.');
    const payload = {
      prompt: promptText,
      image_url: productImageUrl,
      aspect_ratio: parsed.aspect_ratio || '9:16',
      resolution: '720p'
    };
    return submitVideoAndWait(PATH_KLING, payload);
  }

  async function generateHeroAd(productImageUrl, brandDNA, opts = {}) {
    if (!productImageUrl) throw new Error('productImageUrl required');
    const contentTheme = opts.contentTheme || opts.content_theme || 'hero ad commercial 15s';
    const brief = hf.buildHeroAdBrief({
      brandDNA,
      contentTheme,
      productImageUrl,
      isI2V: true
    });
    const script = await claudeVision(
      brief.userTask,
      [productImageUrl],
      { max_tokens: 2500, system: brief.system }
    );
    const parsed = extractJSON(script) || {};
    const promptText = hf.killSlop(parsed.prompt || 'Product hero on a sunlit surface. Camera: Robo Arm arcing slowly base to lid. Style: Cinematic commercial, warm neutral, soft diffused light, 9:16. Audio: gentle ambient, soft surface contact, single clean piano note on CTA.');
    const payload = {
      prompt: promptText,
      image_url: productImageUrl,
      aspect_ratio: parsed.aspect_ratio || '9:16',
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

  async function scoreContent(imageUrl, videoUrl, caption, brandDNA, platformData, mirrorOpts = {}) {
    const mirrorUserId = mirrorOpts.userId || mirrorOpts.user_id || null;
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
          if (url) currentImage = await persistGeneratedImageUrl(url, mirrorUserId, 100 + regenerationCount);
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
        const styled = await generateProductImage(productImageUrl, brandDNA, { userId }).catch((e) => {
          console.error('[higgsfield:processProductCatalog] generateProductImage', e.message);
          console.error(e.stack);
          out.errors.push({ step: 'generateProductImage', message: e.message });
          return [];
        });
        rem.images = Math.max(0, rem.images - (styled?.length || 0));
        const kept = [];
        for (const url of styled) {
          const sc = await scoreContent(url, null, '', brandDNA, {}, { userId }).catch(() => null);
          if (sc && sc.total >= 7) {
            const finalUrl = sc.imageUrl || url;
            kept.push({ url: finalUrl, score: sc });
            scoreSum += sc.total;
            scoreN++;
            await sbPost('content_library', {
              user_id: userId,
              business_id: businessId,
              content_type: 'image',
              file_url: finalUrl,
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

  /**
   * Vet a customer-uploaded image. Returns a verdict object:
   *   { verdict, total_100, scores, next_action, ... }
   *
   * verdict ∈ { use_as_is, enhance_via_higgsfield, regenerate_fresh, reject }
   *
   * When verdict is 'enhance_via_higgsfield', next_action.i2i_prompts is a
   * ready-to-submit array of { aspect_ratio, prompt } objects.
   */
  async function vetCustomerAsset(imageUrl, brandDNA, options = {}) {
    if (!imageUrl) throw new Error('imageUrl required');
    const contentTheme = options.contentTheme || options.content_theme || '';
    const req = vetter.buildVetterRequest({ brandDNA, contentTheme });
    const raw = await claudeVision(req.userTask, [imageUrl], {
      max_tokens: 2500,
      system: req.system,
      model: options.model || 'claude-sonnet-4-5'
    });
    const parsed = extractJSON(raw) || {};
    const verdict = vetter.synthesizeVerdict({
      rawVetterOutput: parsed,
      brandDNA,
      contentTheme
    });
    return verdict;
  }

  /**
   * Vet many images, group by verdict, ready for downstream routing.
   */
  async function vetCustomerAssetBatch(imageUrls, brandDNA, options = {}) {
    const out = { use_as_is: [], enhance_via_higgsfield: [], regenerate_fresh: [], reject: [], errors: [] };
    for (const url of imageUrls || []) {
      try {
        const v = await vetCustomerAsset(url, brandDNA, options);
        if (out[v.verdict]) out[v.verdict].push({ url, ...v });
        else out.errors.push({ url, error: `unknown verdict: ${v.verdict}` });
      } catch (e) {
        console.error('[higgsfield:vetCustomerAssetBatch] failed for', url, e.message);
        out.errors.push({ url, error: e.message });
      }
    }
    return out;
  }

  /**
   * Vet → Decide → Generate. Replaces the blind generateProductImage path
   * for callers who want the full intelligent pipeline.
   */
  async function smartProcessAsset(imageUrl, brandDNA, options = {}) {
    const verdict = await vetCustomerAsset(imageUrl, brandDNA, options);
    if (verdict.verdict === 'use_as_is') {
      return { verdict, generated: [imageUrl], path: 'use_as_is' };
    }
    if (verdict.verdict === 'reject') {
      return { verdict, generated: [], path: 'reject' };
    }
    if (verdict.verdict === 'enhance_via_higgsfield') {
      const userId = options.userId || options.user_id || null;
      const urls = [];
      for (let i = 0; i < verdict.next_action.i2i_prompts.length; i++) {
        const p = verdict.next_action.i2i_prompts[i];
        try {
          const out = await submitSoulAndWait({
            prompt: p.prompt,
            aspect_ratio: p.aspect_ratio,
            resolution: '1080p',
            image_url: imageUrl
          });
          if (out) urls.push(await persistGeneratedImageUrl(out, userId, i));
        } catch (e) {
          console.error('[higgsfield:smartProcessAsset] enhance failed', { aspect: p.aspect_ratio, message: e.message });
          logger.warn('higgsfield', null, 'enhance i2i failed', { message: e.message, aspect: p.aspect_ratio });
        }
      }
      if (urls.length === 0) {
        return await smartProcessAssetRegenerate(imageUrl, brandDNA, options, verdict);
      }
      return { verdict, generated: urls, path: 'enhance_via_higgsfield' };
    }
    return await smartProcessAssetRegenerate(imageUrl, brandDNA, options, verdict);
  }

  async function smartProcessAssetRegenerate(imageUrl, brandDNA, options, verdict) {
    const generated = await generateProductImage(imageUrl, brandDNA, {
      ...options,
      contentTheme: options.contentTheme || verdict?.next_action?.genre || 'product hero'
    });
    return { verdict, generated, path: 'regenerate_fresh' };
  }

  /**
   * Cannes-grade strategic concept generation.
   * Returns { concept, image_brief, video_brief } where:
   *   - concept: the full creative-director JSON output (top_concept + scores + insight + ...)
   *   - image_brief: ready to feed into submitSoulAndWait (or the existing generateProductImage path)
   *   - video_brief: ready to feed into submitVideoAndWait
   *
   * Use Claude Opus for the strategic call (model: claude-opus-4-7).
   */
  async function developCreativeConcept(brandDNA, businessGoal, contentGoal, options = {}) {
    const brief = creative.buildCreativeBrief({
      brandDNA,
      businessGoal,
      contentGoal,
      ideaLevel: options.ideaLevel || 'campaign',
      rotation: options.rotation || 0
    });
    // claudeText is the local module helper (no caching support). Use the
    // injected callClaude when available for prompt caching + token budget.
    const raw = typeof deps.callClaude === 'function'
      ? await deps.callClaude(brief.userTask, options.model || 'claude-opus-4-7', 4096, {
          system: brief.system,
          businessId: options.businessId || null,
          cacheSystem: true,         // creative-director system prompt is 13k chars — perfect cache target
          returnRaw: true,
        })
      : await claudeText(brief.userTask, 'strategy', 4096, {
          model: options.model || 'claude-opus-4-7',
          system: brief.system,
          returnRaw: true
        });
    const concept = extractJSON(raw) || { _raw: raw, _parse_failed: true };
    return concept;
  }

  /**
   * Full pipeline: strategy → MCSLA prompt → image generation.
   * The output of every step is captured so you can audit which layer drove each decision.
   */
  async function generateStrategicProductImage(productImageUrl, brandDNA, options = {}) {
    const businessGoal = options.businessGoal || (brandDNA?.marketing_goal || brandDNA?.marketingGoal || 'increase awareness');
    const contentGoal = options.contentGoal || options.contentTheme || 'monthly content theme';
    const concept = await developCreativeConcept(brandDNA, businessGoal, contentGoal, { ideaLevel: 'campaign' });

    const imageBrief = creative.buildImageBriefFromConcept(concept, brandDNA);
    const userId = options.userId || options.user_id || null;

    const aspects = ['1:1', '9:16', '4:5'];
    const urls = [];
    let plan = null;
    try {
      const raw = productImageUrl
        ? await claudeVision(imageBrief.userTask, [productImageUrl], { max_tokens: 4096, system: imageBrief.system })
        : await claudeText(imageBrief.userTask, 'social_post', 4096, { system: imageBrief.system, returnRaw: true });
      plan = extractJSON(raw) || {};
    } catch (e) {
      console.error('[higgsfield:generateStrategicProductImage] mcsla plan failed', e.message);
    }

    const promptObjs = Array.isArray(plan?.prompts) && plan.prompts.length
      ? plan.prompts
      : aspects.map((ar) => ({
          aspect_ratio: ar,
          prompt: `${imageBrief.creativeContext?.subject || 'product'} — ${imageBrief.creativeContext?.action || 'static'}. Camera: ${imageBrief.creativeContext?.camera || 'Static'}. Style: ${imageBrief.creativeContext?.look || 'Cinematic commercial'}, ${ar}.`
        }));

    for (let i = 0; i < 3; i++) {
      const obj = promptObjs[i] || promptObjs[0];
      const prompt = hf.killSlop(obj.prompt);
      try {
        const payload = {
          prompt,
          aspect_ratio: obj.aspect_ratio || aspects[i],
          resolution: '1080p'
        };
        if (productImageUrl && productImageUrl.startsWith('http')) payload.image_url = productImageUrl;
        const url = await submitSoulAndWait(payload);
        if (url) urls.push(await persistGeneratedImageUrl(url, userId, i));
      } catch (e) {
        console.error('[higgsfield:generateStrategicProductImage] soul gen failed', { i, message: e.message });
        logger.warn('higgsfield', null, 'strategic soul gen failed', { message: e.message, index: i });
      }
    }
    return { concept, generated: urls };
  }

  /**
   * Phase 2 — Soul ID character training.
   * Creates a Higgsfield Soul Character from 1-5+ reference images.
   * Returns { higgsfield_character_id } once training submitted.
   * Default endpoint can be overridden via HIGGSFIELD_PATH_CHARACTER_CREATE env.
   */
  async function trainSoulCharacter({ characterId, sourceImageUrls, name }) {
    if (!Array.isArray(sourceImageUrls) || sourceImageUrls.length === 0) {
      throw new Error('sourceImageUrls (1-5+) required');
    }
    const payload = {
      name: (name || characterId || 'character').slice(0, 80),
      reference_image_urls: sourceImageUrls.slice(0, 20),
      meta: { external_id: characterId || null }
    };
    const r = await hfPost(PATH_CHARACTER_CREATE, payload, 180000);
    if (r.status < 200 || r.status >= 300) {
      console.error('[higgsfield:trainSoulCharacter] HTTP', r.status, safeStringify(r.body));
      throw new Error(`Higgsfield character create HTTP ${r.status}`);
    }
    const body = parseJsonBody(r.body);
    const hfId = body.character_id || body.id || body.data?.character_id || body.data?.id;
    if (!hfId) {
      console.error('[higgsfield:trainSoulCharacter] missing character id in response', safeStringify(body));
      throw new Error('Higgsfield character create did not return a character id');
    }
    return { higgsfield_character_id: hfId, raw: body };
  }

  /**
   * Phase 3 — generic model dispatcher.
   * Submits to whatever Higgsfield endpoint matches the model id.
   * Image models go through submitSoulAndWait-style polling; video models through video pollers.
   */
  async function generateWithModel(modelId, payload, kind = 'image') {
    const path = pathForModel(modelId);
    if (kind === 'video') return submitVideoAndWait(path, payload);
    // image path — reuse the soul-style submit/poll
    const postUrl = higgsfieldUrl(path);
    console.error('[higgsfield:generateWithModel] POST', postUrl, '(model:', modelId, ')');
    const r = await hfPost(path, payload);
    if (r.status < 200 || r.status >= 300) throw new Error(`Higgsfield ${modelId} HTTP ${r.status}`);
    const body = parseJsonBody(r.body);
    const rid = extractRequestId(body);
    const doneUrl = extractImageResultUrl(body);
    if (statusNorm(body) === 'completed' && doneUrl) return doneUrl;
    if (!rid) {
      if (doneUrl) return doneUrl;
      throw new Error(`Higgsfield ${modelId} did not return request_id`);
    }
    return await pollRequestStatus(rid, 'image', IMAGE_JOB_TIMEOUT_MS);
  }

  return {
    generateProductImage,
    generateProductVideo,
    generateHeroAd,
    scoreContent,
    vetCustomerAsset,
    vetCustomerAssetBatch,
    smartProcessAsset,
    developCreativeConcept,
    generateStrategicProductImage,
    trainSoulCharacter,
    generateWithModel,
    pathForModel,
    generateCaption,
    processProductCatalog,
    cancelRequest
  };
};
