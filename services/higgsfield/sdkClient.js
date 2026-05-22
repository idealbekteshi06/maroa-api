'use strict';

const { createHiggsfieldClient } = require('@higgsfield/client/v2');

/**
 * Thin wrapper around @higgsfield/client v2 subscribe() for Maroa paths.
 */

function createSdkWrapper({ apiBase, keyId, keySecret, pollIntervalMs, maxPollTimeMs, timeoutMs }) {
  let client = null;

  function getClient() {
    if (!keyId || !keySecret) {
      throw new Error('Higgsfield credentials not configured (HIGGSFIELD_API_KEY_ID / HIGGSFIELD_API_KEY_SECRET)');
    }
    if (!client) {
      client = createHiggsfieldClient({
        credentials: `${keyId}:${keySecret}`,
        baseURL: apiBase,
        pollInterval: pollIntervalMs,
        maxPollTime: maxPollTimeMs,
        timeout: timeoutMs,
      });
    }
    return client;
  }

  function extractImageUrl(v2) {
    if (!v2) return null;
    const fromImages = v2.images?.[0]?.url;
    if (fromImages && String(fromImages).startsWith('http')) return fromImages;
    const result = v2.result !== undefined ? v2.result : v2;
    const nested = result?.images?.[0]?.url;
    if (nested && String(nested).startsWith('http')) return nested;
    return null;
  }

  function extractVideoUrl(v2) {
    if (!v2) return null;
    const fromVideo = v2.video?.url;
    if (fromVideo && String(fromVideo).startsWith('http')) return fromVideo;
    const result = v2.result !== undefined ? v2.result : v2;
    const nested = result?.video?.url;
    if (nested && String(nested).startsWith('http')) return nested;
    return null;
  }

  async function subscribeRaw(path, payload) {
    const hf = getClient();
    return hf.subscribe(path, { input: payload, withPolling: true });
  }

  async function subscribeAndWait(path, payload, kind) {
    const hf = getClient();
    const v2 = await hf.subscribe(path, { input: payload, withPolling: true });
    const st = String(v2.status || v2.state || '').toLowerCase();
    if (st === 'failed' || st === 'nsfw') {
      const err = new Error(v2.message || v2.error || `Higgsfield job ${st}`);
      err.code = st;
      throw err;
    }
    if (st && st !== 'completed' && st !== 'complete') {
      const url = kind === 'video' ? extractVideoUrl(v2) : extractImageUrl(v2);
      if (url) return { url, request_id: v2.request_id || v2.requestId || null, raw: v2 };
    }
    const url = kind === 'video' ? extractVideoUrl(v2) : extractImageUrl(v2);
    if (!url) {
      throw new Error('Higgsfield completed but no result URL in response');
    }
    return { url, request_id: v2.request_id || v2.requestId || null, raw: v2 };
  }

  return { getClient, subscribeRaw, subscribeAndWait, extractImageUrl, extractVideoUrl };
}

module.exports = { createSdkWrapper };
