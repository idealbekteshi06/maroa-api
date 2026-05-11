'use strict';

/**
 * tests/helpers/fakeHiggsfield.js
 *
 * In-memory fake for services/higgsfield.js. Returns predictable URLs +
 * job IDs without touching the real Cloud or FNF endpoints. Records
 * every method call so tests can assert what was requested.
 *
 * Covers the public surface used by Maroa:
 *   - trainSoul({ name, images }) → { soul_id, status }
 *   - generateImage({ prompt, soul_id, model }) → { url, job_id, status }
 *   - generateVideo({ prompt, model }) → { url, job_id, status }
 *   - generateProductPhoto({...}) → { url, ... }
 *   - getJobStatus(jobId) → { status, url? }
 *
 * Modes:
 *   - { mode: 'always_succeed' } (default) — every call returns a fake URL
 *   - { mode: 'always_fail' }     — every call rejects with HTTP 503
 *   - { mode: 'eventually_ready' } — generateX returns 'pending', then
 *     getJobStatus flips to 'ready' after N polls (default 2)
 *   - { mode: 'nsfw_terminal' }   — image gen returns nsfw_blocked terminal
 *
 * Cloud + FNF behavior modeled separately via { cloud: 'fail', fnf: 'succeed' }
 * so failover paths can be tested.
 */

function createFakeHiggsfield(opts = {}) {
  const { mode = 'always_succeed', cloudMode = null, fnfMode = null, pollsBeforeReady = 2 } = opts;

  const calls = [];
  const jobs = new Map(); // jobId → { status, url, pollCount }
  let counter = 0;

  function rid(prefix) {
    counter += 1;
    return `${prefix}_${Date.now()}_${counter}`;
  }

  function effectiveModeForApi(api) {
    if (api === 'cloud' && cloudMode) return cloudMode;
    if (api === 'fnf' && fnfMode) return fnfMode;
    return mode;
  }

  function maybeFail(method, api = 'cloud') {
    const m = effectiveModeForApi(api);
    if (m === 'always_fail') {
      const err = new Error(`fakeHiggsfield: ${method} on ${api} forced to fail`);
      err.status = 503;
      throw err;
    }
    if (m === 'nsfw_terminal' && method.startsWith('generate')) {
      return { status: 'nsfw_blocked', reason: 'simulated NSFW terminal block' };
    }
    return null;
  }

  async function trainSoul({ name, images, businessId } = {}) {
    const call = { method: 'trainSoul', name, images, businessId, timestamp: Date.now() };
    calls.push(call);
    const fail = maybeFail('trainSoul');
    if (fail) return fail;
    return { soul_id: rid('soul'), status: 'ready', name };
  }

  async function generateImage(args = {}) {
    const call = { method: 'generateImage', ...args, timestamp: Date.now() };
    calls.push(call);
    const fail = maybeFail('generateImage');
    if (fail) return fail;
    const jobId = rid('img_job');
    if (mode === 'eventually_ready') {
      jobs.set(jobId, { status: 'pending', url: null, pollCount: 0 });
      return { job_id: jobId, status: 'pending' };
    }
    return {
      job_id: jobId,
      status: 'ready',
      url: `https://fake-higgsfield.local/img/${jobId}.png`,
    };
  }

  async function generateVideo(args = {}) {
    const call = { method: 'generateVideo', ...args, timestamp: Date.now() };
    calls.push(call);
    const fail = maybeFail('generateVideo');
    if (fail) return fail;
    const jobId = rid('vid_job');
    if (mode === 'eventually_ready') {
      jobs.set(jobId, { status: 'pending', url: null, pollCount: 0 });
      return { job_id: jobId, status: 'pending' };
    }
    return {
      job_id: jobId,
      status: 'ready',
      url: `https://fake-higgsfield.local/vid/${jobId}.mp4`,
    };
  }

  async function generateProductPhoto(args = {}) {
    const call = { method: 'generateProductPhoto', ...args, timestamp: Date.now() };
    calls.push(call);
    const fail = maybeFail('generateProductPhoto');
    if (fail) return fail;
    return {
      job_id: rid('pp_job'),
      status: 'ready',
      url: `https://fake-higgsfield.local/pp/${counter}.png`,
    };
  }

  async function getJobStatus(jobId) {
    calls.push({ method: 'getJobStatus', jobId, timestamp: Date.now() });
    const job = jobs.get(jobId);
    if (!job) return { status: 'not_found' };
    job.pollCount += 1;
    if (job.pollCount >= pollsBeforeReady) {
      job.status = 'ready';
      job.url = `https://fake-higgsfield.local/job/${jobId}.png`;
    }
    return { status: job.status, url: job.url };
  }

  // Cloud + FNF surface
  async function upload(...args) {
    calls.push({ method: 'upload', args, timestamp: Date.now() });
    const fail = maybeFail('upload');
    if (fail) return fail;
    return { url: `https://fake-higgsfield.local/upload/${rid('asset')}.png` };
  }

  function reset() {
    calls.length = 0;
    jobs.clear();
    counter = 0;
  }

  return {
    trainSoul,
    generateImage,
    generateVideo,
    generateProductPhoto,
    getJobStatus,
    upload,
    calls,
    jobs,
    reset,
  };
}

module.exports = { createFakeHiggsfield };
