'use strict';

/**
 * services/integrations/index.js — per-business integration health v2.
 */

const oauthCrypto = require('../../lib/oauthCrypto');
const { checkPlatform } = require('../../lib/integrationGate');

async function probeMetaToken({ token, pageId, apiRequest }) {
  if (!token || !pageId) return { ok: false, reason: 'missing_token_or_page' };
  try {
    const r = await apiRequest(
      'GET',
      `https://graph.facebook.com/v19.0/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`,
      {}
    );
    if (r.status !== 200) return { ok: false, reason: `meta_debug_${r.status}` };
    const data = r.body?.data;
    if (data?.is_valid === false) return { ok: false, reason: 'token_invalid', expires_at: data?.expires_at };
    return { ok: true, expires_at: data?.expires_at || null };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function createIntegrationsService({ sbGet, apiRequest, logger }) {
  async function getHealth(businessId, { probeLive = true } = {}) {
    const safe = encodeURIComponent(businessId);
    const [bizRows, oauthRows, snapRow] = await Promise.all([
      sbGet(
        'businesses',
        `id=eq.${safe}&select=business_name,plan,meta_access_token,meta_access_token_enc,facebook_page_id,` +
          `google_access_token,google_access_token_enc,google_ads_customer_id,` +
          `linkedin_connected,linkedin_access_token,linkedin_access_token_enc,` +
          `twitter_connected,twitter_access_token,tiktok_connected,tiktok_access_token,resend_from_email`
      ).catch(() => []),
      sbGet(
        'business_oauth_credentials',
        `business_id=eq.${safe}&select=provider,status,expires_at,last_error,updated_at`
      ).catch(() => []),
      sbGet(
        'analytics_snapshots',
        `business_id=eq.${safe}&select=snapshot_date&order=snapshot_date.desc&limit=1`
      ).catch(() => []),
    ]);
    const biz = bizRows[0];
    if (!biz) return { ok: false, reason: 'business_not_found' };

    const oauthByProvider = Object.fromEntries((oauthRows || []).map((r) => [r.provider, r]));
    const metaToken = oauthCrypto.readToken(biz, 'meta_access_token');
    const metaConfigured = !!(metaToken && biz.facebook_page_id);

    let metaProbe = { ok: metaConfigured, skipped: !probeLive };
    if (probeLive && metaConfigured && apiRequest) {
      metaProbe = await probeMetaToken({
        token: metaToken,
        pageId: biz.facebook_page_id,
        apiRequest,
      });
    }

    const googleConfigured = !!(oauthCrypto.readToken(biz, 'google_access_token') || biz.google_ads_customer_id);

    const items = [
      {
        key: 'meta',
        label: 'Meta (Facebook & Instagram)',
        connected: metaConfigured && metaProbe.ok !== false,
        status: !metaConfigured ? 'disconnected' : metaProbe.ok ? 'healthy' : 'degraded',
        detail: metaConfigured
          ? metaProbe.ok
            ? 'Ads + page insights'
            : `Token issue: ${metaProbe.reason || 'unknown'}`
          : 'Connect Meta in Settings',
        last_sync_at: snapRow[0]?.snapshot_date || oauthByProvider.meta?.updated_at || null,
        expires_at: oauthByProvider.meta?.expires_at || metaProbe.expires_at || null,
        last_error: oauthByProvider.meta?.last_error || (metaProbe.ok ? null : metaProbe.reason),
        gates: ['ad_optimizer', 'analytics_snapshots', 'competitor_signals'],
      },
      {
        key: 'google',
        label: 'Google Ads',
        connected: googleConfigured,
        status: googleConfigured ? 'healthy' : 'disconnected',
        detail: googleConfigured ? 'Search & display' : 'Connect Google Ads',
        last_sync_at: oauthByProvider.google?.updated_at || null,
        expires_at: oauthByProvider.google?.expires_at || null,
        last_error: oauthByProvider.google?.last_error || null,
        gates: ['google_campaigns'],
      },
      {
        key: 'linkedin',
        label: 'LinkedIn',
        connected: !!(biz.linkedin_connected && oauthCrypto.readToken(biz, 'linkedin_access_token')),
        status:
          biz.linkedin_connected && oauthCrypto.readToken(biz, 'linkedin_access_token') ? 'healthy' : 'disconnected',
        detail: 'Company page analytics',
        gates: ['analytics_snapshots'],
      },
      {
        key: 'email',
        label: 'Email (Resend)',
        connected: !!process.env.RESEND_API_KEY,
        status: process.env.RESEND_API_KEY ? 'healthy' : 'degraded',
        detail: process.env.RESEND_API_KEY
          ? biz.resend_from_email
            ? `From ${biz.resend_from_email}`
            : 'Platform configured'
          : 'RESEND_API_KEY missing on server',
        gates: ['email_lifecycle'],
      },
      {
        key: 'higgsfield',
        label: 'Higgsfield Studio',
        connected: !!(process.env.HIGGSFIELD_API_KEY_ID && process.env.HIGGSFIELD_API_KEY_SECRET),
        status: process.env.HIGGSFIELD_API_KEY_ID && process.env.HIGGSFIELD_API_KEY_SECRET ? 'healthy' : 'degraded',
        detail: 'AI image & video',
        gates: ['creative_engine', 'wf10'],
      },
      {
        key: 'brand_memory',
        label: 'Brand memory',
        connected: !!(process.env.OPENAI_API_KEY && process.env.PINECONE_API_KEY && process.env.PINECONE_HOST),
        status:
          process.env.OPENAI_API_KEY && process.env.PINECONE_API_KEY && process.env.PINECONE_HOST
            ? 'healthy'
            : 'degraded',
        detail: 'Pinecone vector store',
        gates: ['ops_weekly_maintenance'],
      },
    ];

    const socialCount = items.filter((i) => ['meta', 'google', 'linkedin'].includes(i.key) && i.connected).length;

    return {
      ok: true,
      business_id: businessId,
      business_name: biz.business_name,
      plan: biz.plan || 'starter',
      generated_at: new Date().toISOString(),
      integrations: items,
      connected_count: socialCount,
      can_run_ad_optimizer: checkPlatform(biz, 'meta_ads') && metaProbe.ok !== false,
      can_run_analytics_snapshots: checkPlatform(biz, 'analytics_social'),
      recommended_action:
        !metaConfigured && !googleConfigured
          ? 'connect_meta_or_google'
          : metaConfigured && !metaProbe.ok
            ? 'refresh_meta_token'
            : null,
    };
  }

  return { getHealth, probeMetaToken };
}

module.exports = { createIntegrationsService };
