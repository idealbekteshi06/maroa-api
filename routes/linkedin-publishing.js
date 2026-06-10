'use strict';

/**
 * routes/linkedin-publishing.js — LinkedIn OAuth + UGC publish.
 *
 * Three routes:
 *   GET  /linkedin-oauth-start         — redirect to LinkedIn consent
 *   POST /webhook/linkedin-oauth-exchange — code → access_token + person/org
 *   POST /webhook/linkedin-publish     — generate content (optional) + post
 *
 * Follows the routes/observability.js pattern: a single register({app, ...deps})
 * function with no closure-reach into server.js.
 *
 * 2026-05-20: Token persistence switched to lib/oauthCrypto (writes the
 * encrypted *_enc column; reads decrypt at the boundary). Migration 073
 * dropped the plaintext linkedin_access_token + linkedin_refresh_token
 * columns from production, so any code path that still references them
 * would 500 silently — fixed in this file.
 *
 * 2026-05-20 (P0-3): publish path now goes through lib/complianceGate so
 * hard-violation posts (income guarantees, medical claims, etc.) never
 * reach LinkedIn.
 */
const crypto = require('crypto');
const oauthCrypto = require('../lib/oauthCrypto');
const { signOAuthState, verifyOAuthState, isUuid } = require('../lib/oauthState');
const { ensureCompliant, ComplianceBlocked } = require('../lib/complianceGate');

function register({ app, sbGet, sbPost, sbPatch, sbDelete, callClaude, log, logError, getBrandExamples, env }) {
  const LINKEDIN_CLIENT_ID = (env?.LINKEDIN_CLIENT_ID || process.env.LINKEDIN_CLIENT_ID || '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
  const LINKEDIN_CLIENT_SECRET = (env?.LINKEDIN_CLIENT_SECRET || process.env.LINKEDIN_CLIENT_SECRET || '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
  const LINKEDIN_REDIRECT_URI = 'https://maroa-ai-marketing-automator.lovable.app/social-callback';
  const STATE_SECRET = (env?.N8N_WEBHOOK_SECRET || process.env.N8N_WEBHOOK_SECRET || '').trim();

  // GET /linkedin-oauth-start — redirect user to LinkedIn consent screen
  app.get('/linkedin-oauth-start', async (req, res) => {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!isUuid(String(business_id))) return res.status(400).json({ error: 'business_id must be a valid UUID' });
    if (!LINKEDIN_CLIENT_ID) return res.status(500).json({ error: 'LINKEDIN_CLIENT_ID not configured' });

    const scope = 'openid profile email w_member_social';
    // Signed, single-use state (nonce+ts+HMAC) replaces the old predictable
    // `${business_id}:linkedin`. Verified in the exchange to defeat CSRF /
    // state-forgery. Mirrors routes/twitter-publishing.js. Falls back to an
    // opaque random state if no signing secret is configured.
    const state = STATE_SECRET
      ? signOAuthState({ businessId: String(business_id), platform: 'linkedin', secret: STATE_SECRET })
      : crypto.randomBytes(24).toString('base64url');

    try {
      await sbPost('oauth_states', { business_id, platform: 'linkedin', state });
    } catch (err) {
      log?.('/linkedin-oauth-start', `Failed to store OAuth state: ${err.message}`);
    }

    const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${LINKEDIN_CLIENT_ID}&redirect_uri=${encodeURIComponent(LINKEDIN_REDIRECT_URI)}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(scope)}`;

    log?.('/linkedin-oauth-start', `Redirecting business_id=${business_id} to LinkedIn`);
    res.redirect(authUrl);
  });

  // POST /webhook/linkedin-oauth-exchange — finalize OAuth, capture tokens
  app.post('/webhook/linkedin-oauth-exchange', async (req, res) => {
    const { code, business_id, redirect_uri, state } = req.body;
    if (!code || !business_id) return res.status(400).json({ error: 'code and business_id required' });
    if (!isUuid(String(business_id))) return res.status(400).json({ error: 'business_id must be a valid UUID' });

    // When a signed `state` is supplied we verify it, require it to match
    // business_id, confirm the server-stored row exists, and consume it
    // (single-use). State stays optional so existing clients that don't echo
    // it back keep working — matching the twitter-publishing.js exchange.
    if (state) {
      const verified = STATE_SECRET ? verifyOAuthState(state, STATE_SECRET, { platform: 'linkedin' }) : null;
      if (!verified) return res.status(400).json({ error: 'state token invalid or expired' });
      if (String(verified.businessId) !== String(business_id)) {
        return res.status(403).json({ error: 'state does not match business_id' });
      }
      try {
        const row = (
          await sbGet('oauth_states', `state=eq.${encodeURIComponent(state)}&platform=eq.linkedin&limit=1`)
        )[0];
        if (!row) return res.status(400).json({ error: 'state not found or already used' });
      } catch (e) {
        log?.('/webhook/linkedin-oauth-exchange', `oauth_states lookup failed: ${e.message}`);
      }
      if (sbDelete) {
        await sbDelete('oauth_states', `state=eq.${encodeURIComponent(state)}`).catch(() => {});
      }
    }

    if (!LINKEDIN_CLIENT_ID || !LINKEDIN_CLIENT_SECRET) {
      return res.status(500).json({
        error: 'LINKEDIN_CLIENT_ID or LINKEDIN_CLIENT_SECRET not set in Railway',
        fix: 'Add LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET to Railway environment variables',
      });
    }

    const REDIRECT = redirect_uri || LINKEDIN_REDIRECT_URI;
    log?.('/webhook/linkedin-oauth-exchange', `Starting exchange for business_id=${business_id} redirect=${REDIRECT}`);

    try {
      // 1. Exchange code for access token
      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: LINKEDIN_CLIENT_ID,
        client_secret: LINKEDIN_CLIENT_SECRET,
      });
      const tokenResp = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams.toString(),
      });
      const tokenData = await tokenResp.json();

      if (!tokenData.access_token) {
        log?.('/webhook/linkedin-oauth-exchange', `Token exchange failed: ${JSON.stringify(tokenData)}`);
        return res.status(400).json({
          error: 'LinkedIn token exchange failed',
          detail: tokenData,
          redirect_uri: REDIRECT,
          hint: 'Verify LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, and redirect_uri match your LinkedIn app settings',
        });
      }

      const accessToken = tokenData.access_token;
      const refreshToken = tokenData.refresh_token || null;

      // 2. Get person profile (OpenID)
      const profileResp = await fetch('https://api.linkedin.com/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const profile = await profileResp.json();
      const personId = profile.sub || null;

      // 3. Get organization (company page) the user admins
      let orgId = null;
      try {
        const orgResp = await fetch(
          'https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organization~(id,localizedName)))',
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const orgData = await orgResp.json();
        if (orgData?.elements?.[0]) {
          orgId = String(orgData.elements[0]['organization~']?.id || '');
        }
      } catch (e) {
        log?.('/webhook/linkedin-oauth-exchange', `org lookup failed (non-fatal): ${e?.message}`);
      }

      // 4. Save to Supabase — encrypted columns only.
      const updates = {
        ...oauthCrypto.encryptIfEnabled('linkedin_access_token', accessToken),
        ...oauthCrypto.encryptIfEnabled('linkedin_refresh_token', refreshToken),
        linkedin_person_id: personId,
        linkedin_organization_id: orgId,
        linkedin_connected: true,
      };
      await sbPatch('businesses', `id=eq.${encodeURIComponent(business_id)}`, updates);

      log?.(
        '/webhook/linkedin-oauth-exchange',
        `LinkedIn connected for ${business_id} — person: ${profile.name}, org: ${orgId}`
      );
      return res.json({
        success: true,
        linkedin_person_id: personId,
        linkedin_organization_id: orgId,
        name: profile.name,
        message: `LinkedIn connected${orgId ? ' (company page found)' : ' (personal profile)'}`,
      });
    } catch (err) {
      console.error('[linkedin-oauth-exchange ERROR]', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /webhook/linkedin-publish — Claude-generate (optional) + publish
  app.post('/webhook/linkedin-publish', async (req, res) => {
    const { business_id, content } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    res.json({ received: true, message: 'LinkedIn publish started' });

    try {
      const biz = (
        await sbGet(
          'businesses',
          `id=eq.${encodeURIComponent(business_id)}&select=business_name,industry,brand_tone,target_audience,dream_customer,unique_differentiator,best_performing_themes,linkedin_access_token,linkedin_access_token_enc,linkedin_person_id,linkedin_organization_id`
        )
      )[0];
      const linkedinToken = biz ? oauthCrypto.readToken(biz, 'linkedin_access_token') : null;
      if (!linkedinToken) {
        return log?.('/webhook/linkedin-publish', `LinkedIn not connected for ${business_id}`);
      }

      // 1. Generate post with Claude if not provided
      let postText = content;
      if (!postText || postText === 'AI_GENERATE') {
        const bestThemes = biz.best_performing_themes
          ? JSON.stringify(biz.best_performing_themes)
          : 'not available yet';
        const brandContext = getBrandExamples
          ? await getBrandExamples(business_id, 'social_post', `${biz.business_name} ${biz.industry} linkedin`)
          : '';
        const prompt = `${brandContext}You are a LinkedIn content expert. Generate a professional LinkedIn post for a ${biz.industry} business.
Business: ${biz.business_name}
Tone: ${biz.brand_tone || 'professional and approachable'}
Target audience: ${biz.target_audience || 'business owners'}
Dream customer: ${biz.dream_customer || ''}
Unique differentiator: ${biz.unique_differentiator || ''}
Best performing themes: ${bestThemes}

Write a post with: hook (first line stops scrolling), value body (3-5 lines), CTA, 3-5 hashtags.
Plain text, no markdown, no asterisks. Max 1300 characters.
Return only valid JSON: {"post_text":"...","content_theme":"..."}`;

        const parsed = await callClaude(prompt, 'claude-opus-4-7', 700, {
          businessId: business_id,
          skill: 'linkedin_post',
        });
        postText = parsed.post_text || parsed._raw || '';

        await sbPost('generated_content', {
          business_id,
          linkedin_post: postText,
          content_theme: parsed.content_theme || 'linkedin',
          status: 'published',
          published_at: new Date().toISOString(),
        });
      }

      // Compliance gate — block hard violations before LinkedIn sees the post.
      try {
        await ensureCompliant({
          content: postText,
          industry: biz.industry,
          businessId: business_id,
          plan: biz.plan,
          surface: 'social_post',
          deps: { callClaude, sbPost, logger: { warn: log } },
        });
      } catch (cgErr) {
        if (cgErr instanceof ComplianceBlocked) {
          return log?.(
            '/webhook/linkedin-publish',
            `Compliance hard-block: ${cgErr.violations.map((v) => v.rule_id).join(',')}`
          );
        }
        throw cgErr;
      }

      // 2. Determine author URN
      const authorUrn = biz.linkedin_organization_id
        ? `urn:li:organization:${biz.linkedin_organization_id}`
        : `urn:li:person:${biz.linkedin_person_id}`;

      // 3. Post via LinkedIn UGC Posts API
      const ugcPost = {
        author: authorUrn,
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: { text: postText },
            shareMediaCategory: 'NONE',
          },
        },
        visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
      };

      const publishResp = await fetch('https://api.linkedin.com/v2/ugcPosts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${linkedinToken}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0',
        },
        body: JSON.stringify(ugcPost),
      });
      const publishData = await publishResp.json();

      if (publishData.id) {
        await sbPatch('businesses', `id=eq.${encodeURIComponent(business_id)}`, {
          next_linkedin_post_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        });
        log?.('/webhook/linkedin-publish', `Published to LinkedIn for ${business_id}: ${publishData.id}`);
      } else {
        log?.('/webhook/linkedin-publish', `LinkedIn publish failed: ${JSON.stringify(publishData)}`);
        if (logError) await logError(business_id, 'linkedin-publish', JSON.stringify(publishData), req.body);
      }
    } catch (err) {
      console.error('[linkedin-publish ERROR]', err.message);
      if (logError) await logError(business_id, 'linkedin-publish', err.message, req.body);
    }
  });
}

module.exports = { register };
