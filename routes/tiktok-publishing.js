'use strict';

/**
 * routes/tiktok-publishing.js — TikTok OAuth 2.0 PKCE + video publish.
 *
 * Three routes:
 *   GET  /tiktok-oauth-start           — PKCE redirect to TikTok consent
 *   POST /webhook/tiktok-oauth-exchange — code + verifier → access token
 *   POST /webhook/tiktok-publish       — Claude script + (optional) video init
 *
 * Carved from server.js. Same dep contract as routes/linkedin-publishing.js
 * and routes/twitter-publishing.js.
 */

const crypto = require('crypto');

function register({ app, sbGet, sbPost, sbPatch, callClaude, log, logError, getBrandExamples, env }) {
  const TIKTOK_CLIENT_KEY = (env?.TIKTOK_CLIENT_KEY || process.env.TIKTOK_CLIENT_KEY || '').replace(/[^\x20-\x7E]/g, '').trim();
  const TIKTOK_CLIENT_SECRET = (env?.TIKTOK_CLIENT_SECRET || process.env.TIKTOK_CLIENT_SECRET || '').replace(/[^\x20-\x7E]/g, '').trim();
  const TIKTOK_REDIRECT_URI = 'https://maroa-ai-marketing-automator.lovable.app/social-callback';

  app.get('/tiktok-oauth-start', async (req, res) => {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!TIKTOK_CLIENT_KEY) return res.status(500).json({ error: 'TIKTOK_CLIENT_KEY not configured' });

    const state = `${business_id}:tiktok`;
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    try {
      await sbPost('oauth_states', { business_id, platform: 'tiktok', state, code_verifier: codeVerifier });
    } catch (err) {
      log?.('/tiktok-oauth-start', `Failed to store PKCE state: ${err.message}`);
    }

    const authUrl = `https://www.tiktok.com/v2/auth/authorize?client_key=${TIKTOK_CLIENT_KEY}&response_type=code&scope=${encodeURIComponent('user.info.basic,video.upload,video.list')}&redirect_uri=${encodeURIComponent(TIKTOK_REDIRECT_URI)}&state=${encodeURIComponent(state)}&code_challenge=${codeChallenge}&code_challenge_method=S256`;

    log?.('/tiktok-oauth-start', `Redirecting business_id=${business_id} to TikTok`);
    res.redirect(authUrl);
  });

  app.post('/webhook/tiktok-oauth-exchange', async (req, res) => {
    const { code, business_id, code_verifier, redirect_uri } = req.body;
    if (!code || !business_id || !code_verifier) {
      return res.status(400).json({ error: 'code, business_id, and code_verifier required' });
    }

    if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) {
      return res.status(500).json({
        error: 'TIKTOK_CLIENT_KEY or TIKTOK_CLIENT_SECRET not set in Railway',
        fix: 'Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET to Railway environment variables',
      });
    }

    const REDIRECT = redirect_uri || TIKTOK_REDIRECT_URI;
    log?.('/webhook/tiktok-oauth-exchange', `Starting exchange for business_id=${business_id}`);

    try {
      const tokenResp = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_key: TIKTOK_CLIENT_KEY,
          client_secret: TIKTOK_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          code_verifier,
        }).toString(),
      });
      const tokenData = await tokenResp.json();

      if (!tokenData.data?.access_token) {
        log?.('/webhook/tiktok-oauth-exchange', `Token exchange failed: ${JSON.stringify(tokenData)}`);
        return res.status(400).json({
          error: 'TikTok token exchange failed',
          detail: tokenData,
          hint: 'Ensure redirect_uri matches TikTok app settings and code_verifier matches the challenge',
        });
      }

      const access_token = tokenData.data.access_token;
      const refresh_token = tokenData.data.refresh_token || null;

      let userId = null;
      try {
        const userResp = await fetch(
          'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username',
          { headers: { Authorization: `Bearer ${access_token}` } }
        );
        const ud = await userResp.json();
        userId = ud?.data?.user?.open_id || null;
      } catch (e) {
        log?.('/webhook/tiktok-oauth-exchange', `user info lookup failed (non-fatal): ${e?.message}`);
      }

      await sbPatch('businesses', `id=eq.${encodeURIComponent(business_id)}`, {
        tiktok_access_token: access_token,
        tiktok_refresh_token: refresh_token,
        tiktok_user_id: userId,
        tiktok_connected: true,
      });

      log?.('/webhook/tiktok-oauth-exchange', `TikTok connected for ${business_id} — user_id: ${userId}`);
      return res.json({ success: true, tiktok_user_id: userId, message: 'TikTok connected' });
    } catch (err) {
      console.error('[tiktok-oauth-exchange ERROR]', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/webhook/tiktok-publish', async (req, res) => {
    const { business_id, video_url } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    res.json({ received: true, message: 'TikTok script generation started' });

    try {
      const biz = (await sbGet('businesses',
        `id=eq.${encodeURIComponent(business_id)}&select=business_name,industry,brand_tone,target_audience,dream_customer,unique_differentiator,best_performing_themes,tiktok_access_token,tiktok_user_id`))[0];
      if (!biz?.tiktok_access_token) {
        return log?.('/webhook/tiktok-publish', `TikTok not connected for ${business_id}`);
      }

      const bestThemes = biz.best_performing_themes ? JSON.stringify(biz.best_performing_themes) : 'not available yet';
      const brandContext = getBrandExamples
        ? await getBrandExamples(business_id, 'social_post', `${biz.business_name} ${biz.industry} tiktok video`)
        : '';
      const prompt = `${brandContext}Write a TikTok video script for a ${biz.industry} business.
Business: ${biz.business_name}
Tone: ${biz.brand_tone || 'fun, energetic, authentic'}
Target audience: ${biz.target_audience || 'young adults'}
Dream customer: ${biz.dream_customer || ''}
Unique differentiator: ${biz.unique_differentiator || ''}
Best performing themes: ${bestThemes}

Script format:
- Hook (0-3 sec): bold statement or question that stops the scroll
- Problem (3-8 sec): relatable pain point your audience feels
- Solution (8-20 sec): how ${biz.business_name} solves it
- CTA (last 3 sec): one clear action (follow, comment, DM)

Also write:
- Caption: max 150 characters, punchy and curiosity-driven
- 5 trending hashtags for ${biz.industry}

Return only valid JSON: {"hook":"...","script":"...","caption":"...","hashtags":["#tag1","#tag2","#tag3","#tag4","#tag5"],"content_theme":"..."}`;

      const parsed = await callClaude(prompt, 'claude-opus-4-7', 600, {
        businessId: business_id,
        skill: 'tiktok_video_script',
      });

      const fullCaption = `${parsed.caption || ''} ${(parsed.hashtags || []).join(' ')}`.trim();

      await sbPost('generated_content', {
        business_id,
        tiktok_script: `HOOK: ${parsed.hook || ''}\n\n${parsed.script || ''}`,
        tiktok_caption: fullCaption,
        content_theme: parsed.content_theme || 'tiktok',
        status: video_url ? 'published' : 'pending_approval',
        published_at: video_url ? new Date().toISOString() : null,
      });

      if (video_url) {
        const initResp = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
          method: 'POST',
          headers: { Authorization: `Bearer ${biz.tiktok_access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            post_info: {
              title: fullCaption.slice(0, 150),
              privacy_level: 'PUBLIC_TO_EVERYONE',
              disable_duet: false,
              disable_comment: false,
              disable_stitch: false,
            },
            source_info: { source: 'PULL_FROM_URL', video_url },
          }),
        });
        const initData = await initResp.json();
        if (initData.data?.publish_id) {
          await sbPatch('businesses', `id=eq.${encodeURIComponent(business_id)}`, {
            next_tiktok_post_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
          });
          log?.('/webhook/tiktok-publish', `TikTok upload initiated for ${business_id}: ${initData.data.publish_id}`);
        } else {
          log?.('/webhook/tiktok-publish', `TikTok upload failed: ${JSON.stringify(initData)}`);
        }
      } else {
        log?.('/webhook/tiktok-publish', `TikTok script generated for ${business_id} — pending video upload`);
      }
    } catch (err) {
      console.error('[tiktok-publish ERROR]', err.message);
      if (logError) await logError(business_id, 'tiktok-publish', err.message, req.body);
    }
  });
}

module.exports = { register };
