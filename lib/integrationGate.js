'use strict';

/**
 * lib/integrationGate.js — connection requirements before expensive ops.
 */

const oauthCrypto = require('./oauthCrypto');

const PLATFORM_REQUIREMENTS = {
  meta_ads: {
    label: 'Meta Ads',
    check: (biz) => !!(oauthCrypto.readToken(biz, 'meta_access_token') && biz.facebook_page_id),
    settings_path: 'settings',
  },
  google_ads: {
    label: 'Google Ads',
    check: (biz) => !!(oauthCrypto.readToken(biz, 'google_access_token') || biz.google_ads_customer_id),
    settings_path: 'settings',
  },
  analytics_social: {
    label: 'Social analytics',
    check: (biz) =>
      !!(
        (oauthCrypto.readToken(biz, 'meta_access_token') && biz.facebook_page_id) ||
        (biz.linkedin_connected && oauthCrypto.readToken(biz, 'linkedin_access_token')) ||
        (biz.twitter_connected && oauthCrypto.readToken(biz, 'twitter_access_token')) ||
        (biz.tiktok_connected && oauthCrypto.readToken(biz, 'tiktok_access_token'))
      ),
    settings_path: 'settings',
  },
};

class IntegrationRequiredError extends Error {
  constructor(platform, message) {
    super(message);
    this.name = 'IntegrationRequiredError';
    this.code = 'INTEGRATION_REQUIRED';
    this.status = 412;
    this.platform = platform;
  }
}

async function loadBusiness(businessId, sbGet) {
  const safe = encodeURIComponent(businessId);
  const rows = await sbGet(
    'businesses',
    `id=eq.${safe}&select=id,meta_access_token,meta_access_token_enc,facebook_page_id,` +
      `google_access_token,google_access_token_enc,google_ads_customer_id,` +
      `linkedin_connected,linkedin_access_token,linkedin_access_token_enc,` +
      `twitter_connected,twitter_access_token,tiktok_connected,tiktok_access_token`
  ).catch(() => []);
  return rows[0] || null;
}

async function assertPlatform({ businessId, platform, sbGet }) {
  const spec = PLATFORM_REQUIREMENTS[platform];
  if (!spec) return { ok: true };
  const biz = await loadBusiness(businessId, sbGet);
  if (!biz) throw new IntegrationRequiredError(platform, 'Business not found');
  if (!spec.check(biz)) {
    throw new IntegrationRequiredError(
      platform,
      `${spec.label} is not connected — connect in Settings before running this workflow`
    );
  }
  return { ok: true, platform, business: biz };
}

function checkPlatform(biz, platform) {
  const spec = PLATFORM_REQUIREMENTS[platform];
  if (!spec || !biz) return false;
  return spec.check(biz);
}

module.exports = {
  PLATFORM_REQUIREMENTS,
  IntegrationRequiredError,
  assertPlatform,
  checkPlatform,
  loadBusiness,
};
