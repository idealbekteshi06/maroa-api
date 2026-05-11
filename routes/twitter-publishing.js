'use strict';

/**
 * routes/twitter-publishing.js — Twitter (X) OAuth 2.0 PKCE + tweet publish.
 *
 * Three routes:
 *   GET  /twitter-oauth-start          — PKCE redirect to Twitter consent
 *   POST /webhook/twitter-oauth-exchange — code + verifier → access token
 *   POST /webhook/twitter-publish      — generate tweet/thread + post
 *
 * Carved from server.js per the routes/observability.js pattern.
 */

const crypto = require('crypto');

function register({ app, sbGet, sbPost, sbPatch, callClaude, log, logError, getBrandExamples, env }) {
  const TWITTER_CLIENT_ID = (env?.TWITTER_CLIENT_ID || process.env.TWITTER_CLIENT_ID || '').replace(/[^\x20-\x7E]/g, '').trim();
  const TWITTER_CLIENT_SECRET = (env?.TWITTER_CLIENT_SECRET || process.env.TWITTER_CLIENT_SECRET || '').replace(/[^\x20-\x7E]/g, '').trim();
  const TWITTER_REDIRECT_URI = 'https://maroa-ai-marketing-automator.lovable.app/social-callback';

  // GET /twitter-oauth-start — PKCE redirect
  app.get('/twitter-oauth-start', async (req, res) => {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!TWITTER_CLIENT_ID) return res.status(500).json({ error: 'TWITTER_CLIENT_ID not configured' });

    const state = `${business_id}:twitter`;
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    try {
      await sbPost('oauth_states', { business_id, platform: 'twitter', state, code_verifier: codeVerifier });
    } catch (err) {
      log?.('/twitter-oauth-start', `Failed to store PKCE state: ${err.message}`);
    }

    const authUrl = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${TWITTER_CLIENT_ID}&redirect_uri=${encodeURIComponent(TWITTER_REDIRECT_URI)}&scope=${encodeURIComponent('tweet.read tweet.write users.read offline.access')}&state=${encodeURIComponent(state)}&code_challenge=${codeChallenge}&code_challenge_method=S256`;

    log?.('/twitter-oauth-start', `Redirecting business_id=${business_id} to Twitter`);
    res.redirect(authUrl);
  });

  // POST /webhook/twitter-oauth-exchange — code + PKCE verifier → tokens
  app.post('/webhook/twitter-oauth-exchange', async (req, res) => {
    const { code, business_id, code_verifier, redirect_uri } = req.body;
    if (!code || !business_id || !code_verifier) {
      return res.status(400).json({ error: 'code, business_id, and code_verifier required' });
    }

    if (!TWITTER_CLIENT_ID || !TWITTER_CLIENT_SECRET) {
      return res.status(500).json({
        error: 'TWITTER_CLIENT_ID or TWITTER_CLIENT_SECRET not set in Railway',
        fix: 'Add TWITTER_CLIENT_ID and TWITTER_CLIENT_SECRET to Railway environment variables',
      });
    }

    const REDIRECT = redirect_uri || TWITTER_REDIRECT_URI;
    log?.('/webhook/twitter-oauth-exchange', `Starting exchange for business_id=${business_id}`);

    try {
      const basicAuth = Buffer.from(`${TWITTER_CLIENT_ID}:${TWITTER_CLIENT_SECRET}`).toString('base64');
      const tokenResp = await fetch('https://api.twitter.com/2/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basicAuth}` },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          code_verifier,
          client_id: TWITTER_CLIENT_ID,
        }).toString(),
      });
      const tokenData = await tokenResp.json();

      if (!tokenData.access_token) {
        log?.('/webhook/twitter-oauth-exchange', `Token exchange failed: ${JSON.stringify(tokenData)}`);
        return res.status(400).json({
          error: 'Twitter token exchange failed',
          detail: tokenData,
          hint: 'Ensure redirect_uri matches what is registered in Twitter Developer Portal and code_verifier matches the challenge used',
        });
      }

      const userResp = await fetch('https://api.twitter.com/2/users/me?user.fields=username,name', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userData = await userResp.json();
      const twitterUser = userData.data || {};

      await sbPatch('businesses', `id=eq.${encodeURIComponent(business_id)}`, {
        twitter_access_token: tokenData.access_token,
        twitter_refresh_token: tokenData.refresh_token || null,
        twitter_user_id: twitterUser.id || null,
        twitter_connected: true,
      });

      log?.('/webhook/twitter-oauth-exchange', `Twitter connected for ${business_id} — @${twitterUser.username}`);
      return res.json({
        success: true,
        twitter_user_id: twitterUser.id,
        twitter_username: twitterUser.username,
        message: `Twitter connected as @${twitterUser.username}`,
      });
    } catch (err) {
      console.error('[twitter-oauth-exchange ERROR]', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /webhook/twitter-publish — generate tweet/thread + post
  app.post('/webhook/twitter-publish', async (req, res) => {
    const { business_id, text, post_type = 'tweet' } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    res.json({ received: true, message: `Twitter ${post_type} started` });

    try {
      const biz = (await sbGet('businesses',
        `id=eq.${encodeURIComponent(business_id)}&select=business_name,industry,brand_tone,target_audience,dream_customer,unique_differentiator,best_performing_themes,twitter_access_token,twitter_user_id`))[0];
      if (!biz?.twitter_access_token) {
        return log?.('/webhook/twitter-publish', `Twitter not connected for ${business_id}`);
      }

      let tweetText = text;
      let tweets = [];

      if (!tweetText || tweetText === 'AI_GENERATE') {
        const isThread = post_type === 'thread';
        const brandContext = getBrandExamples
          ? await getBrandExamples(business_id, 'social_post', `${biz.business_name} ${biz.industry} twitter`)
          : '';
        const prompt = isThread
          ? `${brandContext}Write a 5-tweet thread for a ${biz.industry} business.
Business: ${biz.business_name}, Tone: ${biz.brand_tone || 'expert'}.
Tweet 1: bold hook. Tweets 2-4: actionable value. Tweet 5: CTA.
Max 270 chars each. Max 1-2 hashtags total across the thread.
Return only valid JSON: {"tweets":["t1","t2","t3","t4","t5"],"content_theme":"..."}`
          : `${brandContext}Generate a tweet for a ${biz.industry} business. Max 280 characters.
Direct, engaging, ends with soft CTA. Max 2 hashtags.
Business: ${biz.business_name}, Tone: ${biz.brand_tone || 'professional'}, Audience: ${biz.target_audience || 'business owners'}.
Return only valid JSON: {"tweet":"...","content_theme":"..."}`;

        const parsed = await callClaude(prompt, 'claude-opus-4-7', 500, {
          businessId: business_id,
          skill: 'twitter_post',
        });

        tweetText = parsed.tweet || '';
        tweets = parsed.tweets || [];
        const contentTheme = parsed.content_theme || 'twitter';

        await sbPost('generated_content', {
          business_id,
          twitter_post: isThread ? tweets.join('\n---\n') : tweetText,
          content_theme: contentTheme,
          status: 'published',
          published_at: new Date().toISOString(),
        });
      }

      if (!tweets.length) tweets = [tweetText];
      const isThread = tweets.length > 1;

      let previousId = null;
      const postedIds = [];
      for (const t of tweets) {
        const body = { text: (t || '').slice(0, 280) };
        if (previousId) body.reply = { in_reply_to_tweet_id: previousId };

        const tweetResp = await fetch('https://api.twitter.com/2/tweets', {
          method: 'POST',
          headers: { Authorization: `Bearer ${biz.twitter_access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const tweetData = await tweetResp.json();
        if (tweetData.data?.id) {
          postedIds.push(tweetData.data.id);
          previousId = tweetData.data.id;
        }
      }

      if (postedIds.length) {
        await sbPatch('businesses', `id=eq.${encodeURIComponent(business_id)}`, {
          next_twitter_post_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        });
        log?.('/webhook/twitter-publish', `Posted ${isThread ? `thread (${postedIds.length} tweets)` : 'tweet'} for ${business_id}`);
      } else {
        log?.('/webhook/twitter-publish', `Twitter post failed — no IDs returned`);
      }
    } catch (err) {
      console.error('[twitter-publish ERROR]', err.message);
      if (logError) await logError(business_id, 'twitter-publish', err.message, req.body);
    }
  });
}

module.exports = { register };
